/** Agent 适配层类型定义 —— 规划书 §5.4。 */

export type AgentKind = 'claude-code' | 'codex' | 'dsh' | 'gemini' | 'custom'
/**
 * 接入协议：
 *  - `app-server`：**Codex 官方 app-server**（JSON-RPC over stdio，官方出品的常驻服务，
 *    也是 Codex VS Code 扩展自己走的那条路：一个常驻进程 + 一条控制通道，
 *    能切模型 / 思考强度、中断回合、审批往返、列历史线程）。Codex 的推荐路径；
 *  - `sdk`：官方 @anthropic-ai/claude-agent-sdk（**Claude Code 的推荐路径**，
 *    也是 VS Code 扩展自己走的路径：一个常驻子进程 + 控制通道，能切授权模式、
 *    中断、回退文件检查点、列会话）；
 *  - `acp`：通用 Agent Client Protocol（给 DSH / Gemini 之类支持 ACP 的工具用）；
 *  - `cli`：一次性子进程兜底（老工具、不支持上面两种协议时）；
 *  - `mock`：离线演示与冒烟，不消耗任何配额。
 */
export type AgentProtocol = 'app-server' | 'sdk' | 'acp' | 'cli' | 'mock'

export interface ModelOption {
  /**
   * 选择器里提交的值。可能是**角色别名**（`sonnet` / `opus` / `haiku` / `fable`），
   * 也可能是完整模型名 —— 取决于用户在 `~/.claude/settings.json` 里怎么配的。
   */
  id: string
  /** 界面显示名（SDK 的 `displayName`，通常就是真实模型名） */
  name: string
  description?: string
  /**
   * **该别名实际解析到的真实模型**（SDK 的 `resolvedModel`）。
   *
   * 为什么必须有它：用户把 Claude Code 指向第三方 API 之后，
   * `sonnet` 很可能解析成 GLM-5.3-Flash、`haiku` 解析成 DeepSeek-V4-Flash。
   * 只显示别名的话，用户根本不知道当前是哪家模型在回答；
   * 而 `ANTHROPIC_DEFAULT_*_MODEL` 这类映射在运行时可能变，所以要以 SDK 的解析结果为准。
   */
  resolvedModel?: string
  /** 该模型是否支持思考强度调节 */
  supportsEffort?: boolean
  /** SDK 声明的可用思考强度档位（id 即 value） */
  effortLevels?: string[]
  /** 该模型声明的思考强度档位 */
  thoughtLevels?: { id: string; name: string; description?: string }[]
  defaultThoughtLevel?: string | null
}

export interface ConfigOptionValue {
  value: string
  name: string
  description?: string
}

export interface ConfigOption {
  id: string
  name: string
  description?: string
  category: 'model' | 'thought_level' | 'model_config' | 'mode' | string
  type: 'select' | 'boolean' | string
  /**
   * 当前值。**可能是数组**：dsh 的 `model` 项就是一个 `[provider, model]` 路由
   * （实测报文见 config-value.ts）。界面只把它当展示用，编码由 encodeConfigValue 负责。
   */
  currentValue: string | boolean | unknown[] | null
  options?: ConfigOptionValue[]
}

export interface AgentCapability {
  id: string
  kind: AgentKind
  displayName: string
  protocol: AgentProtocol
  available: boolean
  version: string | null
  executable: string | null
  /** 解析后的启动参数（.cmd shim 会转换成 node <script>） */
  launchArgs: string[]
  /**
   * 启动这个可执行文件**必须**带的环境变量（来自 shim 里写死的声明）。
   * 例：DeepSeek Harness 桌面端自带的 `dsh.cmd` 靠 `ELECTRON_RUN_AS_NODE=1`
   * 让 Electron 当 Node 跑它的 cli.js —— 少了这个变量，命令起来就报错。
   */
  launchEnv?: Record<string, string>
  supportsAcp: boolean
  /** 官方 SDK 通道（能切授权模式 / 中断 / 回退检查点） */
  supportsSdk: boolean
  supportsResume: boolean
  supportsStreaming: boolean
  supportsModel: boolean
  supportsThoughtLevel: boolean
  /**
   * 运行时能否切换授权模式。
   * SDK 通道可以（`setPermissionMode` 走控制通道），ACP 通道要重建会话。
   */
  supportsPermissionModeSwitch: boolean
  models: ModelOption[]
  configOptions: ConfigOption[]
  defaultModel: string | null
  defaultThoughtLevel: string | null
  error: string | null
  probedAt: number
  /** 是否内置（内置项不可删除，只可禁用/改路径） */
  builtin: boolean
}

export interface AgentDefinition {
  id: string
  kind: AgentKind
  displayName: string
  protocol: AgentProtocol
  executable: string | null
  args: string[]
  env: Record<string, string>
  enabled: boolean
  builtin: boolean
}

export interface AgentRegistration extends AgentDefinition {
  capability?: AgentCapability | null
}

/**
 * 一次文件改动的差异（由 PreToolUse 基线 + 工具结果算出来）。
 * 界面用它渲染"内联 diff 审阅"卡片：看得见改了什么，并能一键回退。
 */
export interface ToolDiffView {
  toolUseId: string
  /** 改动的文件路径（渲染时按最后一节显示文件名，完整路径放 title） */
  filePath: string
  additions: number
  deletions: number
  /** 结构化差异块（只带变更附近的上下文） */
  hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; rows: { kind: string; oldLine: number | null; newLine: number | null; text: string }[] }[]
  truncated: boolean
}

/**
 * 会话可用的斜杠命令（由 CLI 下发，不是我们硬编码的）。
 * 本机实测 `initializationResult().commands` 给 65 条，含用户自己的技能（描述末尾带 "(user)"）。
 */
export interface SlashCommandView {
  name: string
  description?: string
  argumentHint?: string
}

/** 计划模式下 Agent 给出的方案（放在对话流里让人批准，而不是系统模态框）。 */
export interface PlanView {
  plan: string
  /** 计划落盘的文件（SDK 会给），用于「打开计划文件」 */
  filePath?: string | null
}

export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool-call'
      id: string
      name: string
      input: unknown
      title?: string
      /** 该调用来自哪个子代理（Task 工具的 tool_use_id）；主线程为空 */
      parentId?: string
    }
  | { type: 'tool-result'; id: string; name: string; output: unknown; isError: boolean }
  | { type: 'permission-request'; requestId: string; detail: PermissionDetail }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | {
      /** 会话的**上下文窗口占用**（与单条消息的 usage 不同：这是当前对话总共占了多少窗口） */
      type: 'context-usage'
      used: number
      /** 窗口总量；通道报不上来时为 null（界面只显示 used） */
      size: number | null
    }
  | { type: 'plan'; entries: { content: string; status: string }[] }
  | { type: 'plan-review'; plan: PlanView }
  | { type: 'tool-diff'; diff: ToolDiffView }
  | { type: 'checkpoint'; userMessageId: string }
  | {
      type: 'session'
      remoteSessionId: string | null
      resumed: boolean
      /** 本会话实际运行的模型（别名已由 CLI 解析）；拿不到时省略 */
      activeModel?: string
    }
  | { type: 'mode-changed'; mode: string }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; message: string; retryable: boolean }

export interface PermissionDetail {
  title: string
  kind: string
  rawInput: unknown
  options: { optionId: string; name: string; kind: string }[]
  /** SDK 给的建议规则（勾「始终允许」时原样带回，能持久化到项目设置） */
  suggestions?: unknown[]
  /** 为什么问（SDK 的 decisionReason；没有就是 undefined） */
  reason?: string
  /** 该操作的目标路径（SDK 给的 blockedPath） */
  blockedPath?: string
  /**
   * 已经过 SDK 的 `canUseTool` 闸门判定、结果就是"交人工"。
   * 权限桥接层看到它要**直接问用户**，不要再拿同一套策略算第二遍 ——
   * 否则 plan 档会被"计划模式拒绝一切改动"再拒一次，计划永远批不了（本轮实测踩到）。
   */
  userDecisionRequired?: boolean
}

export interface PromptInput {
  text: string
  /** 由 ContextBuilder 组装好的完整提示词（系统头 + 上下文 + 问题） */
  systemContext?: string
  modelId?: string | null
  thinkingEffort?: string | null
  /** 附带的文件（仅作为提示词中的路径引用） */
  attachments?: string[]
}

export interface SessionOptions {
  /** 运行时预先生成的会话 id */
  sessionId?: string
  agentId: string
  /** 工作目录（默认使用隔离的只读影子目录） */
  cwd: string
  /**
   * 额外注入给 Agent 子进程的环境变量（已由 runtime 解析过 `secret:` 引用）。
   *
   * 用途：dsh（DeepSeek Harness）这类自带模型路由的 harness 要从环境读 API Key
   * （`DEEPSEEK_API_KEY`）；没有这条通道时用户无法在程序里给它配密钥。
   * **日志只允许打印变量名，不允许打印值**（见 env.ts 的 describeEnvNames）。
   */
  env?: Record<string, string>
  modelId?: string | null
  thinkingEffort?: string | null
  contextMode: 'fulltext' | 'graph'
  /** 支持 resume 的 Agent 传入远端会话 id */
  resumeSessionId?: string | null
  /**
   * 分叉：复制该会话的历史开一个新会话，原会话不动（官方 SDK 的 `forkSession`）。
   * 与 resume 的区别很重要：resume 是"接着聊"，fork 是"从这儿另起一条线，回头还能看原来那条"。
   */
  forkSession?: boolean
  /** 从某个用户消息处开始（配合 fork 做"从这条消息分叉"） */
  resumeSessionAt?: string | null
  /** 授权模式（sdk 通道会翻成 SDK 的 permissionMode） */
  permissionMode?: 'manual' | 'plan' | 'edit' | 'auto'
  clientCapabilities?: Record<string, unknown>
  /**
   * 会话级权限回调（只有 SDK 通道用）。
   * 由运行时注入，闭包里带该会话的 id / 工作区 / 授权模式；
   * 放在这里而不是适配器构造参数，是为了"一次会话一个回调"，多文档多会话时不会串。
   */
  canUseTool?: SdkCanUseToolHook
  /** 加载哪些 Claude Code 设置来源（默认 ['user']：代理地址 / 鉴权 / 技能都在用户设置里） */
  settingSources?: string[]
  /**
   * 关掉全部内置工具（SDK 约定：`tools: []`）—— 给**无人值守的一次性任务**用。
   *
   * 图谱抽取只要一段 JSON 正文：模型中途跑去 Write/Bash，不但白烧一整轮，
   * 而且一次性任务没有人能回答权限卡片（manual 档会一直等到分块超时）。
   */
  disableTools?: boolean
  /**
   * 通用授权回执（app-server 通道用）。
   *
   * 与 Claude 的 `canUseTool` 不同：这里的形状是"把一张权限卡片交给运行时，
   * 拿回用户/策略选中的 optionId（null = 拒绝）"。运行时的 `requestPermission`
   * 已经实现了"策略自动放行 / 转人工弹卡片 / 无人值守即时拒绝"三态，
   * 所以 Codex 通道直接复用它，两条通道的授权语义不会分叉。
   */
  requestPermission?: (detail: PermissionDetail) => Promise<string | null>
  /**
   * 这个会话没有人守着：权限请求不转人工，直接拒绝并留痕（见 runtime.requestPermission）。
   */
  headless?: boolean
}

/**
 * SDK 的 canUseTool 形状（结构化子集）。
 * 定义在共享类型里避免 sdk.ts ↔ runtime.ts 的循环依赖。
 */
export type SdkCanUseToolHook = (
  toolName: string,
  input: Record<string, unknown>,
  extra: {
    suggestions?: unknown[]
    decisionReason?: string
    blockedPath?: string
    toolUseID?: string
    defaultToNo?: boolean
  }
) => Promise<{ behavior: 'allow'; updatedPermissions?: unknown[] } | { behavior: 'deny'; message: string; interrupt?: boolean }>

export interface AgentSessionHandle {
  readonly id: string
  readonly remoteSessionId: string | null
  prompt(input: PromptInput, onEvent: (event: AgentEvent) => void): Promise<void>
  cancel(): Promise<void>
  dispose(): Promise<void>
  /**
   * 会话是否已不可用（连接被杀 / 已 dispose）。
   * 取消路径用它判断"强杀后这个句柄还能不能复用"—— 不能的话运行时把它从会话表里摘掉，
   * 否则下一句提问还打在死句柄上（表现成"停止之后 Agent 就坏了"）。
   */
  isUsable?(): boolean
  setConfigOption?(optionId: string, value: string | boolean): Promise<void>
  /** 运行时切换授权模式（只有 SDK 通道支持） */
  setPermissionMode?(mode: 'manual' | 'plan' | 'edit' | 'auto'): Promise<void>
  /** 回退到某个用户消息之前的文件状态（只有 SDK 通道支持） */
  rewindFiles?(userMessageId: string, options?: { dryRun?: boolean }): Promise<unknown>
}

export interface AgentAdapter {
  readonly id: string
  readonly kind: AgentKind
  readonly protocol: AgentProtocol
  probe(): Promise<AgentCapability>
  start(options: SessionOptions, onEvent: (event: AgentEvent) => void): Promise<AgentSessionHandle>
}
