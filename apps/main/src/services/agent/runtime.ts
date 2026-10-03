/** Agent 运行时：会话生命周期、事件总线、权限往返 —— 规划书 §5.4。 */
import { createId, decidePermission, normalizePermissionMode, type PermissionMode } from '@logicreader/shared'
import { logMain } from '../../util/ipc'
import { agentRegistry } from './registry'
import { SdkAdapter, asSdkHandle, toPermissionDetail, type SdkCanUseTool } from './sdk'
import { asCodexHandle, type CodexCapableHandle } from './codex'
import { mapSdkModel, type ModelView } from './model-view'

/** ACP 启动参数：优先取注册表里配置的参数。 */
function registrationArgs(agentId: string, capability: AgentCapability): string[] {
  const registration = agentRegistry.get(agentId)
  const args = registration?.args ?? []
  if (args.length > 0) return args
  return capability.launchArgs
}

import { fsService } from '../fs.service'
import { settingsService } from '../settings.service'
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
    const permissionMode = normalizePermissionMode(request.permissionMode)
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
      modelId: request.modelId ?? capability.defaultModel,
      thinkingEffort: request.thinkingEffort ?? capability.defaultThoughtLevel,
      contextMode: request.contextMode,
      resumeSessionId: request.resumeSessionId ?? null,
      forkSession: request.forkSession === true,
      resumeSessionAt: request.resumeSessionAt ?? null,
      permissionMode,
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
        onEvent({ type: 'error', message: 'ACP 连接失败，已回退 CLI：' + (error instanceof Error ? error.message : String(error)), retryable: true })
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
      configOptions: capability.configOptions,
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
        '）'
    )
    return { sessionId, capability, configOptions: capability.configOptions, workspaceDir }
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
   */
  async listSessions(dir: string | null, limit = 30, agentId: string | null = null): Promise<unknown[]> {
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
        return listCodexSessionsFor({
          executable: registration.executable,
          extraArgs: registration.args,
          cwd: target,
          limit
        })
      }
    }
    const { listSessionsFor } = await import('./sdk')
    return listSessionsFor(target, limit)
  }

  /** 逐块回退：把某次改动里指定的块恢复成改动前（只有 SDK 通道有基线）。 */
  async revertHunks(sessionId: string, toolUseId: string, indices: number[]): Promise<{ ok: boolean; conflict?: string }> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在：' + sessionId)
    if (!session.sdk?.revertHunksOf) throw new Error('当前会话不支持逐块回退（仅官方 SDK 通道支持）')
    return session.sdk.revertHunksOf(toolUseId, indices)
  }

  async setConfigOption(sessionId: string, optionId: string, value: string | boolean): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在')
    await session.handle.setConfigOption?.(optionId, value)
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
