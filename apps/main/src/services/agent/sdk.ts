/**
 * 官方 Claude Agent SDK 通道 —— Claude Code 的**首选**接入方式（也是 VS Code 扩展自己走的路）。
 *
 * 本机实测（2026-10-02，SDK 0.3.286 + 自带 CLI 2.1.287）：
 *  - `query()` + 流式输入模式可跑通：普通对话、工具调用（Write）、斜杠命令下发、思考增量、用量统计；
 *  - `canUseTool(toolName, input, extra)` 会在需要授权时被调用，`extra.suggestions` 带"始终允许"规则；
 *  - `setPermissionMode()` / `setModel()` 可在**活动会话**上直接切换（自研 ACP 通道做不到）；
 *  - **必须** `settingSources: ['user']`：用户把 Claude Code 指到了第三方代理
 *    （`~/.claude/settings.json` 里的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 与模型映射）。
 *    传 `[]` 会把这些设置整份丢掉，表现为"Not logged in · Please run /login"——本轮踩过。
 *
 * 设计约束：
 *  - SDK 是 **ESM-only**（`"type": "module"`，入口 `sdk.mjs`）：主进程产物是 CJS，
 *    因此这里只能 **动态 import**，并且构建时必须把它排除在打包之外（见 electron.vite.config.ts）；
 *  - 权限**不在本文件判定**：`canUseTool` 回调交给运行时（`runtime.requestPermission`），
 *    由 `@logicreader/shared/permissions` 统一决定放行 / 拒绝 / 转人工；
 *  - 找不到 SDK 或找不到 CLI 都要**如实报错**，不要假装可用。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { diffTexts, revertHunks } from '@logicreader/shared'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { logMain } from '../../util/ipc'
import type {
  AgentAdapter,
  AgentCapability,
  AgentEvent,
  AgentSessionHandle,
  ModelOption,
  PermissionDetail,
  PromptInput,
  SdkCanUseToolHook,
  SessionOptions
} from './types'

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'

/** 界面上的四档授权模式。 */
export type UiPermissionMode = 'manual' | 'plan' | 'edit' | 'auto'
export type SdkPermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'auto'

/**
 * 界面档位 → SDK 授权模式。
 *
 * `auto` 用 `acceptEdits` 而**不是** `bypassPermissions`：
 * 这一档的产品承诺是"文件编辑放行 + 命令按安全检查决定"，
 * 而 `bypassPermissions` 会跳过 `canUseTool`（连危险命令都不会问人）——那是"完全不管"。
 */
export function toSdkPermissionMode(mode: UiPermissionMode | undefined | null): SdkPermissionMode {
  switch (mode) {
    case 'plan':
      return 'plan'
    case 'edit':
    case 'auto':
      return 'acceptEdits'
    case 'manual':
    default:
      return 'default'
  }
}

// ------------------------------------------------------------------ SDK 结构子集（只用得到这些字段）
interface SdkContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

/** supportedModels() 的条目（实测字段） */
export interface SdkModelInfo {
  value?: string
  resolvedModel?: string
  displayName?: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
}

interface SdkMessage {
  type?: string
  subtype?: string
  session_id?: string
  uuid?: string
  /** system/init 上带的是**当前真正在跑的模型**（别名已解析） */
  model?: string
  /** 这一轮回答的是哪条用户消息 —— 文件检查点（回退）的 id */
  user_message_uuid?: string
  parent_tool_use_id?: string | null
  message?: { content?: SdkContentBlock[]; usage?: Record<string, number> }
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } }
  result?: string
  stop_reason?: string | null
  is_error?: boolean
  usage?: Record<string, number>
  compact_metadata?: { trigger?: string }
  [key: string]: unknown
}

interface SdkQuery extends AsyncIterable<SdkMessage> {
  interrupt(): Promise<unknown>
  setPermissionMode(mode: SdkPermissionMode): Promise<void>
  setModel(model?: string): Promise<void>
  setMaxThinkingTokens(max: number | null): Promise<void>
  supportedModels(): Promise<SdkModelInfo[]>
  supportedCommands(): Promise<{ name?: string; description?: string }[]>
  getContextUsage(opts?: { detail?: 'summary' | 'full' }): Promise<unknown>
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<unknown>
  initializationResult(): Promise<Record<string, unknown>>
  close(): void
}

interface SdkUserMessage {
  type: 'user'
  message: { role: 'user'; content: string | Record<string, unknown>[] }
  parent_tool_use_id: null
}

interface SdkModule {
  query(options: { prompt: string | AsyncIterable<SdkUserMessage>; options?: Record<string, unknown> }): SdkQuery
  /** 列过去的会话（按 lastModified 倒序）；dir 限定项目目录 */
  listSessions?(options?: { dir?: string; limit?: number; includeWorktrees?: boolean }): Promise<SdkSessionInfo[]>
  getSessionMessages?(sessionId: string, options?: Record<string, unknown>): Promise<unknown[]>
}

/** listSessions() 的返回项（官方文档字段） */
export interface SdkSessionInfo {
  sessionId: string
  summary?: string
  lastModified?: number
  customTitle?: string
  firstPrompt?: string
  cwd?: string
  gitBranch?: string
  createdAt?: number
}

/** 运行时注入的权限回调（形状定义在 types.ts，避免循环依赖）。 */
export type SdkCanUseTool = SdkCanUseToolHook

export interface SdkAdapterOptions {
  id: string
  displayName?: string
  /** 用户配置的可执行文件；为空则用 SDK 自带的原生 CLI */
  executable?: string | null
  /** 权限回调（由运行时提供；缺省时一律拒绝，避免"静默放行"） */
  canUseTool?: SdkCanUseTool
  /** 是否加载用户的 Claude Code 设置（默认 true：代理地址/鉴权/技能都在那里） */
  useUserSettings?: boolean
}

// ------------------------------------------------------------------ 模块加载与可执行文件解析
let cached: { module: SdkModule | null; error: string | null } | null = null

/** 动态加载 SDK（ESM-only）。失败时把**原始错误**带出去。 */
export async function loadSdk(): Promise<{ module: SdkModule | null; error: string | null }> {
  if (cached) return cached
  try {
    const imported = (await import(/* @vite-ignore */ SDK_PACKAGE)) as unknown as SdkModule & { default?: SdkModule }
    const module = typeof imported.query === 'function' ? imported : imported.default ?? null
    cached = module ? { module, error: null } : { module: null, error: SDK_PACKAGE + ' 没有导出 query()' }
  } catch (error) {
    cached = { module: null, error: error instanceof Error ? error.message : String(error) }
    logMain('warn', 'agent', SDK_PACKAGE + ' 不可用：' + cached.error)
  }
  return cached
}

export function resetSdkCache(): void {
  cached = null
}

/**
 * 列某个工作目录下的历史会话（最近优先）。
 *
 * 说明：这些是 CLI 自己持久化的会话记录（\`~/.claude/projects/<munge 后的 cwd>/\`），
 * 与 VS Code 扩展共用同一份数据 —— 也就是说用户在 VS Code 里聊过的会话，
 * 在我们的"历史会话"里也能看到并续聊（这正是我们要的对齐效果）。
 */
export async function listSessionsFor(dir: string, limit = 30): Promise<SdkSessionInfo[]> {
  const loaded = await loadSdk()
  const list = loaded.module?.listSessions
  if (!list) return []
  try {
    const sessions = await list({ dir, limit })
    return Array.isArray(sessions) ? sessions : []
  } catch (error) {
    logMain('warn', 'agent', '列历史会话失败：' + String(error))
    return []
  }
}

/** 读回放用的消息视图（与渲染端 ChatMessage 的最小公共形状）。 */
export interface SessionTranscriptEntry {
  role: 'user' | 'assistant'
  text: string
  thinking: string
  at: number
}

interface SdkSessionMessageLike {
  type?: unknown
  uuid?: unknown
  session_id?: unknown
  message?: { role?: unknown; content?: unknown } | null
}

/**
 * 读一个历史会话的**全部对话**（官方 `getSessionMessages`，与本机 JSONL 同源）。
 * 只保留 user / assistant 的文本与思考块（工具调用块不进回放视图 —— 回看对话要的是内容，不是过程行）。
 * 会话不存在 / 字段缺失时返回空数组，调用方给"看不到回放"的提示而不是报错。
 */
export async function readSessionTranscript(sessionId: string, dir?: string | null, limit = 200): Promise<SessionTranscriptEntry[]> {
  const loaded = await loadSdk()
  const reader = (loaded.module as { getSessionMessages?: (id: string, options?: Record<string, unknown>) => Promise<unknown[]> } | null)
    ?.getSessionMessages
  if (!reader) return []
  try {
    const messages = await reader(sessionId, { dir: dir ?? undefined, limit, includeSystemMessages: false })
    if (!Array.isArray(messages)) return []
    const entries: SessionTranscriptEntry[] = []
    for (const raw of messages as SdkSessionMessageLike[]) {
      const type = String(raw.type ?? '')
      if (type !== 'user' && type !== 'assistant') continue
      const message = raw.message ?? {}
      const content = message.content
      let text = ''
      let thinking = ''
      if (typeof content === 'string') {
        text = content.trim()
      } else if (Array.isArray(content)) {
        const parts = content as { type?: unknown; text?: unknown; thinking?: unknown }[]
        text = parts
          .filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => String(part.text))
          .join('\n')
          .trim()
        thinking = parts
          .filter((part) => part?.type === 'thinking' && typeof part.thinking === 'string')
          .map((part) => String(part.thinking))
          .join('\n')
          .trim()
      }
      if (text.length === 0 && thinking.length === 0) continue
      entries.push({ role: type === 'user' ? 'user' : 'assistant', text, thinking, at: 0 })
    }
    return entries
  } catch (error) {
    logMain('debug', 'agent', '读会话回放失败：' + String(error))
    return []
  }
}

/** 删除一个历史会话（官方 `deleteSession`：删本机 JSONL 与子代理记录目录）。 */
export async function deleteSdkSession(sessionId: string, dir?: string | null): Promise<boolean> {
  const loaded = await loadSdk()
  const deleter = (loaded.module as { deleteSession?: (id: string, options?: Record<string, unknown>) => Promise<void> } | null)
    ?.deleteSession
  if (!deleter) return false
  try {
    await deleter(sessionId, { dir: dir ?? undefined })
    logMain('info', 'agent', '已删除历史会话：' + sessionId)
    return true
  } catch (error) {
    logMain('warn', 'agent', '删除历史会话失败：' + String(error))
    return false
  }
}

/**
 * SDK 自带的原生 CLI（平台可选依赖）。
 * 布局：`node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`
 * （pnpm 下是 .pnpm 里的符号链接结构，用 createRequire 解析真实路径）。
 */
export function findBundledCli(): string | null {
  const platform = process.platform
  const arch = process.arch
  const binary = platform === 'win32' ? 'claude.exe' : 'claude'
  const candidates: string[] = []
  /**
   * 打包后：CLI 被 electron-builder 放到 `resources/claude-cli`（asar 外）。
   * 这一步必须在前，因为打包产物里 node_modules 已经进 asar 了，解析不到原生二进制。
   */
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    candidates.push(join(resourcesPath, 'claude-cli', binary))
    candidates.push(join(resourcesPath, 'claude-cli', platform + '-' + arch, binary))
    candidates.push(join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-' + platform + '-' + arch, binary))
  }
  try {
    const require = createRequire(import.meta.url)
    const entry = require.resolve(SDK_PACKAGE) // …/@anthropic-ai/claude-agent-sdk/sdk.mjs
    /**
     * 平台子包与 SDK 是**兄弟目录**：pnpm 下实际布局是
     * `node_modules/.pnpm/<sdk>@x/node_modules/@anthropic-ai/{claude-agent-sdk, claude-agent-sdk-win32-x64}`，
     * 所以要从入口文件上跳两级取 scope，再拼平台子包名（本机实测过一次才确认）。
     */
    const scope = dirname(dirname(entry))
    candidates.push(
      join(scope, 'claude-agent-sdk-' + platform + '-' + arch, binary),
      join(dirname(entry), '..', 'claude-agent-sdk-' + platform + '-' + arch, binary),
      join(dirname(entry), 'vendor', binary)
    )
  } catch (error) {
    logMain('debug', 'agent', '定位自带 CLI 失败：' + String(error))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 从 PreToolUse 的 hook 载荷里取"要改哪个文件"。
 *
 * 实测（本机 SDK 0.3.286）载荷形状：
 * `{ session_id, cwd, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path, content }, tool_use_id }`
 * —— 路径在 **tool_input.file_path** 里，顶层没有 file_path。
 * 同时兼容顶层形状（不同 SDK 版本/其它 hook 事件），避免升级后静默失效。
 */
export function baselinePathOf(input: Record<string, unknown> | null | undefined): string | null {
  if (!input) return null
  const nested = (input.tool_input ?? null) as Record<string, unknown> | null
  const candidates = [nested?.file_path, nested?.notebook_path, input.file_path, input.notebook_path]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return null
}

/**
 * 读文件内容（用于抓基线与算差异）。
 * 读不到就返回 null：新建文件本来就"之前不存在"，二进制/无权限也不该让流程失败。
 */
async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ 消息翻译
export interface TurnState {
  sawStreamDelta: boolean
  tools: Map<string, { name: string; title: string }>
  /** 本轮助手已经吐出的正文（按到达顺序拼接）：ExitPlanMode 的"方案"就是它前面的那段文字 */
  text: string
  /**
   * 当前事件属于哪个子代理（`parent_tool_use_id`）。
   * 子代理的工具调用与主线程**共用一个消息流**，只能靠这个字段区分；为空表示主线程自己的调用。
   */
  parentToolUseId?: string | null
  /** 文件改动完成的回调（由会话注入：算差异 + 广播）。不注入时只翻译文本与工具卡片。 */
  onFileDiff?: (toolUseId: string) => void
  /** 用户消息 uuid（检查点）：由会话注入后才会出现在流里 */
  onCheckpoint?: (userMessageId: string) => void
}

export function newTurn(
  onFileDiff?: (toolUseId: string) => void,
  onCheckpoint?: (userMessageId: string) => void
): TurnState {
  return { sawStreamDelta: false, tools: new Map(), text: '', onFileDiff, onCheckpoint }
}

function usageFrom(raw: Record<string, number> | undefined): { inputTokens: number; outputTokens: number } | null {
  if (!raw) return null
  const input = (raw.input_tokens ?? 0) + (raw.cache_read_input_tokens ?? 0) + (raw.cache_creation_input_tokens ?? 0)
  const output = raw.output_tokens ?? 0
  if (input === 0 && output === 0) return null
  return { inputTokens: input, outputTokens: output }
}

/** 工具调用的"人话标题"：优先命令 / 路径。 */
export function toolTitle(name: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>
    for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
      const value = record[key]
      if (typeof value === 'string' && value.length > 0) return value.length > 120 ? value.slice(0, 120) + '…' : value
    }
  }
  return name
}

function emitBlocks(
  blocks: SdkContentBlock[] | undefined,
  emit: (event: AgentEvent) => void,
  state: TurnState,
  complete: boolean
): void {
  if (!Array.isArray(blocks)) return
  for (const block of blocks) {
    const type = String(block?.type ?? '')
    if (type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      // 增量已经吐过就不再重复（与 CLI 适配层同一策略）
      if (complete && state.sawStreamDelta) continue
      state.text += block.text
      emit({ type: 'text-delta', text: block.text })
    } else if (type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) {
      if (complete && state.sawStreamDelta) continue
      emit({ type: 'thinking', text: block.thinking })
    } else if (type === 'tool_use') {
      const id = String(block.id ?? '')
      const name = String(block.name ?? 'tool')
      const title = toolTitle(name, block.input)
      state.tools.set(id, { name, title })
      // 子代理发起的调用带 parent_tool_use_id：界面据此把它的过程折叠成一行
      emit({
        type: 'tool-call',
        id,
        name,
        input: block.input ?? null,
        title,
        ...(state.parentToolUseId ? { parentId: state.parentToolUseId } : {})
      })
    } else if (type === 'tool_result') {
      const id = String(block.tool_use_id ?? '')
      emit({
        type: 'tool-result',
        id,
        name: state.tools.get(id)?.name ?? 'tool',
        output: block.content ?? null,
        isError: block.is_error === true
      })
      // 文件改动完成 → 算差异（"内联 diff 审阅"的数据源）
      if (!block.is_error) state.onFileDiff?.(id)
    }
  }
}

/** 把 SDK 消息翻译成我们的 AgentEvent。导出让单测可以直接喂消息。 */
export function translateMessage(message: SdkMessage, emit: (event: AgentEvent) => void, state: TurnState): void {
  switch (message.type) {
    case 'stream_event': {
      const event = message.event ?? {}
      const delta = event.delta ?? {}
      if (event.type !== 'content_block_delta') break
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
        state.sawStreamDelta = true
        state.text += delta.text
        emit({ type: 'text-delta', text: delta.text })
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
        state.sawStreamDelta = true
        emit({ type: 'thinking', text: delta.thinking })
      }
      break
    }
    case 'assistant': {
      // 记下这条消息来自哪个子代理（主线程为 null）
      state.parentToolUseId = message.parent_tool_use_id ?? null
      /**
       * 检查点 id：SDK 会在这一轮的助手消息上带 `user_message_uuid`，
       * 它就是这次改动所属的用户消息 —— `rewindFiles()` 要的正是它。
       * （不去开 replay-user-messages，那个会把别的会话的消息一起回放，见上面的注释。）
       */
      const checkpointId = typeof message.user_message_uuid === 'string' ? message.user_message_uuid : null
      if (checkpointId) state.onCheckpoint?.(checkpointId)
      emitBlocks(message.message?.content, emit, state, true)
      const usage = usageFrom(message.message?.usage)
      if (usage) emit({ type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens })
      break
    }
    case 'user': {
      state.parentToolUseId = message.parent_tool_use_id ?? null
      /**
       * 回放的用户消息带 uuid —— 它就是 rewindFiles 要的检查点 id。
       * 只认"真的用户消息"（内容为字符串），工具结果也走这个 type，别混进来。
       */
      const content = message.message?.content
      if (typeof content === 'string' && typeof message.uuid === 'string') {
        state.onCheckpoint?.(message.uuid)
      } else {
        // 工具结果以 user 消息回放
        emitBlocks(Array.isArray(content) ? content : undefined, emit, state, false)
      }
      break
    }
    case 'system': {
      if (message.subtype === 'init') {
        emit({
          type: 'session',
          remoteSessionId: message.session_id ?? null,
          resumed: false,
          // 实际运行的模型：换 API / 换别名映射后，这是界面上唯一可信的"现在是谁"
          ...(message.model ? { activeModel: String(message.model) } : {})
        })
      } else if (message.subtype === 'compact_boundary') {
        emit({
          type: 'plan',
          entries: [{ content: '上下文已压缩', status: String(message.compact_metadata?.trigger ?? 'auto') }]
        })
      }
      break
    }
    case 'result': {
      const usage = usageFrom(message.usage)
      if (usage) emit({ type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens })
      if (message.is_error) {
        emit({ type: 'error', message: String(message.result ?? '运行失败'), retryable: true })
      } else {
        /**
         * 兜底：`result.result` 是官方 SDK 的"本轮最终正文"。
         * 正常流里 assistant 正文块 / 流式增量已经吐过（state.text 非空），这里就不再补；
         * 但少数代理/版本只把它放在 result 里，此时若不补，一次性任务（runOnce）会拿到空文本。
         */
        if (state.text.length === 0 && !state.sawStreamDelta && typeof message.result === 'string' && message.result.length > 0) {
          state.text += message.result
          emit({ type: 'text-delta', text: message.result })
        }
        emit({ type: 'done', stopReason: String(message.stop_reason ?? message.subtype ?? 'end_turn') })
      }
      break
    }
    default:
      break
  }
}

/**
 * 组装 SDK 的 query 选项：**纯函数**，便于单测断言"分叉/续聊"这类关键开关。
 *
 * 会话恢复/分叉三个开关的关系（官方 SDK）：
 *  - `resume`：接上一个已有会话（追加历史）；
 *  - `forkSession`：**复制**已有会话的历史开一个新会话，原会话不动；
 *  - `resumeSessionAt`：从某个用户消息处开始（配合 resume/fork 做"从这条消息分叉"）。
 */
export function buildQueryOptions(input: {
  cwd: string
  permissionMode: SdkPermissionMode
  canUseTool: (toolName: string, input: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown>
  settingSources: string[]
  executablePath?: string | null
  resumeSessionId?: string | null
  forkSession?: boolean
  resumeSessionAt?: string | null
  modelId?: string | null
  thinkingEffort?: string | null
  hooks?: Record<string, unknown>
  allowedTools?: string[]
  /** 一次性任务（无人值守）关掉全部内置工具：SDK 的 `tools: []` */
  disableTools?: boolean
}): Record<string, unknown> {
  const options: Record<string, unknown> = {
    cwd: input.cwd,
    permissionMode: input.permissionMode,
    canUseTool: input.canUseTool,
    includePartialMessages: true,
    /**
     * 只读工具交给 SDK 自己放行（工作目录内的读取本来就不该打扰用户）。
     * 这样 `canUseTool` 只会在**写文件 / 执行命令**时回调，
     * 与 VS Code 扩展的形态一致：授权卡片只出现在真正要紧的操作上。
     */
    allowedTools: input.allowedTools ?? ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'ToolSearch', 'TodoWrite', 'Task'],
    // 默认加载用户设置：代理地址、鉴权令牌、模型映射、技能都在 ~/.claude/settings.json 里
    settingSources: input.settingSources,
    env: { ...process.env },
    abortController: new AbortController(),
    /**
     * 文件检查点：SDK 会在每个用户消息处给文件做快照，
     * 之后可以用 rewindFiles(userMessageId) 回退 —— 这是"改错了能撤"的基础。
     */
    enableFileCheckpointing: true
  }
  if (input.executablePath) options.pathToClaudeCodeExecutable = input.executablePath
  if (input.resumeSessionId) options.resume = input.resumeSessionId
  if (input.forkSession) options.forkSession = true
  if (input.resumeSessionAt) options.resumeSessionAt = input.resumeSessionAt
  if (input.modelId && input.modelId !== 'default') options.model = input.modelId
  if (input.thinkingEffort && input.thinkingEffort !== 'off') options.effort = input.thinkingEffort
  if (input.hooks) options.hooks = input.hooks
  /**
   * `tools: []` 是 SDK 的"禁用全部内置工具"（见 sdk.d.ts 的 tools 注释）。
   * 一次性抽取任务要的是"一次回答"，不是"一次施工"：模型手里有 Write/Bash 时会先想着落地文件，
   * 而工作区写权限默认关闭 → 权限卡片转到"人"（一次性任务根本没有人在看）→ 一直等到分块超时。
   */
  if (input.disableTools) options.tools = []
  return options
}

// ------------------------------------------------------------------ 会话
interface SdkSessionDeps {
  sessionId: string
  options: SessionOptions
  module: SdkModule
  emit: (event: AgentEvent) => void
  canUseTool: SdkCanUseTool
  executablePath: string | null
  settingSources: string[]
}

class SdkSession implements AgentSessionHandle {
  readonly id: string
  private query: SdkQuery
  private remoteId: string | null = null
  private state: TurnState
  private queue: SdkUserMessage[] = []
  private wake: (() => void) | null = null
  private disposed = false
  private pumping: Promise<void>
  private mode: SdkPermissionMode
  /**
   * 改动前的文件内容（按 toolUseID）。
   * 由 PreToolUse hook 在 Edit/Write 真正执行**之前**抓取 —— 这正是 VS Code 扩展
   * 做内联 diff 的做法（它的 hook 名就叫 captureBaseline）：只有拿到"改之前"，
   * 才能既算出差异、又留住可回退的那一份。
   */
  /** system/init 报出的实际运行模型（别名已解析） */
  private activeModelName: string | null = null
  private baselines = new Map<string, { path: string; before: string | null }>()
  /**
   * 已算过差异的改动：toolUseId → { 路径, 基线, 改动后, 差异块 }。
   * 逐块回退要用它重建内容（见 shared/patch.ts）。只留最近 20 条，避免长会话把内存吃掉。
   */
  private appliedEdits = new Map<
    string,
    { path: string; before: string; after: string; hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; rows: { kind: string; oldLine: number | null; newLine: number | null; text: string }[] }[] }
  >()

  constructor(private readonly deps: SdkSessionDeps) {
    this.id = deps.sessionId
    this.mode = toSdkPermissionMode(deps.options.permissionMode)
    this.state = newTurn(
      (toolUseId) => this.emitDiff(toolUseId),
      (userMessageId) => deps.emit({ type: 'checkpoint', userMessageId })
    )
    /**
     * 注意：**不要**开 `replay-user-messages`。
     * 官方 checkpointing 文档建议用它来拿用户消息 uuid，但本机实测它会把**别的会话**的
     * 用户消息一起回放进上下文 —— 模型于是答非所问（问 A 文件，它去读桌面上的 B 文件）。
     * 检查点 id 改用 SDK 自己随流下发的 `user_message_uuid`（见 translateMessage 的 assistant 分支）。
     */
    const options = buildQueryOptions({
      cwd: deps.options.cwd,
      permissionMode: this.mode,
      canUseTool: (toolName, input, extra) => deps.canUseTool(toolName, input, extra),
      settingSources: deps.settingSources,
      executablePath: deps.executablePath,
      resumeSessionId: deps.options.resumeSessionId,
      forkSession: deps.options.forkSession,
      resumeSessionAt: deps.options.resumeSessionAt,
      modelId: deps.options.modelId,
      thinkingEffort: deps.options.thinkingEffort,
      disableTools: deps.options.disableTools === true,
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write|Edit|MultiEdit|NotebookEdit',
            hooks: [
              async (input: Record<string, unknown>, toolUseID?: string): Promise<Record<string, unknown>> => {
                await this.captureBaseline(input, toolUseID)
                return {}
              }
            ]
          }
        ]
      }
    })
    const prompt = (async function* (session: SdkSession): AsyncGenerator<SdkUserMessage> {
      while (!session.isDisposed()) {
        const next = session.take()
        if (!next) {
          await session.waitForInput()
          continue
        }
        yield next
      }
    })(this)
    this.query = deps.module.query({ prompt, options })
    this.pumping = this.pump()
  }

  /** PreToolUse：把"改之前"的内容存下来（按 toolUseID）。 */
  private async captureBaseline(input: Record<string, unknown>, toolUseID?: string): Promise<void> {
    const path = baselinePathOf(input)
    if (!path || !toolUseID) return
    const before = await readFileSafe(path)
    this.baselines.set(toolUseID, { path, before })
    logMain('debug', 'agent', '已抓取改动前基线：' + path + '（' + (before === null ? '新文件' : before.length + ' 字符') + '）')
  }

  /**
   * 工具结果回来后算差异并广播。
   * 只处理确实改动了文件的工具；算不出差异（文件太大 / 二进制）就静默跳过 ——
   * diff 是"加分项"，不该因为它失败让工具卡片显示成错误。
   */
  private emitDiff(id: string): void {
    const baseline = this.baselines.get(id)
    if (!baseline) return
    this.baselines.delete(id)
    void (async () => {
      const after = (await readFileSafe(baseline.path)) ?? ''
      const before = baseline.before ?? ''
      if (before === after) return
      try {
        const diff = diffTexts(before, after)
        if (!diff) return
        if (diff.hunks.length > 0) {
          this.appliedEdits.set(id, {
            path: baseline.path,
            before,
            after,
            hunks: diff.hunks.map((hunk) => ({
              oldStart: hunk.oldStart,
              oldLines: hunk.oldLines,
              newStart: hunk.newStart,
              newLines: hunk.newLines,
              rows: hunk.rows.map((row) => ({
                kind: row.kind,
                oldLine: row.oldLine,
                newLine: row.newLine,
                text: row.text
              }))
            }))
          })
          // 只留最近 20 次改动
          while (this.appliedEdits.size > 20) {
            const oldest = this.appliedEdits.keys().next().value
            if (oldest === undefined) break
            this.appliedEdits.delete(oldest)
          }
        }
        this.deps.emit({
          type: 'tool-diff',
          diff: {
            toolUseId: id,
            filePath: baseline.path,
            additions: diff.additions,
            deletions: diff.deletions,
            hunks: diff.hunks.map((hunk) => ({
              oldStart: hunk.oldStart,
              oldLines: hunk.oldLines,
              newStart: hunk.newStart,
              newLines: hunk.newLines,
              rows: hunk.rows.map((row) => ({
                kind: row.kind,
                oldLine: row.oldLine,
                newLine: row.newLine,
                text: row.text
              }))
            })),
            truncated: diff.truncated
          }
        })
      } catch (error) {
        logMain('debug', 'agent', '算差异失败：' + String(error))
      }
    })()
  }

  isDisposed(): boolean {
    return this.disposed
  }

  get remoteSessionId(): string | null {
    return this.remoteId
  }

  private take(): SdkUserMessage | null {
    return this.queue.shift() ?? null
  }

  private waitForInput(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve
    })
  }

  private async pump(): Promise<void> {
    try {
      for await (const message of this.query) {
        if (message.type === 'system' && message.subtype === 'init') {
          if (message.session_id) this.remoteId = String(message.session_id)
          const active = typeof message.model === 'string' && message.model.length > 0 ? message.model : null
          if (active) {
            this.activeModelName = active
            logMain('info', 'agent', '本会话实际运行模型：' + active)
          }
        }
        translateMessage(message, this.deps.emit, this.state)
      }
    } catch (error) {
      if (!this.disposed) {
        this.deps.emit({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
          retryable: true
        })
      }
    }
  }

  async prompt(input: PromptInput): Promise<void> {
    if (this.disposed) throw new Error('会话已关闭')
    this.state = newTurn(
      (toolUseId) => this.emitDiff(toolUseId),
      (userMessageId) => this.deps.emit({ type: 'checkpoint', userMessageId })
    )
    const text = input.systemContext ? input.systemContext + '\n\n' + input.text : input.text
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
    const wake = this.wake
    this.wake = null
    wake?.()
  }

  async cancel(): Promise<void> {
    try {
      await this.query.interrupt()
    } catch (error) {
      logMain('warn', 'agent', 'SDK 中断失败：' + String(error))
    }
  }

  async setPermissionMode(mode: UiPermissionMode): Promise<void> {
    const next = toSdkPermissionMode(mode)
    if (next === this.mode) return
    this.mode = next
    await this.query.setPermissionMode(next)
    this.deps.emit({ type: 'mode-changed', mode: next })
    logMain('info', 'agent', 'SDK 授权模式已切换：' + next)
  }

  async setConfigOption(optionId: string, value: string | boolean): Promise<void> {
    if (optionId === 'model' && typeof value === 'string') {
      await this.query.setModel(value === 'default' ? undefined : value)
    }
  }

  async rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<unknown> {
    return this.query.rewindFiles(userMessageId, options)
  }

  supportedModels(): Promise<SdkModelInfo[]> {
    return this.query.supportedModels()
  }

  supportedCommands(): Promise<{ name?: string; description?: string }[]> {
    return this.query.supportedCommands()
  }

  contextUsage(): Promise<unknown> {
    return this.query.getContextUsage({ detail: 'summary' })
  }

  async initialization(): Promise<Record<string, unknown>> {
    return this.query.initializationResult()
  }

  /**
   * 斜杠命令清单。
   * 从 `initializationResult().commands` 取（实测这个字段有 name/description/argumentHint），
   * 取不到再退到 `supportedCommands()` —— 后者在不同版本上字段名可能不同。
   */
  /** 本轮到目前为止的助手正文（计划模式下就是"方案"）。 */
  currentTurnText(): string {
    return this.state.text
  }

  /**
   * 当前真正在跑的模型。
   * `system/init.model` 给的是**解析后**的名字：用户选 `sonnet`、实际跑 GLM-5.3-Flash 时，
   * 这里就是 `GLM-5.3-Flash` —— 换 API 之后这是唯一能让用户确认"现在是谁在回答"的来源。
   */
  activeModel(): string | null {
    return this.activeModelName
  }

  /**
   * 逐块回退：把某次改动里指定的块恢复成改动前的内容，其余块保持不动。
   * 冲突（文件在改动后又被改过）时**不写盘**，把原因带回去。
   */
  async revertHunksOf(
    toolUseId: string,
    indices: number[]
  ): Promise<{ ok: boolean; content?: string; conflict?: string }> {
    const edit = this.appliedEdits.get(toolUseId)
    if (!edit) return { ok: false, conflict: '找不到这次改动的基线（可能已超出保留范围）' }
    const current = (await readFileSafe(edit.path)) ?? ''
    const result = revertHunks(edit.before, edit.after, current, edit.hunks, indices)
    if (!result.ok) {
      logMain('warn', 'agent', '逐块回退被拒：' + String(result.conflict) + ' :: ' + edit.path)
      return { ok: false, conflict: result.conflict }
    }
    try {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(edit.path, result.content, 'utf8')
    } catch (error) {
      return { ok: false, conflict: '写入失败：' + String(error) }
    }
    // 回退后这次改动的"当前状态"变了：更新记录，允许继续回退其它块
    edit.after = result.content
    logMain('info', 'agent', '逐块回退完成：' + edit.path + ' 回退 ' + indices.length + ' 块')
    return { ok: true, content: result.content }
  }

  async commands(): Promise<{ name: string; description?: string; argumentHint?: string }[]> {
    const normalize = (list: unknown): { name: string; description?: string; argumentHint?: string }[] => {
      if (!Array.isArray(list)) return []
      return list
        .map((item) => {
          const record = (item ?? {}) as Record<string, unknown>
          return {
            name: String(record.name ?? ''),
            description: record.description ? String(record.description) : undefined,
            argumentHint: record.argumentHint ? String(record.argumentHint) : undefined
          }
        })
        .filter((item) => item.name.length > 0)
    }
    try {
      const init = await this.query.initializationResult()
      const fromInit = normalize((init as { commands?: unknown })?.commands)
      if (fromInit.length > 0) return fromInit
    } catch (error) {
      logMain('debug', 'agent', '从 initializationResult 取命令失败：' + String(error))
    }
    try {
      return normalize(await this.query.supportedCommands())
    } catch {
      return []
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const wake = this.wake
    this.wake = null
    wake?.()
    try {
      this.query.close()
    } catch {
      /* 已退出 */
    }
    await Promise.race([this.pumping, new Promise((resolve) => setTimeout(resolve, 1500))]).catch(() => undefined)
  }
}

// ------------------------------------------------------------------ 适配器
export class SdkAdapter implements AgentAdapter {
  readonly id: string
  readonly kind = 'claude-code' as const
  readonly protocol = 'sdk' as const
  private readonly displayName: string
  private readonly configuredExecutable: string | null
  private readonly canUseTool: SdkCanUseTool
  private readonly settingSources: string[]

  constructor(options: SdkAdapterOptions) {
    this.id = options.id
    this.displayName = options.displayName ?? 'Claude Code'
    this.configuredExecutable = options.executable ?? null
    this.canUseTool =
      options.canUseTool ??
      (async () => ({ behavior: 'deny', message: '运行时未提供权限回调' }) as const)
    this.settingSources = options.useUserSettings === false ? [] : ['user']
  }

  /** 解析实际使用的 CLI：用户配置 > SDK 自带 > PATH 上的 claude。 */
  private resolveExecutable(): { path: string | null; source: string } {
    if (this.configuredExecutable && existsSync(this.configuredExecutable)) {
      return { path: this.configuredExecutable, source: '配置' }
    }
    const bundled = findBundledCli()
    if (bundled) return { path: bundled, source: 'SDK 自带' }
    return { path: null, source: 'SDK 默认查找' }
  }

  async probe(): Promise<AgentCapability> {
    const loaded = await loadSdk()
    const resolved = this.resolveExecutable()
    const available = Boolean(loaded.module)
    let version: string | null = null
    let models: ModelOption[] = FALLBACK_MODELS
    if (available) {
      // 想拿真实模型清单就要起一个会话（SDK 只提供 supportedModels()）。
      // 探测阶段不建进程：先给兜底清单，真正建会话时由 supportedModels() 覆盖。
      logMain('info', 'agent', 'Claude Agent SDK 可用；CLI 来源=' + resolved.source + ' 路径=' + String(resolved.path))
    }
    return {
      id: this.id,
      kind: 'claude-code',
      displayName: this.displayName,
      protocol: 'sdk',
      available,
      version,
      executable: resolved.path,
      launchArgs: [],
      supportsAcp: false,
      supportsSdk: true,
      supportsResume: true,
      supportsStreaming: true,
      supportsModel: true,
      supportsThoughtLevel: true,
      supportsPermissionModeSwitch: true,
      models,
      configOptions: [],
      defaultModel: 'default',
      // 思考强度由 SDK 逐模型声明（`supportedEffortLevels`），会话建立后再刷新
      defaultThoughtLevel: null,
      error: loaded.error,
      probedAt: Date.now(),
      builtin: true
    }
  }

  async start(options: SessionOptions, onEvent: (event: AgentEvent) => void): Promise<AgentSessionHandle> {
    const loaded = await loadSdk()
    if (!loaded.module) throw new Error('Claude Agent SDK 不可用：' + (loaded.error ?? '未知原因'))
    const resolved = this.resolveExecutable()
    return new SdkSession({
      sessionId: options.sessionId ?? this.id,
      options,
      module: loaded.module,
      emit: onEvent,
      // 会话级回调优先（运行时注入，带该会话的授权模式与工作区），否则用适配器默认（拒绝一切）
      canUseTool: options.canUseTool ?? this.canUseTool,
      executablePath: resolved.path,
      settingSources: options.settingSources ?? this.settingSources
    })
  }
}

/** 会话句柄的能力扩展（运行时用来做模型清单 / 斜杠命令 / 上下文用量）。 */
export interface SdkCapableHandle extends AgentSessionHandle {
  supportedModels?: () => Promise<SdkModelInfo[]>
  supportedCommands?: () => Promise<{ name?: string; description?: string }[]>
  /** 斜杠命令清单（含用户技能） */
  commands?: () => Promise<{ name: string; description?: string; argumentHint?: string }[]>
  /** 本轮助手正文（ExitPlanMode 的"方案"文本来源） */
  currentTurnText?: () => string
  /** 该会话当前真正在跑的模型（来自 `system/init.model`，别名已由 CLI 解析） */
  activeModel?: () => string | null
  /** 逐块回退：把 toolUseId 这次改动的指定块恢复成改动前的内容 */
  revertHunksOf?: (toolUseId: string, indices: number[]) => Promise<{ ok: boolean; content?: string; conflict?: string }>
  contextUsage?: () => Promise<unknown>
  initialization?: () => Promise<Record<string, unknown>>
}

export function asSdkHandle(handle: AgentSessionHandle): SdkCapableHandle | null {
  return handle instanceof SdkSession ? (handle as SdkCapableHandle) : null
}

/**
 * 兜底模型清单：只在拿不到 `supportedModels()` 时用。
 * 注意：用户把 Claude Code 指向第三方代理时，真实模型名来自设置（如 GLM-5.3 / Kimi-K3），
 * 所以这里只给"档位别名"，真正的清单在会话建立后刷新。
 */
const FALLBACK_MODELS: ModelOption[] = [
  { id: 'default', name: '默认（跟随 Claude Code 配置）' },
  { id: 'opus', name: 'Opus（映射到代理的 opus 档）' },
  { id: 'sonnet', name: 'Sonnet（映射到代理的 sonnet 档）' },
  { id: 'haiku', name: 'Haiku（映射到代理的 haiku 档）' }
]

/** 供权限卡片使用：把 SDK 的 canUseTool 参数整理成我们的事件结构。 */
export function toPermissionDetail(
  toolName: string,
  input: Record<string, unknown>,
  extra: {
    suggestions?: unknown[]
    decisionReason?: string
    blockedPath?: string
    /** 这次是"请用户决定"（SDK 闸门已经放行到人工环节），桥接层不要再算一遍策略 */
    userDecisionRequired?: boolean
  }
): PermissionDetail {
  const isWrite = /^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(toolName)
  const isPlan = toolName === 'ExitPlanMode'
  const kind = isPlan ? 'plan' : isWrite ? 'write' : toolName === 'Bash' ? 'execute' : 'other'
  return {
    title: isPlan ? '计划待确认' : toolTitle(toolName, input),
    kind,
    rawInput: input,
    options: [
      { optionId: 'allow_once', name: '允许一次', kind: 'allow_once' },
      { optionId: 'allow_always', name: '始终允许此类', kind: 'allow_always' },
      { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' }
    ],
    suggestions: extra.suggestions,
    reason: extra.decisionReason,
    blockedPath: extra.blockedPath,
    userDecisionRequired: extra.userDecisionRequired
  }
}
