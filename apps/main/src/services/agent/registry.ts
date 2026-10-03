/** Agent 注册表与能力探测 —— 规划书 §4.5 / FR-2.6。 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createId } from '@logicreader/shared'
import { logMain } from '../../util/ipc'
import { paths } from '../../util/paths'
import { storeService } from '../store.service'
import { readVersion, resolveAgentExecutable } from './exec'
import { settingsService } from '../settings.service'
import { MockAdapter } from './mock'
import { SdkAdapter } from './sdk'
import { CLI_SPECS, CliSession, cliLaunchPrefix } from './cli'
import { CodexAdapter } from './codex'
import { buildModelConfigOptions } from './model-view'
import { DEEPSEEK_API_KEY_ENV, mergeAgentEnv } from './env'
// 兜底模型清单位于 fallback-models.ts（那里不依赖 electron，单测可直接钉住 dsh 的目录）
import { FALLBACK_MODELS } from './fallback-models'
import type { AgentAdapter, AgentCapability, AgentKind, AgentRegistration, AgentSessionHandle, AgentEvent, PromptInput, SessionOptions, ConfigOption, ModelOption } from './types'

/** 内置定义：三家主力 Agent + Gemini + 离线 Mock。 */
export const BUILTIN_DEFINITIONS: AgentRegistration[] = [
  {
    id: 'claude-code',
    kind: 'claude-code',
    displayName: 'Claude Code',
    // 官方 SDK 通道（与 VS Code 扩展同一条路）；SDK 不可用时探测会回落到 CLI
    protocol: 'sdk',
    executable: 'claude',
    args: [],
    env: {},
    enabled: true,
    builtin: true
  },
  {
    id: 'codex',
    kind: 'codex',
    displayName: 'Codex CLI',
    // 官方 app-server 通道（与 Codex VS Code 扩展同一条路）；老版本 CLI 会在探测时回落到 'cli'
    protocol: 'app-server',
    executable: 'codex',
    args: [],
    env: {},
    enabled: true,
    builtin: true
  },
  {
    id: 'dsh',
    kind: 'dsh',
    displayName: 'DeepSeek Harness',
    protocol: 'acp',
    executable: 'dsh',
    args: ['--profile', 'acp'],
    env: {},
    enabled: true,
    builtin: true
  },
  {
    id: 'gemini',
    kind: 'gemini',
    displayName: 'Gemini CLI',
    protocol: 'cli',
    executable: 'gemini',
    args: ['--experimental-acp'],
    env: {},
    enabled: true,
    builtin: true
  },
  {
    id: 'mock',
    kind: 'custom',
    displayName: 'Mock Agent（离线演示）',
    protocol: 'mock',
    executable: null,
    args: [],
    env: {},
    enabled: true,
    builtin: true
  }
]

export class AgentRegistry {
  private registrations = new Map<string, AgentRegistration>()
  private capabilities = new Map<string, AgentCapability>()

  init(): void {
    for (const definition of BUILTIN_DEFINITIONS) this.registrations.set(definition.id, { ...definition })
    // 数据库中的用户配置覆盖内置定义
    try {
      const rows = storeService.agentList() as Record<string, unknown>[]
      for (const row of rows) {
        const id = String(row.id ?? '')
        if (!id) continue
        const args = parseJson<string[]>(row.args_json, [])
        const existing = this.registrations.get(id)
        const kind = (String(row.kind ?? existing?.kind ?? 'custom') as AgentKind) ?? 'custom'
        /**
         * **协议不允许被历史数据覆盖**。
         *
         * 实测踩到的坑：老版本把 Claude Code 存成 `protocol: 'cli'`，这条记录在启动时覆盖内置定义，
         * 于是新版本里"改走官方 SDK 通道"的改动**永远不会生效** —— 表现就是
         * 日志里一直写 `Agent 能力探测完成：claude-code=2.1.142 (Claude Code)`，
         * 模型清单永远是兜底列表（用户反馈的"看不到具体模型名称"）。
         *
         * 规则：内置 Agent 的协议以内置定义为准；只有**用户自建**的 Agent 才允许自定义协议。
         */
        const builtinProtocol = existing?.builtin ? existing.protocol : null
        const storedProtocol = (String(row.protocol ?? 'cli') as AgentRegistration['protocol']) ?? 'cli'
        const protocol = builtinProtocol ?? storedProtocol
        if (builtinProtocol && builtinProtocol !== storedProtocol) {
          logMain(
            'warn',
            'agent',
            '忽略历史注册表里的协议（' + id + '：库=' + storedProtocol + ' → 内置=' + builtinProtocol + '）'
          )
        }
        this.registrations.set(id, {
          id,
          kind,
          displayName: String(row.display_name ?? existing?.displayName ?? id),
          protocol,
          executable: row.executable == null ? null : String(row.executable),
          args,
          env: parseJson<Record<string, string>>(row.env_json, {}),
          enabled: Number(row.enabled ?? 1) === 1,
          builtin: existing?.builtin ?? false
        })
        /**
         * 同理：**协议变了就不能再用库里缓存的能力信息**。
         * 那份缓存是按旧协议探测出来的（version/executable/models 全是 CLI 通道的），
         * 继续用会让 `probe()` 直接命中缓存、跳过重新探测。
         */
        const capability = parseJson<AgentCapability | null>(row.capability_json, null)
        if (capability && capability.protocol === protocol) {
          this.capabilities.set(id, capability)
        } else if (capability) {
          logMain('info', 'agent', '丢弃过期的能力缓存（' + id + '：缓存协议=' + String(capability.protocol) + '，当前=' + protocol + '）')
        }
      }
    } catch (error) {
      logMain('warn', 'agent', '读取 Agent 注册表失败', String(error))
    }
  }

  list(): AgentRegistration[] {
    return [...this.registrations.values()].map((registration) => ({
      ...registration,
      capability: this.capabilities.get(registration.id) ?? null
    }))
  }

  get(id: string): AgentRegistration | null {
    return this.registrations.get(id) ?? null
  }

  capability(id: string): AgentCapability | null {
    return this.capabilities.get(id) ?? null
  }

  capabilitiesList(): AgentCapability[] {
    return [...this.capabilities.values()]
  }

  upsert(registration: AgentRegistration): void {
    const existing = this.registrations.get(registration.id)
    const next: AgentRegistration = {
      ...registration,
      id: registration.id || createId('agent'),
      builtin: existing?.builtin ?? false
    }
    this.registrations.set(next.id, next)
    storeService.agentUpsert({
      id: next.id,
      kind: next.kind,
      displayName: next.displayName,
      protocol: next.protocol,
      executable: next.executable,
      args: next.args,
      env: next.env,
      enabled: next.enabled,
      capability: this.capabilities.get(next.id) ?? null,
      lastProbeAt: this.capabilities.get(next.id)?.probedAt ?? 0
    })
  }

  remove(id: string): void {
    const existing = this.registrations.get(id)
    if (!existing || existing.builtin) return
    this.registrations.delete(id)
    this.capabilities.delete(id)
  }

  /**
   * 解析 Agent 的工作目录。
   * 默认使用文档所在目录（这样"读文档"类问题与工具调用都能正常工作）；
   * 用户可在设置中切换为隔离影子目录（规划书 §5.4 安全约束 / §14 待确认项 1）。
   */
  defaultWorkdir(documentDir?: string | null): string {
    const mode = settingsService.all().agent.workspaceMode
    if (mode === 'isolated' || !documentDir || !existsSync(documentDir)) return paths.agentWorkspace()
    return documentDir
  }

  /**
   * 该 Agent 子进程要带的环境变量（内置默认 + 用户配置，`secret:` 引用走密钥库）。
   *
   * 会话（CLI / ACP / 探测用的 `--version`）都从这里取，保证"设置里填的密钥"
   * 与"真正传给子进程的密钥"同源 —— 之前 `agents.env_json` 是**只落库、不生效**的。
   */
  resolveEnv(id: string): Record<string, string> {
    const registration = this.registrations.get(id)
    if (!registration) return {}
    const getSecret = (key: string): string | null => settingsService.getSecret(key)
    // shim 自己声明的启动环境（如 ELECTRON_RUN_AS_NODE）放在最前：它属于"怎么启动"，
    // 但用户仍然可以在 Agent 的 env 里显式覆盖（例如换成另一个 Node）。
    return { ...(this.capabilities.get(id)?.launchEnv ?? {}), ...mergeAgentEnv(registration.kind, registration.env, getSecret) }
  }

  /** 该 Agent 是否已经拿到密钥（只对需要密钥的 Agent 有意义，用于界面提示）。 */
  hasCredentials(id: string): boolean | null {
    const registration = this.registrations.get(id)
    if (!registration) return null
    if (registration.kind !== 'dsh') return null
    return Object.prototype.hasOwnProperty.call(this.resolveEnv(id), DEEPSEEK_API_KEY_ENV)
  }

  async probe(id: string, force = false): Promise<AgentCapability> {
    const registration = this.registrations.get(id)
    if (!registration) throw new Error('未知的 Agent：' + id)
    const cached = this.capabilities.get(id)
    if (cached && !force && cacheUsable(cached)) return cached

    if (registration.protocol === 'mock') {
      const adapter = new MockAdapter(id)
      const capability = await adapter.probe()
      this.capabilities.set(id, { ...capability, builtin: registration.builtin })
      this.persistCapability(id)
      return this.capabilities.get(id) as AgentCapability
    }

    /**
     * Claude Code 走**官方 SDK 通道**（与 VS Code 扩展同一条路）：
     * 不要求 PATH 里有裸命令，也不依赖用户手动配置 —— SDK 自带原生 CLI。
     * 只有 SDK 真的不可用（没装 / 被 --omit=optional 裁掉）时才回落到 CLI 探测。
     */
    if (registration.kind === 'claude-code') {
      const { SdkAdapter } = await import('./sdk')
      const capability = await new SdkAdapter({
        id,
        displayName: registration.displayName,
        executable: registration.executable
      }).probe()
      if (capability.available) {
        this.capabilities.set(id, { ...capability, builtin: registration.builtin })
        this.persistCapability(id)
        return this.capabilities.get(id) as AgentCapability
      }
      logMain('warn', 'agent', 'SDK 通道不可用，回落 CLI 探测：' + String(capability.error))
    }

    /**
     * Codex 走**官方 app-server 通道**（`codex app-server`，与 Codex VS Code 扩展同一条路）：
     * 常驻进程 + JSON-RPC 控制通道，能切模型 / 思考强度、中断回合、审批往返、列历史线程。
     * 只有 app-server 真的起不来（CLI 太老 / 没有该子命令）时才回落到一次性 CLI。
     */
    if (registration.kind === 'codex') {
      const capability = await new CodexAdapter({
        id,
        displayName: registration.displayName,
        executable: registration.executable,
        args: registration.args
      }).probe()
      if (capability.available) {
        this.capabilities.set(id, { ...capability, builtin: registration.builtin })
        this.persistCapability(id)
        logMain('info', 'agent', '探测完成（app-server）：' + registration.displayName + ' ' + String(capability.version ?? ''))
        return this.capabilities.get(id) as AgentCapability
      }
      logMain('warn', 'agent', 'Codex app-server 通道不可用，回落 CLI：' + String(capability.error))
    }

    const resolved = await resolveAgentExecutable(registration.executable ?? id, registration.executable)
    /**
     * 回落到 CLI 时**协议必须跟着改**：能力缓存按协议比对（见 init() 里的说明），
     * 若这里仍写 'app-server'，`createAdapter()` 会去建一个起不来的 app-server 会话。
     */
    const effectiveProtocol: AgentRegistration['protocol'] =
      registration.protocol === 'app-server' ? 'cli' : registration.protocol
    if (!resolved.command) {
      const capability: AgentCapability = {
        id,
        kind: registration.kind,
        displayName: registration.displayName,
        protocol: effectiveProtocol,
        available: false,
        version: null,
        executable: null,
        launchArgs: [],
        launchEnv: {},
        supportsAcp: false,
        supportsSdk: false,
        supportsResume: false,
        supportsStreaming: false,
        supportsModel: false,
        supportsThoughtLevel: false,
        supportsPermissionModeSwitch: false,
        models: [],
        configOptions: [],
        defaultModel: null,
        defaultThoughtLevel: null,
        error: resolved.error
          ? resolved.error + unavailableHint(registration.kind)
          : '不可用' + unavailableHint(registration.kind),
        probedAt: Date.now(),
        builtin: registration.builtin
      }
      this.capabilities.set(id, capability)
      this.persistCapability(id)
      return capability
    }

    /**
     * 探测这一趟要带的环境变量：内置/用户配置（`resolveEnv`）**加上 shim 自己声明的启动环境**。
     *
     * 后者必须在这里显式并进来：`resolveEnv` 会读"已缓存的能力"里的 `launchEnv`，而**首次探测时
     * 那份能力还不存在** —— 少了 `ELECTRON_RUN_AS_NODE=1`，dsh 桌面端那个 exe 会当 GUI 程序启动，
     * `--version` 一个字节都不输出（实测：启动时 `dsh=` 空白，手动"重新探测"又变成 0.2.0-rc.2，
     * 就是这个原因）。会话路径不受影响 —— 那时能力已经缓存，`resolveEnv` 自然带上了。
     */
    const env = { ...this.resolveEnv(id), ...resolved.env }
    const version = await readVersion(resolved.command, [...resolved.prefixArgs, '--version'], process.cwd(), env)
    const models = FALLBACK_MODELS[registration.kind] ?? FALLBACK_MODELS.custom
    const isAcp = registration.protocol === 'acp'
    const capability: AgentCapability = {
      id,
      kind: registration.kind,
      displayName: registration.displayName,
      protocol: effectiveProtocol,
      available: true,
      version,
      executable: resolved.command,
      launchArgs: [...resolved.prefixArgs, ...registration.args],
      // shim 里写死的启动环境（dsh 桌面端的 ELECTRON_RUN_AS_NODE 就走这里）
      launchEnv: resolved.env,
      supportsAcp: isAcp,
      supportsSdk: false,
      supportsPermissionModeSwitch: false,
      supportsResume: registration.kind === 'claude-code' || registration.kind === 'dsh',
      supportsStreaming: true,
      supportsModel: models.length > 0,
      supportsThoughtLevel: models.some((model) => (model.thoughtLevels?.length ?? 0) > 0),
      models,
      configOptions: buildFallbackConfigOptions(models),
      defaultModel: models[0]?.id ?? null,
      defaultThoughtLevel: models[0]?.defaultThoughtLevel ?? null,
      error: null,
      probedAt: Date.now(),
      builtin: registration.builtin
    }
    this.capabilities.set(id, capability)
    this.persistCapability(id)
    logMain('info', 'agent', '探测完成：' + registration.displayName + ' ' + String(version ?? ''))
    return capability
  }

  async probeAll(force = false): Promise<AgentCapability[]> {
    const out: AgentCapability[] = []
    for (const registration of this.registrations.values()) {
      try {
        out.push(await this.probe(registration.id, force))
      } catch (error) {
        logMain('warn', 'agent', '探测失败：' + registration.id, String(error))
      }
    }
    return out
  }

  private persistCapability(id: string): void {
    const registration = this.registrations.get(id)
    const capability = this.capabilities.get(id)
    if (!registration || !capability) return
    storeService.agentUpsert({
      id,
      kind: registration.kind,
      displayName: registration.displayName,
      protocol: registration.protocol,
      executable: registration.executable,
      args: registration.args,
      env: registration.env,
      enabled: registration.enabled,
      capability,
      lastProbeAt: capability.probedAt
    })
  }

  /** 依据注册信息构造适配器。 */
  createAdapter(id: string): AgentAdapter {
    const registration = this.registrations.get(id)
    if (!registration) throw new Error('未知的 Agent：' + id)
    if (registration.protocol === 'mock') return new MockAdapter(id)
    if (registration.kind === 'claude-code' && this.capabilities.get(id)?.protocol === 'sdk') {
      // 权限回调由运行时在会话创建时注入，这里只给"还不可用"的默认值
      return new SdkAdapter({ id, displayName: registration.displayName, executable: registration.executable })
    }
    if (registration.kind === 'codex' && this.capabilities.get(id)?.protocol === 'app-server') {
      // 审批回调同样由运行时在会话创建时注入（options.requestPermission）
      return new CodexAdapter({
        id,
        displayName: registration.displayName,
        executable: registration.executable,
        args: registration.args
      })
    }
    return new CliOrAcpAdapter(this, registration)
  }
}

function buildFallbackConfigOptions(models: ModelOption[]): ConfigOption[] {
  // 与 app-server / SDK 两条探测路径共用同一份组装（model-view.ts），避免选择器少一档
  return buildModelConfigOptions(models)
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/**
 * "探测失败"的结论只缓存这么久，过期就重新探测。
 *
 * 为什么必须要这条：能力缓存是按协议持久化的（`agents.capability_json`），
 * 而"未找到可执行文件"是个**会过期的结论** —— 用户完全可能刚把这个工具装上。
 * 本轮实况：库里那条 16:38 的 dsh 缓存写着 `未找到可执行文件：dsh`，
 * 于是**新版也不再探测它**，界面上永远看不到 DeepSeek Harness。
 * 成功的结论不受影响（一直复用，要刷新就点"重新探测"）。
 */
const UNAVAILABLE_RETRY_MS = 60 * 1000

function cacheUsable(capability: AgentCapability): boolean {
  if (capability.available) return true
  return Date.now() - capability.probedAt < UNAVAILABLE_RETRY_MS
}

/**
 * "探测不到可执行文件"时的补充提示。
 * 只说**怎么做**，不猜用户机器上装了什么 —— 提示要能直接照着做。
 */
function unavailableHint(kind: AgentKind): string {
  if (kind === 'dsh') {
    return '。安装：npm i -g @deepseek-ai/dsh（装好后本程序会自动探测；也可在 Agent 管理器里手动指定可执行文件路径）'
  }
  return ''
}

/** CLI / ACP 统一适配器：优先 ACP，失败或未配置时回退 CLI。 */
class CliOrAcpAdapter implements AgentAdapter {
  readonly kind: AgentKind
  readonly protocol: AgentRegistration['protocol']

  constructor(
    private readonly registry: AgentRegistry,
    private readonly registration: AgentRegistration
  ) {
    this.id = registration.id
    this.kind = registration.kind
    this.protocol = registration.protocol
  }

  readonly id: string

  async probe(): Promise<AgentCapability> {
    return this.registry.probe(this.registration.id, true)
  }

  /**
   * 启动 CLI 会话。
   * ACP 会话由 AgentRuntime 直接创建（需要会话 id 才能做权限往返），
   * 这里只负责 CLI 与兜底路径。
   */
  async start(options: SessionOptions, onEvent: (event: AgentEvent) => void): Promise<AgentSessionHandle> {
    const capability = this.registry.capability(this.registration.id) ?? (await this.registry.probe(this.registration.id))
    if (!capability.available || !capability.executable) {
      throw new Error(capability.error ?? 'Agent 不可用')
    }
    const spec = CLI_SPECS[this.registration.kind] ?? CLI_SPECS.dsh
    /**
     * 回落到 CLI 时要把"注册表里给 ACP 用的参数"摘掉：`dsh` 的内置参数是
     * `--profile acp`，而 CLI spec 会自己选 `--profile headless`，两个叠在一起 dsh
     * 启动器直接报 `select a profile only once`（详见 cli.ts 的 cliLaunchPrefix）。
     */
    const prefixArgs = cliLaunchPrefix(capability.launchArgs, this.registration.args)
    const sessionOptions: SessionOptions = { ...options, env: { ...this.registry.resolveEnv(this.registration.id), ...(options.env ?? {}) } }
    return new CliSession(sessionOptions.sessionId ?? createId('sess'), capability.executable, prefixArgs, spec, sessionOptions, onEvent)
  }
}

export const agentRegistry = new AgentRegistry()

export function shadowWorkspaceExists(): boolean {
  return existsSync(join(paths.agentWorkspace(), '.'))
}
