/** preload 通过 contextBridge 暴露给渲染进程的白名单 API。 */
import type {
  AppInfo, AnnotationRecord, AnchorRecord, BlockRecord, DocumentRecord,
  FileStat, LogEntry, MessageDialogOptions, RecentEntry, SaveDialogOptions,
  Unsubscribe, WindowState
} from './ipc'
import type { AppSettings } from './settings'
import type { PermissionMode } from './permissions'
import type { SessionSnapshot } from './session'
import type { ResolvedTheme } from './theme'

export interface AgentConfigOptionValue {
  value: string
  name: string
  description?: string
}

export interface AgentConfigOption {
  id: string
  name: string
  description?: string
  category: string
  type: string
  /** 可能是数组：dsh 的 `model` 项是 `[provider, model]` 路由（见 services/agent/config-value.ts）。 */
  currentValue: string | boolean | unknown[] | null
  options?: AgentConfigOptionValue[]
}

export interface AgentModelView {
  /** 提交给 CLI 的值：角色别名（sonnet/opus/haiku/fable）或完整模型名 */
  id: string
  name: string
  description?: string
  /** 该别名**实际解析到的真实模型**（换 API 后别名与真实模型往往不是一个东西） */
  resolvedModel?: string
  supportsEffort?: boolean
  effortLevels?: string[]
  thoughtLevels?: { id: string; name: string; description?: string }[]
  defaultThoughtLevel?: string | null
}

export interface AgentCapabilityView {
  id: string
  kind: string
  displayName: string
  protocol: string
  available: boolean
  version: string | null
  executable: string | null
  supportsAcp: boolean
  supportsResume: boolean
  models: AgentModelView[]
  configOptions: AgentConfigOption[]
  defaultModel: string | null
  defaultThoughtLevel: string | null
  error: string | null
  probedAt: number
  builtin: boolean
}

export interface AgentRegistrationView {
  id: string
  kind: string
  displayName: string
  protocol: string
  executable: string | null
  args: string[]
  /**
   * 追加给该 Agent 子进程的环境变量。
   * 值支持 `secret:<key>` 形态 —— 从系统加密的密钥库取（例如 `{"DEEPSEEK_API_KEY":"secret:deepseek.apiKey"}`）。
   */
  env?: Record<string, string>
  enabled: boolean
  builtin: boolean
  capability: AgentCapabilityView | null
  /**
   * 需要密钥的 Agent（目前只有 dsh）是否已经拿到密钥。
   * `null` = 这个 Agent 不需要密钥；`false` = 需要但没配（界面要提示去哪儿配）。
   */
  credentialOk?: boolean | null
}

export interface AgentRegistrationInput {
  id?: string
  kind: string
  displayName: string
  protocol: string
  executable: string | null
  args: string[]
  /** 见 {@link AgentRegistrationView.env}：值可以是字面量，也可以是 `secret:<key>` 引用。 */
  env?: Record<string, string>
  enabled?: boolean
}

export interface AgentSessionRequest {
  agentId: string
  contextMode: 'fulltext' | 'graph'
  modelId?: string | null
  thinkingEffort?: string | null
  resumeSessionId?: string | null
  documentDir?: string | null
  /** 授权模式：会话创建时即确定写文件 / 执行命令的许可（见 shared/permissions.ts） */
  permissionMode?: PermissionMode | null
  /** 分叉已有会话的历史开新会话（原会话不动） */
  forkSession?: boolean
  /** 从某个用户消息处开始（配合 fork） */
  resumeSessionAt?: string | null
}

export interface AgentPromptInput {
  text: string
  systemContext?: string
  modelId?: string | null
  thinkingEffort?: string | null
}

export type AgentEventPayload =
  | { sessionId: string; type: 'text-delta'; text: string }
  | { sessionId: string; type: 'thinking'; text: string }
  | { sessionId: string; type: 'tool-call'; id: string; name: string; title?: string; input: unknown; parentId?: string }
  | { sessionId: string; type: 'tool-result'; id: string; name: string; output: unknown; isError: boolean }
  | { sessionId: string; type: 'permission-request'; requestId: string; detail: { title: string; kind: string; rawInput: unknown; options: { optionId: string; name: string; kind: string }[] } }
  | { sessionId: string; type: 'usage'; inputTokens: number; outputTokens: number }
  | {
      /** 会话的上下文窗口占用（对话当前占了多少窗口；与单条消息 usage 不同） */
      sessionId: string
      type: 'context-usage'
      used: number
      /** 窗口总量；通道报不上来时为 null */
      size: number | null
    }
  | { sessionId: string; type: 'plan'; entries: { content: string; status: string }[] }
  | { sessionId: string; type: 'tool-diff'; diff: ToolDiffView }
  | { sessionId: string; type: 'plan-review'; plan: { plan: string; filePath?: string | null } }
  | { sessionId: string; type: 'checkpoint'; userMessageId: string }
  | { sessionId: string; type: 'session'; remoteSessionId: string | null; resumed: boolean; activeModel?: string }
  | { sessionId: string; type: 'mode-changed'; mode: string }
  | { sessionId: string; type: 'done'; stopReason: string }
  | { sessionId: string; type: 'error'; message: string; retryable: boolean }

/** 斜杠命令（CLI 下发，界面只做展示与补全） */
export interface SlashCommandView {
  name: string
  description?: string
  argumentHint?: string
}

/** 工作区里的一个文件（"@ 文件引用"的候选项） */
export interface WorkspaceFileView {
  path: string
  name: string
  dir: string
  size: number
  modified: number
}

/** 历史会话（CLI 持久化的会话记录） */
export interface AgentSessionInfoView {
  sessionId: string
  summary?: string
  lastModified?: number
  firstPrompt?: string
  customTitle?: string
  gitBranch?: string
  cwd?: string
  /**
   * 界面直接显示的名字（主进程按 `resolveSessionTitle` 定好优先级）。
   * 各通道给的原生字段参差不齐 —— dsh 的 `session/list` 只回 sessionId + cwd，
   * 所以"我们自己存的名字 / 我们记的首条提问"也要参与，最终给一个能看懂的名字。
   */
  title?: string | null
  /** 这个名字是哪来的（`stored` = 用户手改或 AI 总结；`agent` / `ours` / `prompt`） */
  titleSource?: 'stored' | 'agent' | 'ours' | 'prompt' | null
  /** 没有名字时界面显示的短 id（前 8 位） */
  shortId?: string
}

/** 一次文件改动的结构化差异（主进程算好，渲染进程只负责画） */
export interface ToolDiffView {
  toolUseId: string
  filePath: string
  additions: number
  deletions: number
  truncated: boolean
  hunks: {
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    rows: { kind: string; oldLine: number | null; newLine: number | null; text: string }[]
  }[]
}

export interface FsChangeEvent {
  path: string
  kind: 'change' | 'rename'
}

export interface RestoreReport {
  snapshot: SessionSnapshot
  recoveredFromBackup: boolean
  crashed: boolean
}

export interface LogicReaderApi {
  app: {
    info(): Promise<AppInfo>
    openExternal(url: string): Promise<void>
    quit(): Promise<void>
    relaunch(): Promise<void>
    setUiScale(scale: number): Promise<void>
    onOpenFiles(cb: (files: string[]) => void): Unsubscribe
    takePendingFiles(): Promise<string[]>
    onMenuCommand(cb: (payload: { commandId: string; args?: unknown }) => void): Unsubscribe
  }
  win: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    setFullScreen(value: boolean): Promise<void>
    state(): Promise<WindowState>
    onState(cb: (s: WindowState) => void): Unsubscribe
  }
  dialog: {
    openFiles(): Promise<string[]>
    openFolder(): Promise<string | null>
    saveFile(options: SaveDialogOptions): Promise<string | null>
    message(options: MessageDialogOptions): Promise<number>
  }
  fs: {
    stat(path: string): Promise<FileStat | null>
    exists(path: string): Promise<boolean>
    readBinary(path: string): Promise<Uint8Array>
    readText(path: string): Promise<string>
    writeText(path: string, text: string): Promise<void>
    writeBinary(path: string, data: Uint8Array): Promise<void>
    hash(path: string): Promise<string>
    reveal(path: string): Promise<void>
    openPath(path: string): Promise<string>
    readDir(path: string): Promise<{ name: string; path: string; isDirectory: boolean }[]>
    watch(path: string): Promise<void>
    unwatch(path: string): Promise<void>
    onChanged(cb: (e: FsChangeEvent) => void): Unsubscribe
    recent(): Promise<RecentEntry[]>
    pushRecent(entry: Omit<RecentEntry, 'at'>): Promise<RecentEntry[]>
  }
  settings: {
    all(): Promise<AppSettings>
    patch(patch: unknown): Promise<AppSettings>
    reset(): Promise<AppSettings>
    onChange(cb: (s: AppSettings) => void): Unsubscribe
    setSecret(key: string, value: string): Promise<void>
    hasSecret(key: string): Promise<boolean>
    deleteSecret(key: string): Promise<void>
  }
  session: {
    load(): Promise<RestoreReport | null>
    save(patch: unknown): Promise<void>
    flush(reason: string): Promise<void>
    clear(): Promise<void>
  }
  store: {
    upsertDocument(doc: DocumentRecord): Promise<void>
    listDocuments(limit?: number): Promise<DocumentRecord[]>
    getDocument(id: string): Promise<DocumentRecord | null>
    removeDocument(id: string): Promise<void>
    saveBlocks(docId: string, blocks: BlockRecord[]): Promise<void>
    getBlocks(docId: string): Promise<BlockRecord[]>
    saveAnchors(anchors: AnchorRecord[]): Promise<void>
    getAnchor(id: string): Promise<AnchorRecord | null>
    listAnchors(docId: string): Promise<AnchorRecord[]>
    updateAnchor(anchor: AnchorRecord): Promise<void>
    listAnnotations(docId: string): Promise<AnnotationRecord[]>
    upsertAnnotation(annotation: AnnotationRecord): Promise<void>
    deleteAnnotation(id: string): Promise<void>
    graphSave(payload: unknown): Promise<void>
    graphGet(graphId: string): Promise<unknown | null>
    graphList(docId: string): Promise<unknown[]>
    graphPatch(graphId: string, patch: unknown): Promise<void>
    graphDelete(graphId: string): Promise<void>
    conversationUpsert(payload: unknown): Promise<void>
    /**
     * 把远端会话 id 写到我们自己的会话行上（历史列表靠它把"我们的首条提问"当成标题）。
     * 只在还没有值时写，不覆盖。
     */
    conversationSetRemoteSession(conversationId: string, remoteSessionId: string): Promise<void>
    conversationList(docId: string): Promise<unknown[]>
    conversationGet(id: string): Promise<unknown | null>
    messageAppend(payload: unknown): Promise<void>
    messageList(conversationId: string): Promise<unknown[]>
    agentUpsert(payload: unknown): Promise<void>
    agentList(): Promise<unknown[]>
    stats(): Promise<Record<string, number>>
  }
  agent: {
    list(): Promise<AgentRegistrationView[]>
    probe(agentId: string, force?: boolean): Promise<AgentCapabilityView>
    probeAll(force?: boolean): Promise<AgentCapabilityView[]>
    upsert(registration: AgentRegistrationInput): Promise<AgentRegistrationView[]>
    remove(agentId: string): Promise<AgentRegistrationView[]>
    sessionCreate(request: AgentSessionRequest): Promise<{
    sessionId: string
    capability: AgentCapabilityView
    configOptions: AgentConfigOption[]
    /** 该会话实际使用的工作目录（"@ 文件引用"与权限判定都以它为准） */
    workspaceDir: string
  }>
  /** 由文档目录推导出的工作目录（与建会话用同一套规则） */
  workdir(documentDir: string | null): Promise<string>
  /** 会话真实可用的模型清单（SDK 通道才有；返回空数组表示"拿不到，沿用能力清单"） */
  models(sessionId: string): Promise<AgentModelView[]>
  /** 不建常驻会话地探测一次模型清单（界面在"还没发过消息"时也能显示真实模型名） */
  probeModels(agentId: string): Promise<AgentModelView[]>
  /**
   * 会话的上下文窗口占用（拉取式，与 `context-usage` 事件同一数据）。
   * 只有 SDK 通道有"随时问一次"的方法；null = 该通道拉不到，沿用事件带来的最后已知值。
   */
  contextUsage(sessionId: string): Promise<{ used: number; size: number | null } | null>
  /** 会话可用的斜杠命令（由 CLI 下发，含用户技能；非 SDK 通道返回空数组） */
  commands(sessionId: string): Promise<SlashCommandView[]>
  /**
   * 列某个工作目录下的历史会话。
   * 传 agentId 会按该 Agent 的通道取：Codex 走 `thread/list`，其余走 CLI 的会话记录
   * （两者都与 VS Code 扩展共用同一份数据）。
   */
  history(dir: string | null, limit?: number, agentId?: string | null): Promise<AgentSessionInfoView[]>
  /** 给某个历史会话改名（存本地；最高优先级，盖过 Agent 自己给的名字） */
  historyRename(agentId: string, sessionId: string, title: string): Promise<void>
  /** 让 Agent 用一句话给某个历史会话"总结命名"（续聊那条会话再问，一次很小的调用） */
  historyName(agentId: string, sessionId: string, firstPrompt?: string | null): Promise<string | null>
  /**
   * 读一个历史会话的**全部对话**（点开历史会话时的回放数据源）。
   * SDK（Claude Code）与 dsh（读它自己的会话日志）支持；其它通道返回空数组（界面给"暂不支持回放"）。
   */
  historyTranscript(agentId: string | null, sessionId: string, cwd: string | null): Promise<{ role: 'user' | 'assistant'; text: string; thinking: string; at: number }[]>
  /**
   * 删除一个历史会话（目前只有 Claude Code 通道支持，删它本机的会话记录）。
   * 返回 false = 该通道不支持删除（界面要说明，而不是静默无操作）。
   */
  historyDelete(agentId: string | null, sessionId: string, cwd: string | null): Promise<boolean>
  /** 工作区文件索引（"@ 文件引用"用；主进程缓存，遵守 respectGitIgnore） */
  files(dir: string | null, query?: string, limit?: number): Promise<WorkspaceFileView[]>
  /** 把文件回退到某个检查点（用户消息）之前；dryRun 只预演不改盘 */
  rewind(sessionId: string, userMessageId: string, dryRun?: boolean): Promise<unknown>
  /** 逐块回退：把某次改动里指定的块恢复成改动前（冲突时不动盘，返回原因） */
  revertHunks(sessionId: string, toolUseId: string, indices: number[]): Promise<{ ok: boolean; conflict?: string }>
    sessionDispose(sessionId: string): Promise<void>
    sessionList(): Promise<{ sessionId: string; agentId: string; contextMode: string; createdAt: number }[]>
    prompt(sessionId: string, input: AgentPromptInput): Promise<void>
    cancel(sessionId: string): Promise<void>
    permissionRespond(requestId: string, optionId: string | null): Promise<void>
    setConfigOption(sessionId: string, optionId: string, value: string | boolean): Promise<void>
    onEvent(cb: (payload: AgentEventPayload) => void): Unsubscribe
    /** Agent 注册表/能力探测结果变化（启动后台探测完成时触发） */
    onChanged(cb: () => void): Unsubscribe
  }
  convert: {
    availability(force?: boolean): Promise<{ available: boolean; path: string | null; version: string | null; reason: string | null }>
    toPdf(path: string, hash?: string): Promise<string>
    pickLibreOffice(): Promise<{ available: boolean; path: string | null; version: string | null; reason: string | null } | null>
  }
  graph: {
    estimate(request: Record<string, unknown>): Promise<unknown>
    generate(request: Record<string, unknown>): Promise<unknown>
    cancel(taskId: string): Promise<void>
    refine(request: Record<string, unknown>): Promise<unknown>
    retryFailedChunks(request: Record<string, unknown>): Promise<unknown>
    exportFile(graphId: string, format: 'json' | 'markdown' | 'svg', targetPath: string): Promise<string>
    /**
     * 取关系图的 SVG 文本，供渲染进程转成位图。
     * `background` 传颜色会画一层底色（JPG 没有 alpha 通道，用界面上的画布底色），
     * 传 null / 不传则不画底（PNG 保持透明）。
     */
    renderSvg(graphId: string, options?: { background?: string | null }): Promise<string>
    importFile(filePath: string): Promise<unknown>
    applyLayout(graphId: string, positions: Record<string, { x: number; y: number }>): Promise<void>
    presets(): Promise<unknown[]>
    savePreset(preset: Record<string, unknown>): Promise<unknown[]>
    onProgress(cb: (progress: { taskId: string; phase: string; done: number; total: number; detail: string; error?: string }) => void): Unsubscribe
  }
  log: {
    write(level: LogEntry['level'], scope: string, message: string, detail?: string): Promise<void>
    read(limit?: number): Promise<LogEntry[]>
    clear(): Promise<void>
    onEntry(cb: (e: LogEntry) => void): Unsubscribe
  }
  theme: {
    onSystemChange(cb: (theme: ResolvedTheme, prefersDark: boolean) => void): Unsubscribe
  }
}

/** 渲染进程可用的全局对象名。 */
export const API_GLOBAL = 'logicreader'
