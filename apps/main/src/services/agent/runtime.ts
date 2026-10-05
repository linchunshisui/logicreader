/** Agent 运行时：会话生命周期、事件总线、权限往返 —— 规划书 §5.4。 */
import {
  createId,
  decidePermission,
  isPermissionMode,
  normalizePermissionMode,
  permissionControlsOf,
  policyFromControls,
  type PermissionMode
} from '@logicreader/shared'
import { logMain } from '../../util/ipc'
import { agentRegistry } from './registry'
import { SdkAdapter, asSdkHandle, toPermissionDetail, type SdkCanUseTool } from './sdk'
import { asCodexHandle, type CodexCapableHandle } from './codex'
import { fullLaunchArgs } from './cli'
import { mapSdkModel, type ModelView } from './model-view'
import { cleanSessionTitle, isInternalSession, resolveSessionTitle, shortSessionId } from './session-title'
import { indexDshSessionLogs, readDshSessionHint } from './dsh-session-log'
import { describeEnvNames } from './env'

/**
 * ACP 启动参数：**解释器前缀 + 注册参数**。
 *
 * 旧实现只取注册参数（`--profile acp`），于是"自带入口脚本"的 Agent（dsh 桌面端那种
 * `.cmd` shim 解析成 `<exe> --expose-internals <cli.js>`）会被拉成 `<exe> --profile acp` ——
 * 少了入口脚本，会话永远建不起来。见 cli.ts 的 fullLaunchArgs。
 */
function registrationArgs(agentId: string, capability: AgentCapability): string[] {
  const registration = agentRegistry.get(agentId)
  const args = registration?.args ?? []
  return fullLaunchArgs(capability.launchArgs, args)
}

import { fsService } from '../fs.service'
import { settingsService } from '../settings.service'
import { storeService } from '../store.service'
import type { AgentCapability, AgentEvent, AgentSessionHandle, PermissionDetail, PromptInput, SessionOptions } from './types'

export interface CreateSessionRequest {
  agentId: string
  contextMode: 'fulltext' | 'graph'
  modelId?: string | null
  thinkingEffort?: string | null
  resumeSessionId?: string | null
  /** 文档所在目录（仅用于提示，实际工作目录默认是影子目录） */
  documentDir?: string | null
  /** 授权模式：决定写文件 / 执行命令是自动放行还是逐次询问（默认 manual） */
  permissionMode?: PermissionMode | null
  /** 该通道自己那些档位的值（Codex 的 approvalPolicy / sandbox），原样交给适配器 */
  configValues?: Record<string, string>
  /** 分叉已有会话（复制历史，原会话不动） */
  forkSession?: boolean | null
  /** 从某个用户消息处开始（配合 fork） */
  resumeSessionAt?: string | null
  /** 关掉全部内置工具（一次性任务用：图谱抽取只要一段 JSON 正文） */
  disableTools?: boolean
  /** 没有人守着这个会话：权限请求直接拒绝，不弹卡片也不等人 */
  headless?: boolean
}

export interface RuntimeSession {
  sessionId: string
  agentId: string
  capability: AgentCapability
  handle: AgentSessionHandle
  contextMode: 'fulltext' | 'graph'
  configOptions: unknown[]
  createdAt: number
  /**
   * 授权模式与它推导出的两个能力位。
   * 两者都缓存在会话上：权限往返（requestPermission / fs/write_text_file）
   * 拿不到渲染进程的实时状态，必须与会话创建时保持一致。
   */
  permissionMode: PermissionMode
  workspaceDir: string
  canWrite: boolean
  canExecute: boolean
  /** SDK 通道的额外能力（模型清单 / 斜杠命令 / 上下文用量 / 文件回退），非 SDK 会话为 null */
  sdk: ReturnType<typeof asSdkHandle>
  /** Codex app-server 通道的额外能力（模型清单 / 技能清单 / 当前模型），非该通道为 null */
  appServer: CodexCapableHandle | null
  /** 已经写过的"始终允许"规则（SDK 的 updatedPermissions），按会话累积 */
  persistedRules: unknown[]
  /** 一次性任务（runOnce）：权限请求一律即时拒绝 —— 没有人能来回答卡片 */
  headless: boolean
}

interface PendingPermission {
  resolve: (optionId: string | null) => void
  timer: NodeJS.Timeout
}

export class AgentRuntime {
  private sessions = new Map<string, RuntimeSession>()
  private permissions = new Map<string, PendingPermission>()
  private emitter: ((sessionId: string, event: AgentEvent) => void) | null = null

  setEmitter(emitter: (sessionId: string, event: AgentEvent) => void): void {
    this.emitter = emitter
  }

  private emit(sessionId: string, event: AgentEvent): void {
    this.emitter?.(sessionId, event)
    this.collectors.get(sessionId)?.(event)
  }

  /** 当前进程里**活着的**会话（与 history 的"历史会话记录"不是一回事）。 */
  listRuntimeSessions(): { sessionId: string; agentId: string; contextMode: string; createdAt: number }[] {
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.sessionId,
      agentId: session.agentId,
      contextMode: session.contextMode,
      createdAt: session.createdAt
    }))
  }

  /**
   * "当前工作目录"——会话用的那一份（`@ 文件引用` 与权限判定都以它为准）。
   * 与 `createSession` 走同一个解析函数，避免"界面按 A 目录列文件、Agent 按 B 目录读写"。
   */
  workdirFor(documentDir: string | null): string {
    return agentRegistry.defaultWorkdir(documentDir)
  }

  async createSession(request: CreateSessionRequest): Promise<{ sessionId: string; capability: AgentCapability; configOptions: unknown[]; workspaceDir: string }> {
    const capability = await agentRegistry.probe(request.agentId)
    if (!capability.available) throw new Error(capability.error ?? 'Agent 不可用')
    const adapter = agentRegistry.createAdapter(request.agentId)
    const workspaceDir = agentRegistry.defaultWorkdir(request.documentDir)
    const clientPolicy = normalizePermissionMode(request.permissionMode)
    /**
     * 用户拨的是**该通道自己的档位**（Claude 的授权模式 / Codex 的审批策略+沙箱），
     * 而下面的能力位与 `decidePermission` 只认客户端策略这一套 —— 折算交给纯函数
     * （shared/permissions.ts 的 `policyFromControls`，有单测），别把 if 散在这里。
     * 例：Codex 拨成"沙箱只读" → 折算成 plan → 写与执行两个能力位都是 false。
     */
    const configValues = request.configValues ?? {}
    const permissionMode = policyFromControls(capability.protocol, clientPolicy, configValues)
    const settings = settingsService.all()
    /**
     * 授权模式是"逐次询问"的粒度控制，**不是**越过设置的后门：
     *   - manual / plan：能力位与设置一致（默认全关，写操作连卡片都不弹就被拒）；
     *   - edit：工作区内写文件放行；执行命令仍看设置；
     *   - auto：写与执行都交给 permissions 策略做"安全检查后放行 / 风险操作转人工"。
     */
    const canWrite = permissionMode === 'edit' || permissionMode === 'auto' || settings.agent.allowWrite
    const canExecute = permissionMode === 'auto' || settings.agent.allowExecute
    const options: SessionOptions = {
      agentId: request.agentId,
      cwd: workspaceDir,
      // 密钥与环境变量：内置默认（dsh 的 DEEPSEEK_API_KEY）+ 注册表里的 env（secret: 引用走密钥库）
      env: agentRegistry.resolveEnv(request.agentId),
      modelId: request.modelId ?? capability.defaultModel,
      thinkingEffort: request.thinkingEffort ?? capability.defaultThoughtLevel,
      contextMode: request.contextMode,
      resumeSessionId: request.resumeSessionId ?? null,
      forkSession: request.forkSession === true,
      resumeSessionAt: request.resumeSessionAt ?? null,
      permissionMode,
      // 通道自己的档位原样带下去：codex 用它决定 thread/start 的 approvalPolicy / sandbox
      configOverrides: Object.keys(configValues).length > 0 ? configValues : undefined,
      disableTools: request.disableTools === true
    }
    const sessionId = createId('sess')
    options.sessionId = sessionId
    const onEvent = (event: AgentEvent): void => {
      this.emit(sessionId, event)
    }

    let handle: AgentSessionHandle | null = null
    /**
     * **首选**：官方 Claude Agent SDK。
     *
     * 它是"一次询问"的通道：`canUseTool` 只在 CLI 认为需要授权时回调，
     * 我们把决定权交给 `decidePermission`（放行 / 拒绝 / 转人工），
     * 转人工时通过统一的 permission-request 事件弹卡片——这正是早先版本缺失的一环。
     */
    if (capability.protocol === 'sdk') {
      try {
        options.canUseTool = (toolName, input, extra) =>
          this.decideSdkPermission(sessionId, permissionMode, workspaceDir, canWrite, toolName, input, extra)
        handle = await adapter.start(options, onEvent)
      } catch (error) {
        logMain('warn', 'agent', 'SDK 会话建立失败：' + String(error))
        onEvent({
          type: 'error',
          message: 'Claude Agent SDK 连接失败：' + (error instanceof Error ? error.message : String(error)),
          retryable: false
        })
        throw error
      }
    }
    /**
     * **次选**：Codex 官方 app-server。
     *
     * 与 SDK 通道同构：app-server 只在"它自己认为需要授权时"发审批请求，
     * 我们把请求翻成统一的权限卡片，交给 `requestPermission`
     * （策略自动放行 / 转人工弹卡片 / 无人值守即时拒绝），拿到 optionId 后原样回执。
     */
    if (!handle && capability.protocol === 'app-server') {
      try {
        options.requestPermission = (detail) => this.requestPermission(sessionId, detail)
        handle = await adapter.start(options, onEvent)
      } catch (error) {
        logMain('warn', 'agent', 'Codex app-server 会话建立失败：' + String(error))
        onEvent({
          type: 'error',
          message: 'Codex app-server 连接失败：' + (error instanceof Error ? error.message : String(error)),
          retryable: false
        })
        throw error
      }
    }
    if (!handle && capability.protocol === 'acp' && capability.executable) {
      try {
        const { AcpSession } = await import('./session')
        handle = await AcpSession.create({
          sessionId,
          executable: capability.executable,
          args: registrationArgs(request.agentId, capability),
          options,
          onEvent,
          allowWrite: canWrite,
          requestPermission: (detail) => this.requestPermission(sessionId, detail),
          readTextFile: (path, line, limit) => this.readTextFileForAgent(path, line, limit),
          // 带上会话 id：写文件是权限会话的**第二条通道**，不能只认全局设置
          writeTextFile: (path, content) => this.writeTextFileForAgent(path, content, sessionId)
        })
      } catch (error) {
        logMain('warn', 'agent', 'ACP 会话建立失败，回退 CLI', String(error))
        onEvent({ type: 'error', message: 'ACP 连接失败，已回退 CLI：' + (error instanceof Error ? error.message : String(error)) + acpHint(request.agentId), retryable: true })
      }
    }
    if (!handle) {
      handle = await adapter.start(options, onEvent)
    }
    const session: RuntimeSession = {
      sessionId,
      agentId: request.agentId,
      capability,
      handle,
      contextMode: request.contextMode,
      // ACP 通道在 session/new 时已经把**真实**配置项（模型 / 思考强度）拿回来了：
      // 用它，界面上的选择器就不必停在兜底目录上（dsh 的路由与档位只在这里是真的）。
      configOptions: acpConfigOptions(handle) ?? capability.configOptions,
      createdAt: Date.now(),
      permissionMode,
      workspaceDir,
      canWrite,
      canExecute,
      sdk: asSdkHandle(handle),
      appServer: asCodexHandle(handle),
      persistedRules: [],
      headless: request.headless === true
    }
    this.sessions.set(sessionId, session)
    logMain(
      'info',
      'agent',
      '会话已创建：' +
        sessionId +
        '（' +
        capability.displayName +
        ' · 授权模式=' +
        permissionMode +
        ' 写=' +
        String(canWrite) +
        ' 执行=' +
        String(canExecute) +
        ' 注入环境变量=' +
        // 只打变量名：值里可能有密钥（见 env.ts 的约定）
        describeEnvNames(options.env ?? {}) +
        '）'
    )
    return { sessionId, capability, configOptions: session.configOptions, workspaceDir }
  }

  /**
   * 一次性任务：建立会话 → 单次提问 → 收集完整文本 → 释放。
   * 关系图抽取（Map/Reduce）与布局指令翻译都走这条通道。
   */
  async runOnce(request: {
    agentId: string
    prompt: string
    modelId?: string | null
    thinkingEffort?: string | null
    /** 续聊这条远端会话再问（"总结命名"要用：ACP 没有读回放，只有续聊能带上上下文） */
    resumeSessionId?: string | null
    contextMode?: 'fulltext' | 'graph'
    documentDir?: string | null
    signal?: { cancelled: boolean }
    onDelta?: (text: string) => void
    /** 单次请求的最长等待（毫秒）；超时自动中断会话并以超时错误拒绝 */
    timeoutMs?: number
  }): Promise<{ text: string; sessionId: string }> {
    let collected = ''
    const created = await this.createSession({
      agentId: request.agentId,
      contextMode: request.contextMode ?? 'fulltext',
      modelId: request.modelId ?? null,
      thinkingEffort: request.thinkingEffort ?? null,
      resumeSessionId: request.resumeSessionId ?? null,
      documentDir: request.documentDir ?? null,
      /**
       * 一次性任务的两个"无人值守"约定（§35 实测的坑）：
       *  - `disableTools`：关掉内置工具。抽取提示词下模型会偶尔想先写文件 / 跑命令，
       *    而写与执行在 manual 档下是**转人工**的 —— 没人来点，于是一路等到分块超时（每块 3~15 分钟 × 3 轮全废）；
       *  - `headless`：万一还有别的权限请求（技能 / 计划 / 提问），直接拒绝，不等人。
       */
      disableTools: true,
      headless: true
    })
    const sessionId = created.sessionId
    let resolveDone: () => void = () => undefined
    let rejectDone: (error: Error) => void = () => undefined
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })
    this.collectors.set(sessionId, (event) => {
      if (event.type === 'text-delta') {
        collected += event.text
        request.onDelta?.(event.text)
      } else if (event.type === 'done') {
        resolveDone()
      } else if (event.type === 'error') {
        rejectDone(new Error(event.message))
      }
    })
    const timeoutMs = request.timeoutMs ?? 0
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const prompting = this.prompt(sessionId, {
        text: request.prompt,
        modelId: request.modelId ?? null,
        thinkingEffort: request.thinkingEffort ?? null
      })
      /**
       * 回合结束的判定分两层，这里是**一次性任务最容易踩的坑**：
       *   - CLI / ACP 通道的 `prompt()` 本身就等整个回合跑完（结束时发 `done`）；
       *   - SDK 通道是**流式输入**模式：`prompt()` 只是把用户消息投进流里就立刻返回，
       *     真正的结束要等 `result` 消息翻成的 `done` 事件。
       * 所以必须"等 done"，而不是"等 prompt 返回后再补等一小会儿" —— 后者在 SDK 通道上
       * 等于把整个模型的回答窗口压到几百毫秒（实测 CLI 子进程光初始化就要 ~2.8 秒、
       * 首个正文 ~9 秒），收集到的永远是空文本。
       */
      const turn = (async () => {
        await prompting
        await done
      })()
      // 超时中断 / 之后才到达的 error 都会让 turn 拒绝：提前挂兜底，避免未处理的 Promise 拒绝
      turn.catch(() => undefined)
      prompting.catch(() => undefined)
      if (timeoutMs > 0) {
        await Promise.race([
          turn,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              this.cancel(sessionId).catch(() => undefined)
              reject(new Error('分块请求超时（' + Math.round(timeoutMs / 1000) + ' 秒），已自动中断'))
            }, timeoutMs)
          })
        ])
      } else {
        await turn
      }
    } finally {
      if (timer) clearTimeout(timer)
      this.collectors.delete(sessionId)
      await this.dispose(sessionId).catch(() => undefined)
    }
    return { text: collected, sessionId }
  }

  private collectors = new Map<string, (event: AgentEvent) => void>()

  getSession(sessionId: string): RuntimeSession | null {
    return this.sessions.get(sessionId) ?? null
  }

  async prompt(sessionId: string, input: PromptInput): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在：' + sessionId)
    await session.handle.prompt(input, (event) => this.emit(sessionId, event))
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    await session.handle.cancel()
    /**
     * 取消把连接杀掉的情况（ACP 强杀兜底）：把死句柄从会话表摘掉，
     * 否则下一句提问还打在它上面 —— 用户看到的就是"停止之后 Agent 就坏了"。
     * 渲染端的会话 id 会自然失效，下一次 send 走"新建会话"路径。
     */
    if (session.handle.isUsable?.() === false) {
      this.sessions.delete(sessionId)
      logMain('info', 'agent', '会话在取消中被终止，已从会话表摘除：' + sessionId)
    }
  }

  async dispose(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    await session.handle.dispose()
    this.sessions.delete(sessionId)
  }

  /**
   * 会话真实可用的模型清单（只有 SDK 通道给得出）。
   * 用户把 Claude Code 指向第三方代理时，模型名是 GLM-5.3 / Kimi-K3 这种别名 ——
   * 兜底清单里的 opus/sonnet 只是档位名，不刷新就会看着像"模型选错了"。
   */
  async models(sessionId: string): Promise<ModelView[]> {
    const session = this.sessions.get(sessionId)
    if (session?.sdk?.supportedModels) {
      try {
        const list = await session.sdk.supportedModels()
        logMain('debug', 'agent', '模型清单原始条目=' + list.length + ' 解析后=' + list.filter((item) => item.resolvedModel).length)
        return list.map(mapSdkModel).filter((item) => item.id.length > 0)
      } catch (error) {
        logMain('warn', 'agent', '取模型清单失败：' + String(error))
        return []
      }
    }
    if (session?.appServer?.models) {
      try {
        const list = await session.appServer.models()
        logMain('debug', 'agent', '模型清单（app-server）=' + list.length + ' 条')
        return list
      } catch (error) {
        logMain('warn', 'agent', '取模型清单失败（app-server）：' + String(error))
        return []
      }
    }
    /**
     * ACP 通道**没有**"随时问一次模型清单"的方法：它的模型/思考强度来自 `session/new`
     * 的 configOptions，会话创建时就已经交给界面了（见 createSession）。这里不是错误，
     * 所以不写 warn —— 否则每建一个 ACP 会话都会在日志里留一条吓人的"没有模型清单能力"。
     */
    if (session?.capability.protocol === 'acp') {
      logMain('debug', 'agent', 'ACP 会话的模型清单来自 session/new 的 configOptions，界面沿用会话创建时下发的那一份')
      return []
    }
    logMain('warn', 'agent', '取模型清单：该会话没有模型清单能力（sessionId=' + sessionId + '）')
    return []
  }

  /**
   * **不建常驻会话**地取一次模型清单（探测用）。
   *
   * 为什么需要它：模型清单只有 SDK 通道给得出，而 SDK 要起一个子进程才有 `supportedModels()`。
   * 界面在"还没发过消息"时也应该显示真实模型名 —— 所以这里起一个临时进程、问完就关。
   * 实测代价约 2-4 秒（复用同一个 CLI 二进制），比让用户先发一条消息再看到模型名划算。
   */
  async probeModels(agentId: string): Promise<ModelView[]> {
    const capability = await agentRegistry.probe(agentId)
    /**
     * app-server 的模型清单在探测阶段就已经是**真实清单**（`model/list`），
     * 不必像 SDK 那样再起一个临时会话 —— 直接复用，省 2~4 秒。
     */
    if (capability.protocol === 'app-server') {
      return capability.models.map((model) => ({
        id: model.id,
        name: model.name,
        description: model.description,
        supportsEffort: (model.thoughtLevels?.length ?? 0) > 0,
        effortLevels: model.thoughtLevels?.map((level) => level.id),
        thoughtLevels: model.thoughtLevels
      }))
    }
    if (capability.protocol !== 'sdk') return []
    const adapter = agentRegistry.createAdapter(agentId)
    let handle: AgentSessionHandle | null = null
    try {
      const ctx = createId('probe')
      handle = await adapter.start(
        {
          sessionId: ctx,
          agentId,
          cwd: agentRegistry.defaultWorkdir(null),
          contextMode: 'fulltext',
          permissionMode: 'manual'
        },
        () => undefined
      )
      const sdk = asSdkHandle(handle)
      if (!sdk?.supportedModels) return []
      // 等 CLI 初始化完再问；过早问会拿到空清单
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const list = await sdk.supportedModels().catch(() => [])
        if (list.length > 0) {
          logMain('info', 'agent', '模型清单（探测）=' + list.length + ' 条，带真实模型名 ' + list.filter((item) => item.resolvedModel).length + ' 条')
          return list.map(mapSdkModel).filter((item) => item.id.length > 0)
        }
        await new Promise((resolve) => setTimeout(resolve, 500 + attempt * 250))
      }
      return []
    } catch (error) {
      logMain('warn', 'agent', '探测模型清单失败：' + String(error))
      return []
    } finally {
      await handle?.dispose().catch(() => undefined)
    }
  }

  /** 该会话当前真正在跑的模型（别名已解析）；拿不到返回 null。 */
  activeModel(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)
    return session?.sdk?.activeModel?.() ?? session?.appServer?.activeModel?.() ?? null
  }

  /**
   * 会话的**上下文窗口占用**（拉取式；事件路径见 ACP 的 usage_update → context-usage）。
   * 只有 SDK 通道有"随时问一次"的方法（`getContextUsage`，与 /context 命令同源）；
   * 其它通道返回 null，界面沿用事件带来的最后已知值。
   */
  async contextUsage(sessionId: string): Promise<{ used: number; size: number | null } | null> {
    const session = this.sessions.get(sessionId)
    if (!session?.sdk?.contextUsage) return null
    try {
      const raw = (await session.sdk.contextUsage()) as { totalTokens?: number; maxTokens?: number } | undefined
      const used = Number(raw?.totalTokens)
      if (!Number.isFinite(used) || used <= 0) return null
      const size = Number(raw?.maxTokens)
      return { used: Math.round(used), size: Number.isFinite(size) && size > 0 ? Math.round(size) : null }
    } catch (error) {
      logMain('debug', 'agent', '取上下文用量失败：' + String(error))
      return null
    }
  }

  /**
   * 把文件回退到某个检查点（用户消息）之前的状态。
   * 只有 SDK 通道支持（`enableFileCheckpointing` + `rewindFiles`）。
   * `dryRun` 用来先让用户看到"会改哪些文件、增删多少行"，再决定是否真的回退。
   */
  async rewind(sessionId: string, userMessageId: string, dryRun = false): Promise<unknown> {
    const session = this.sessions.get(sessionId)
    if (!session?.sdk?.rewindFiles) throw new Error('当前会话不支持文件回退（仅官方 SDK 通道支持）')
    const result = await session.sdk.rewindFiles(userMessageId, { dryRun })
    logMain('info', 'agent', (dryRun ? '预演' : '执行') + '文件回退到检查点 ' + userMessageId + '：' + JSON.stringify(result).slice(0, 300))
    return result
  }

  /**
   * 会话可用的斜杠命令（含用户自己的技能）。
   * 只对 SDK 通道有意义：这些命令由 CLI 下发，界面不该硬编码一份。
   */
  async commands(sessionId: string): Promise<{ name: string; description?: string; argumentHint?: string }[]> {
    const session = this.sessions.get(sessionId)
    if (session?.sdk?.commands) {
      try {
        return await session.sdk.commands()
      } catch (error) {
        logMain('warn', 'agent', '取斜杠命令失败：' + String(error))
        return []
      }
    }
    if (session?.appServer?.commands) {
      try {
        return await session.appServer.commands()
      } catch (error) {
        logMain('warn', 'agent', '取技能清单失败：' + String(error))
        return []
      }
    }
    return []
  }

  /**
   * 列某个工作目录下的历史会话（最近优先）。
   * 数据源是 CLI 自己持久化的会话记录，与 VS Code 扩展共用 —— 用户在哪边聊过都能续。
   */  async listSessions(dir: string | null, limit = 30, agentId: string | null = null): Promise<unknown[]> {
    const target = dir ?? process.cwd()
    /**
     * 历史会话按**当前选中 Agent 的通道**取：
     *  - Codex：`thread/list`（与 VS Code 扩展共用同一份 rollout 记录）；
     *  - 其余：CLI 自己持久化的会话记录（Claude 那套）。
     */
    if (agentId) {
      const registration = agentRegistry.get(agentId)
      const capability = agentRegistry.capability(agentId)
      if (registration?.kind === 'codex' && capability?.protocol === 'app-server') {
        const { listCodexSessionsFor } = await import('./codex')
        const rows = await listCodexSessionsFor({
          executable: registration.executable,
          extraArgs: registration.args,
          cwd: target,
          limit
        })
        return this.withSessionTitles(agentId, rows)
      }
      /**
       * ACP 通道（dsh 的 `--profile acp`）自己持久化会话，并且从 0.2 起实现了
       * `session/list` —— 拿得到就把它当"历史会话"来源，续聊才有东西可选。
       * 拿不到（老版本 / 别的 ACP 工具没实现）就安静地落回 CLI 会话记录。
       */
      if (capability?.protocol === 'acp' && capability.executable && capability.supportsResume) {
        const { listAcpSessions } = await import('./acp')
        const rows = await listAcpSessions({
          executable: capability.executable,
          args: capability.launchArgs,
          cwd: target,
          env: agentRegistry.resolveEnv(agentId),
          limit,
          /**
           * 给足时间：这一趟要**新起一个 ACP 进程**（面板里往往已经有一个在跑），
           * 冷启动 + profile 载入实测能到十几秒，15 秒会偶发超时。
           */
          timeoutMs: 30_000
        })
        if (rows.length > 0) {
          return this.withSessionTitles(
            agentId,
            rows.map((row) => ({
            sessionId: row.sessionId,
              summary: row.title ?? undefined,
              customTitle: row.title ?? undefined,
            cwd: row.cwd,
            lastModified: row.updatedAt ? Date.parse(row.updatedAt) : undefined
            }))
          )
        }
        /**
         * ACP 通道拿不到就**到此为止**，不要再落回 Claude 的会话记录。
         *
         * 实测踩到：dsh 这条 ACP 列表偶发失败时，落回 SDK 的 `listSessions` 会把
         * **另一个工具（Claude Code）的会话**列在 dsh 名下 —— 用户看到一堆
         * "你是严谨的文档逻辑结构抽取器…"，完全对不上。宁可空着说"还没有历史会话"。
         */
        return []
      }
    }
    const { listSessionsFor } = await import('./sdk')
    const rows = await listSessionsFor(target, limit)
    return this.withSessionTitles(agentId, rows)
  }

  /**
   * 读一个历史会话的**全部对话**（历史会话列表点开时的回放数据源）。
   * 各通道的能力差异很大：
   *  - SDK（Claude Code）：官方 `getSessionMessages()`（与本机 JSONL 同源）；
   *  - ACP（dsh）：ACP 协议没有"读回放"，但 dsh 自己的**会话日志**在磁盘上（多帧 zstd JSONL），
   *    直接解它 —— 与"总结命名读标题"是同一套数据，只是这次读整份；
   *  - Codex（app-server）：rollout 记录无公开读取 API —— 返回空，界面显示"该通道暂不支持回放"，
   *    续聊本身仍然可用（下一轮会带上历史）。
   */
  async sessionTranscript(agentId: string | null, sessionId: string, cwd: string | null): Promise<{ role: 'user' | 'assistant'; text: string; thinking: string; at: number }[]> {
    const registration = agentId ? agentRegistry.get(agentId) : null
    const capability = agentId ? agentRegistry.capability(agentId) : null
    if (registration?.kind === 'dsh' || capability?.protocol === 'acp') {
      // dsh 的会话 id 在列表里可能带 session- 前缀，日志目录两种形态都有 —— readDshSessionTranscript 自己兜
      const { readDshSessionTranscript } = await import('./dsh-session-log')
      return readDshSessionTranscript(sessionId)
    }
    if (capability?.protocol === 'sdk') {
      const { readSessionTranscript } = await import('./sdk')
      return readSessionTranscript(sessionId, cwd)
    }
    return []
  }

  /**
   * 删除一个历史会话。
   * 只有 SDK 通道有官方删除 API（`deleteSession`：删本机 JSONL 与子代理记录目录）；
   * dsh 的会话文件是它自己的运行时资产（ACP 没有删除方法，擅自删它的磁盘文件风险大于收益），
   * Codex 没有删除 API —— 这两个通道返回 false，界面给"该通道暂不支持删除"。
   */
  async deleteHistorySession(agentId: string | null, sessionId: string, cwd: string | null): Promise<boolean> {
    const capability = agentId ? agentRegistry.capability(agentId) : null
    if (capability?.protocol === 'sdk') {
      const { deleteSdkSession } = await import('./sdk')
      return deleteSdkSession(sessionId, cwd)
    }
    logMain('info', 'agent', '该通道不支持删除历史会话（' + (capability?.protocol ?? 'unknown') + '）：' + sessionId)
    return false
  }

  /**
   * 给历史会话补一个**人能看懂的名字**（用户的原话：应该支持总结命名）。
   *
   * 各通道的原生字段参差不齐（dsh 的 `session/list` 只给 sessionId + cwd），
   * 所以这里统一走 `resolveSessionTitle`：我们自己存的名字 → Agent 给的名字 →
   * 我们自己记的"首条提问" → Agent 给的首条提问；全都没有就留空，
   * 由界面显示"未命名会话 + 短 id"（`shortSessionId`），而不是把整串 UUID 摆出来。
   */
  private withSessionTitles(agentId: string | null, rows: unknown[]): unknown[] {
    let hidden = 0
    /**
     * dsh 的会话日志索引（只建一次）：ACP 的 `session/list` 不给标题，
     * 但 dsh 自己把**标题**与**第一句提问**写在 `~/.dsh/sessions/**` 的日志里
     * （见 dsh-session-log.ts）。这里用它给"没名字"的会话补默认标题 ——
     * 用户的要求就是"根据第一句提问给个默认标题"。
     */
    const dshLogs = agentId ? indexDshSessionLogs() : null
    const out = rows.map((raw) => {
      const row = raw as Record<string, unknown>
      const sessionId = String(row.sessionId ?? '')
      if (!sessionId) return raw
      /**
       * 内部任务（图谱抽取这类 `runOnce`）不算"历史会话"：CLI 会把它们也存下来，
       * 列表里塞满"你是严谨的文档逻辑结构抽取器…"对用户毫无意义。命中就不列。
       */
      if (isInternalSession(row.firstPrompt as string | undefined) || isInternalSession(row.summary as string | undefined)) {
        hidden += 1
        return null
      }
      const stored = agentId ? storeService.sessionTitleGet(agentId, sessionId) : null
      const ours = agentId ? storeService.conversationTitleForRemoteSession(agentId, sessionId) : null
      let agentTitle = (row.customTitle as string | undefined) ?? (row.summary as string | undefined)
      let firstPrompt = (row.firstPrompt as string | undefined) ?? null
      if (!stored && !agentTitle && !ours && !firstPrompt && dshLogs) {
        const file = dshLogs.get(sessionId)
        if (file) {
          const hint = readDshSessionHint(file)
          agentTitle = hint.title ?? undefined
          firstPrompt = hint.firstUserText
        }
      }
      const resolved = resolveSessionTitle({
        stored,
        agentTitle,
        ourTitle: ours,
        firstPrompt
      })
      return {
        ...row,
        title: resolved.title,
        titleSource: resolved.source,
        // 桌面端会话的 id 带 `session-` 前缀，显示时去掉（"未命名会话 · 5db998b4" 比 "session-" 可读）
        shortId: shortSessionId(sessionId.replace(/^session-/, ''))
      }
    })
    if (hidden > 0) logMain('debug', 'agent', '历史会话里滤掉内部任务 ' + hidden + ' 条（图谱抽取等 runOnce 会话）')
    return out.filter((item) => item !== null)
  }

  /**
   * 让 Agent 用一句话给某个历史会话"总结命名"（用户点一下才发生，一次很小的模型调用）。
   *
   * 实现要点：**续聊那条会话**（`resumeSessionId`）再问标题 —— 这样模型手里有那段上下文，
   * 而 ACP 通道没有"读回放"的能力（`session/load` 明确不支持），只有续聊能拿到上下文。
   * 拿不到上下文（比如会话已被清理、或该 Agent 不支持 resume）时退回"用首条提问做标题"。
   */
  async nameSession(request: { agentId: string; sessionId: string; firstPrompt?: string | null }): Promise<string | null> {
    const prompt = [
      '请用**不超过 12 个字**的中文短语概括我们之前这段对话的主题，作为会话标题。',
      '只输出标题本身：不要引号、不要标点结尾、不要解释、不要换行。'
    ].join('\n')
    try {
      const { text } = await this.runOnce({
        agentId: request.agentId,
        prompt,
        contextMode: 'fulltext',
        resumeSessionId: request.sessionId,
        timeoutMs: 90_000
      })
      const title = cleanSessionTitle(text, 24)
      if (title) {
        storeService.sessionTitleSet({ agentId: request.agentId, sessionId: request.sessionId, title, source: 'ai' })
        logMain('info', 'agent', '会话总结命名：' + request.sessionId + ' → ' + title)
        return title
      }
    } catch (error) {
      logMain('warn', 'agent', '会话总结命名失败（回退用首条提问）：' + String(error))
    }
    const fallback = cleanSessionTitle(request.firstPrompt ?? null)
    if (fallback) {
      storeService.sessionTitleSet({ agentId: request.agentId, sessionId: request.sessionId, title: fallback, source: 'ai' })
      return fallback
    }
    return null
  }

  /** 逐块回退：把某次改动里指定的块恢复成改动前（只有 SDK 通道有基线）。 */
  async revertHunks(sessionId: string, toolUseId: string, indices: number[]): Promise<{ ok: boolean; conflict?: string }> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在：' + sessionId)
    if (!session.sdk?.revertHunksOf) throw new Error('当前会话不支持逐块回退（仅官方 SDK 通道支持）')
    return session.sdk.revertHunksOf(toolUseId, indices)
  }

  /**
   * 改会话上的一个配置项（模型 / 思考强度 / **通道自己的授权档位**）。
   *
   * 授权档位这条要特别小心：`RuntimeSession` 上缓存了 permissionMode 与两个能力位
   * （权限往返读的就是它，见下面 requestPermission / fs/write_text_file），
   * 活的切换必须**同时更新这份缓存**，否则会出现"界面切到自动、卡片却还在弹"。
   * 只有协议支持活动会话切换的（Claude Code 的授权模式，`rebuild: false`）才走这条路；
   * 需要重建的那些（Codex 的 approvalPolicy / sandbox）由界面负责 dispose，
   * 这里遇到就直接报错，不静默当没发生。
   */
  async setConfigOption(sessionId: string, optionId: string, value: string | boolean): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在')
    const control = permissionControlsOf(session.capability.protocol).find((item) => item.id === optionId)
    if (control?.rebuild) {
      throw new Error('「' + control.name + '」只能在建会话时指定，改它必须重建会话')
    }
    await session.handle.setConfigOption?.(optionId, value)
    if (optionId === 'permissionMode' && isPermissionMode(value)) {
      const settings = settingsService.all()
      const policy = policyFromControls(session.capability.protocol, value, { permissionMode: value })
      session.permissionMode = policy
      session.canWrite = policy === 'edit' || policy === 'auto' || settings.agent.allowWrite
      session.canExecute = policy === 'auto' || settings.agent.allowExecute
      logMain(
        'info',
        'agent',
        '档位切换（活动会话，不重建）：' + policy + ' 写=' + String(session.canWrite) + ' 执行=' + String(session.canExecute)
      )
    }
  }

  // ------------------------------------------------------------- 权限往返
  /**
   * SDK 的 `canUseTool` 回调 —— 我们把"要不要动手"这件事分成三步：
   *   1. `decidePermission`（纯策略）给出 放行 / 拒绝 / 转人工；
   *   2. 放行时把 SDK 的候选规则原样回传（勾"始终允许"才带上 `updatedPermissions`）；
   *   3. 转人工时通过统一事件弹卡片，等渲染进程回话。
   *
   * 注意：`canUseTool` **只在 CLI 认为需要授权时**被调用（读文件、cwd 内的只读命令不会来），
   * 所以它不能当审计钩子；要审计得用 hooks。
   */
  async decideSdkPermission(
    sessionId: string,
    mode: PermissionMode,
    workspaceDir: string,
    canWrite: boolean,
    toolName: string,
    input: Record<string, unknown>,
    extra: { suggestions?: unknown[]; decisionReason?: string; blockedPath?: string; toolUseID?: string }
  ): Promise<{ behavior: 'allow'; updatedPermissions?: unknown[] } | { behavior: 'deny'; message: string; interrupt?: boolean }> {
    const subject = {
      title: String(extra.blockedPath ?? toolName),
      kind: sdkToolKind(toolName),
      rawInput: input,
      options: []
    }
    const decision = decidePermission({
      policy: { mode, workspaceDir: workspaceDir.replace(/\\/g, '/'), allowedWriteDirs: [] },
      subject
    })
    /**
     * `plan` 档下 SDK 会自己把写入挡在回调之前（plan 模式不让编辑），
     * 走到这里通常意味着"模型要退出计划模式"或"要执行命令"，两种都必须问人。
     */
    /**
     * `ExitPlanMode` / `AskUserQuestion` 一律转人工：
     * 前者是"请批准计划"，它**不是写操作** —— 早先它落到策略的"计划模式拒绝一切改动"分支上，
     * 结果计划永远批不了（日志里能看到"权限自动拒绝（plan）：计划模式：不执行改动"）。
     * 后者本来就是要用户回答的问题。
     */
    const mustAsk =
      toolName === 'ExitPlanMode' ||
      toolName === 'AskUserQuestion' ||
      !decision.autoRespond ||
      (decision.allow && !canWrite && sdkToolKind(toolName) === 'write')
    if (!mustAsk) {
      logMain('info', 'agent', 'SDK 权限自动放行（' + mode + '）：' + decision.reason + ' :: ' + toolName)
      return { behavior: 'allow' }
    }
    /**
     * 无人值守的一次性任务（runOnce）：没有人能回答卡片，转人工等于死等到分块超时。
     * 直接拒绝并留痕，让模型自己回到"不用工具也能答"的路上。
     */
    const headlessSession = this.sessions.get(sessionId)
    if (headlessSession?.headless) {
      logMain('info', 'agent', '一次性任务即时拒绝工具调用（无人值守）：' + toolName + ' :: ' + decision.reason)
      return { behavior: 'deny', message: '本次为一次性抽取任务，不使用任何工具', interrupt: false }
    }
    /**
     * 计划审阅：`ExitPlanMode` 的入参是**空的**，方案文字在它前面的助手正文里。
     * 所以这里先从会话取出本轮正文，作为独立的 `plan-review` 事件下发 ——
     * 界面据此渲染"计划卡片"（可读的方案 + 批准/拒绝），而不是一张通用权限卡片。
     */
    if (toolName === 'ExitPlanMode') {
      const session = this.sessions.get(sessionId)
      const plan = session?.sdk?.currentTurnText?.() ?? ''
      this.emit(sessionId, {
        type: 'plan-review',
        plan: { plan: plan.trim(), filePath: planFilePathOf(toolName, input) }
      })
    }
    // 告诉桥接层"这次是人来定"：不要再按策略算第二遍（否则 plan 档会把自己拒掉）
    const detail = toPermissionDetail(toolName, input, { ...extra, userDecisionRequired: true })
    const chosen = await this.requestPermission(sessionId, detail)
    if (chosen === 'allow_always' || chosen === 'allow_once') {
      const rules = chosen === 'allow_always' ? extra.suggestions ?? [] : []
      if (rules.length > 0) {
        const session = this.sessions.get(sessionId)
        if (session) session.persistedRules = [...session.persistedRules, ...rules]
      }
      logMain('info', 'agent', 'SDK 权限经用户放行：' + toolName + (rules.length > 0 ? '（并写入 ' + rules.length + ' 条规则）' : ''))
      return { behavior: 'allow', ...(rules.length > 0 ? { updatedPermissions: rules } : {}) }
    }
    logMain('info', 'agent', 'SDK 权限被拒绝：' + toolName + ' :: ' + decision.reason)
    return { behavior: 'deny', message: '用户拒绝了这次操作', interrupt: false }
  }

  /** 由 ACP 客户端回调：按授权模式自动放行 / 自动拒绝 / 转人工。 */
  requestPermission(sessionId: string, detail: PermissionDetail): Promise<string | null> {
    /**
     * 已经由 SDK 闸门判定为"交人工"的请求：直接走人工流程。
     * 这条分支把"策略"与"询问"分清楚：策略只管该不该问，问了之后就等人。
     */
    if (detail.userDecisionRequired) {
      return this.askHuman(sessionId, detail)
    }
    const session = this.sessions.get(sessionId) ?? null
    const policy = {
      mode: session?.permissionMode ?? 'manual',
      workspaceDir: session?.workspaceDir ?? null,
      // 会话创建时已经算过"能不能写"，这里不再叠加全局白名单（否则自动档会被静默阉掉）
      allowedWriteDirs: [] as string[]
    }
    const decision = decidePermission({
      policy,
      subject: { title: detail.title, kind: detail.kind, rawInput: detail.rawInput, options: detail.options }
    })
    if (decision.autoRespond) {
      const option = detail.options.find((item) =>
        decision.allow ? item.kind === 'allow_once' || item.kind === 'allow_always' : item.kind.startsWith('reject')
      )
      logMain(
        'info',
        'agent',
        '权限' +
          (decision.allow ? '自动放行' : '自动拒绝') +
          '（' +
          policy.mode +
          '）：' +
          decision.reason +
          (decision.evidence ? ' :: ' + decision.evidence.slice(0, 200) : '')
      )
      return Promise.resolve(decision.allow ? option?.optionId ?? null : null)
    }
    // 无人值守的一次性任务：没有人能回答卡片，转人工等于死等到分块超时 → 直接拒绝
    if (session?.headless) {
      logMain('info', 'agent', '一次性任务即时拒绝权限请求（无人值守）：' + detail.title)
      return Promise.resolve(null)
    }
    if (!session) {
      // 会话已释放：没有策略可依据，一律拒绝并留痕
      logMain('warn', 'agent', '权限请求对应的会话不存在，已拒绝：' + detail.title)
      return Promise.resolve(null)
    }
    logMain('debug', 'agent', '权限请求转人工（' + session.permissionMode + '）：' + detail.title)
    return this.askHuman(sessionId, detail)
  }

  /** 把一张卡片交给用户，等回话（5 分钟不动就按拒绝处理，并留痕）。 */
  private askHuman(sessionId: string, detail: PermissionDetail): Promise<string | null> {
    const requestId = createId('perm')
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.permissions.delete(requestId)
        this.emit(sessionId, {
          type: 'permission-request',
          requestId,
          detail: { ...detail, title: detail.title + '（超时未响应，已自动拒绝）' }
        })
        resolve(null)
      }, 5 * 60 * 1000)
      this.permissions.set(requestId, { resolve, timer })
      this.emit(sessionId, { type: 'permission-request', requestId, detail })
    })
  }

  respondPermission(requestId: string, optionId: string | null): void {
    const pending = this.permissions.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.permissions.delete(requestId)
    pending.resolve(optionId)
  }

  // --------------------------------------------------------- 文件能力白名单
  async readTextFileForAgent(path: string, line?: number, limit?: number): Promise<string> {
    const text = await fsService.readText(path)
    if (line == null) return limit != null ? text.slice(0, limit) : text
    const lines = text.split('\n')
    const start = Math.max(0, line - 1)
    const slice = lines.slice(start, limit != null ? start + limit : undefined)
    return slice.join('\n')
  }

  /**
   * ACP 的 fs/write_text_file 通道（权限会话之外的第二条写入路径）。
   * 判定与会话创建时保持一致：会话允许写就直接写，否则回落到全局设置与白名单。
   */
  async writeTextFileForAgent(path: string, content: string, sessionId?: string): Promise<void> {
    const settings = settingsService.all()
    const session = sessionId ? this.sessions.get(sessionId) ?? null : null
    if (!(session?.canWrite ?? settings.agent.allowWrite)) throw new Error('写入被策略拒绝')
    const allowed = settings.agent.allowedWriteDirs
    if (!session && allowed.length > 0 && !allowed.some((dir) => path.startsWith(dir))) {
      throw new Error('目标目录不在允许写入的白名单内')
    }
    await fsService.writeText(path, content)
  }

  async shutdown(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      try {
        await session.handle.dispose()
      } catch {
        /* 忽略 */
      }
    }
    this.sessions.clear()
    for (const [, pending] of this.permissions) {
      clearTimeout(pending.timer)
      pending.resolve(null)
    }
    this.permissions.clear()
  }
}

/**
 * 计划模式下 CLI 会把方案落盘到 `~/.claude/plans/<name>.md`，
 * 但 `ExitPlanMode` 的入参是空的、拿不到路径；界面要"打开计划文件"时用这个兜底解析。
 */
function planFilePathOf(_toolName: string, input: Record<string, unknown>): string | null {
  const candidate = input?.plan_file_path ?? input?.filePath ?? input?.file_path
  if (typeof candidate === 'string' && candidate.length > 0) return candidate
  return null
}

/**
 * SDK 的工具名 → 我们的权限类别。
 * 读类工具（Read/Glob/Grep/WebSearch…）在 CLI 侧多数会自行放行，这里只是分类依据。
 */
function sdkToolKind(toolName: string): string {
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(toolName)) return 'write'
  if (/^(Bash|BashOutput|KillShell)$/i.test(toolName)) return 'execute'
  if (/^(Read|Glob|Grep|WebFetch|WebSearch|ToolSearch|ListAgents)$/i.test(toolName)) return 'read'
  if (toolName === 'ExitPlanMode') return 'plan'
  return 'other'
}

export const agentRuntime = new AgentRuntime()

/**
 * ACP 握手失败时的补充提示。
 *
 * dsh 的 ACP 通道是"自带模型路由"的：密钥（`DEEPSEEK_API_KEY`）没配时它会在建会话阶段
 * 直接报错，用户看到的就是一句英文异常 —— 这里补一句"去哪儿配"。
 */
function acpHint(agentId: string): string {
  const registration = agentRegistry.get(agentId)
  if (registration?.kind !== 'dsh') return ''
  const configured = agentRegistry.hasCredentials(agentId)
  return configured
    ? '（dsh 提示：ACP 会话由 `dsh --profile acp` 提供，profile 首次使用会自动初始化；若一直失败，可在终端手动跑一次 `dsh --profile acp --help` 看它自己的报错）'
    : '（dsh 提示：还没配 DeepSeek API Key —— 到「设置 → Agent」填一个，程序会以 DEEPSEEK_API_KEY 注入给 dsh）'
}

/**
 * ACP 会话自己量到的配置项（模型 / 思考强度）。
 * 只有 `AcpSession` 有 `options` 这个 getter —— 其它通道结构上拿不到，返回 null 表示"沿用能力清单"。
 */
function acpConfigOptions(handle: AgentSessionHandle): unknown[] | null {
  const options = (handle as { options?: unknown }).options
  return Array.isArray(options) && options.length > 0 ? options : null
}
