/**
 * Codex 官方 **app-server** 通道 —— Codex 的首选接入方式。
 *
 * 为什么换掉原来的方案：
 *  早期实现是"每次提问 spawn 一个 `codex exec --json`"（见 cli.ts 的 `CLI_SPECS.codex`）。
 *  那是一次性子进程：一个回合一个进程、没有会话级控制通道，于是
 *  —— 切模型 / 切思考强度只能靠命令行参数，改了要重开进程；
 *  —— 中断只能杀进程树（模型那边不知道被中断）；
 *  —— 审批往返没有出口（只有 `--sandbox read-only` 一刀切，Agent 想写就写不了）；
 *  —— 拿不到真实模型清单，界面只能显示硬编码兜底；
 *  —— 历史线程、子代理、计划（plan）这些信息在 `--json` 流里根本没有。
 *
 * 换成的方案是 Codex CLI 自带的 `codex app-server`：官方出品的常驻 JSON-RPC 服务
 * （stdio + 换行分隔报文），**Codex VS Code 扩展走的就是这条路**。
 * 协议字段全部以官方 `codex app-server generate-json-schema` 导出的 schema 与
 * 本机实测报文为准（见下方每个分支的注释）。
 *
 * 通道能力（与 Claude 的官方 SDK 通道对齐）：
 *  - `thread/start` / `thread/resume` / `thread/fork`：建线程、续聊、分叉；
 *  - `turn/start`：每个回合可覆盖 model / effort，不用重开进程；
 *  - `turn/interrupt`：优雅中断当前回合；
 *  - `item/agentMessage/delta`、`item/reasoning/*Delta`：正文与思考的流式增量；
 *  - `item/started` / `item/completed`：命令执行、文件改动、MCP 调用翻成工具卡片；
 *  - `item/commandExecution/requestApproval` 等服务器请求：审批转成权限卡片，答案原样回执；
 *  - `model/list`：真实模型清单与逐模型的思考强度档位；
 *  - `skills/list`：用户的技能（Codex 的"斜杠命令"就是技能）；
 *  - `thread/list`：历史线程（与 VS Code 扩展共用同一份 rollout 记录）。
 *
 * 设计约束：
 *  1. 本文件只做"协议 ↔ 我们的 AgentEvent"的翻译，**不做策略判定**：
 *     审批交给运行时注入的 `requestPermission`（复用 shared/permissions 那一套），
 *     与 Claude / ACP 两条通道共用同一份判定，不各写一套 if；
 *  2. 拿不到就如实报错（缺二进制 / 握手失败 / 老版本没有 app-server），
 *     由注册表决定是否回落到一次性 CLI 通道；
 *  3. 报文里的字段一律按"可能不存在"处理 —— app-server 是实验性接口，加字段是常态。
 */
import { existsSync, readdirSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createId, type AgentSessionInfoView } from '@logicreader/shared'
import { logMain } from '../../util/ipc'
import { killTree, readVersion, resolveAgentExecutable, spawnAgent, type ResolvedExecutable } from './exec'
import { buildModelConfigOptions, mapCodexModel, type CodexModelInfo, type ModelView } from './model-view'
import type {
  AgentAdapter,
  AgentCapability,
  AgentEvent,
  AgentSessionHandle,
  ConfigOption,
  ModelOption,
  PermissionDetail,
  PromptInput,
  SessionOptions
} from './types'

/** 一次探测 / 一次普通请求的等待上限。握手本身是本地进程，正常远快于此。 */
const HANDSHAKE_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 60_000
/** 单个回合的上限（与 CLI 通道的 20 分钟一致）。 */
const TURN_TIMEOUT_MS = 20 * 60 * 1000

// ---------------------------------------------------------------- 二进制定位

/**
 * VS Code 里的 Codex 扩展**自带**一份 codex 可执行文件
 * （`<ext>/bin/<platform>-<arch>/codex.exe`）。用户装了扩展就不用再单独装 CLI，
 * 与"Claude 优先用 SDK 自带 CLI"是同一个思路。
 */
export function findBundledCodexCli(): string | null {
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64'
  const binary = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const home = homedir()
  const roots = [
    process.env.VSCODE_EXTENSIONS,
    join(home, '.vscode', 'extensions'),
    join(home, '.vscode-insiders', 'extensions'),
    join(home, '.cursor', 'extensions'),
    join(home, '.windsurf', 'extensions')
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)

  const candidates: string[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    let entries: string[] = []
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    // 目录名带版本（openai.chatgpt-26.928.40906-win32-x64）：倒序取最新那个
    const extDirs = entries
      .filter((name) => name.startsWith('openai.chatgpt-') || name.startsWith('openai.codex-'))
      .sort()
      .reverse()
    for (const dir of extDirs) {
      candidates.push(join(root, dir, 'bin', `${platform}-${arch}`, binary))
      candidates.push(join(root, dir, 'bin', platform, binary))
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 解析 Codex 可执行文件：用户配置 > PATH 上的 `codex` > VS Code 扩展自带的那一份。
 *
 * 为什么 PATH 在前面：用户自己装的 / 由 Codex 桌面端托管的 CLI 会随更新升级，
 * 原则上比扩展里冻结的那一份新（实测本机 PATH=0.159.0-alpha、扩展=0.159.2，
 * 两边都可能更新，所以不猜新旧，只按"用户显式装的那个优先"）。
 *
 * 为什么还要扩展自带这份：内置注册项的可执行文件就是裸命令名 `codex`，
 * 一旦这台机器 PATH 上没有 `codex`（只装了 VS Code 扩展），裸名解析必然失败 ——
 * 那时候扩展里的 `bin/<platform>-<arch>/codex.exe` 是**唯一能用的**一份。
 * （这个分支以前写成了"只有 executable 为空才走"，而内置项永远不为空 —— 等于死代码，本轮修掉。）
 */
export async function resolveCodexExecutable(configured?: string | null): Promise<ResolvedExecutable> {
  const trimmed = (configured ?? '').trim()
  if (trimmed.length > 0) {
    const resolved = await resolveAgentExecutable('codex', trimmed)
    if (resolved.command) return resolved
    logMain('warn', 'codex', '解析 ' + trimmed + ' 失败（' + String(resolved.error) + '），尝试 VS Code 扩展自带的那一份')
  }
  const bundled = findBundledCodexCli()
  if (bundled) {
    // 只有在 PATH / 用户配置都拿不到时才用它，所以这里会打日志，便于排查"到底跑的是哪一份"
    logMain('info', 'codex', '使用 VS Code 扩展自带的 codex：' + bundled)
    return { command: bundled, prefixArgs: [], source: bundled, error: null }
  }
  if (trimmed.length > 0) {
    return { command: '', prefixArgs: [], source: null, error: '未找到可执行文件：' + trimmed }
  }
  return resolveAgentExecutable('codex', null)
}

// ---------------------------------------------------------------- JSON-RPC 客户端

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  method: string
}

export interface CodexClientOptions {
  child: ChildProcess
  onNotification: (method: string, params: Record<string, unknown>) => void
  /** 服务器 → 客户端的请求（审批 / 提问 / elicitation），调用方负责回执 */
  onRequest: (id: number | string, method: string, params: Record<string, unknown>) => void
  onClosed: (error: Error) => void
}

/** stdio + 换行分隔 JSON-RPC 的极简客户端（与 AcpClient 同一套写法）。 */
export class CodexAppServerClient {
  private readonly child: ChildProcess
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number | string, PendingRequest>()
  private closed = false

  constructor(private readonly options: CodexClientOptions) {
    this.child = options.child
    this.child.stdout?.setEncoding('utf8')
    this.child.stderr?.setEncoding('utf8')
    this.child.stdout?.on('data', (chunk: string) => this.onData(chunk))
    this.child.stderr?.on('data', (chunk: string) => {
      const text = String(chunk).trim()
      // app-server 的 stderr 是结构化日志，只在出错时留痕，避免刷屏
      if (text.includes('"level":"ERROR"')) logMain('warn', 'codex', 'app-server: ' + text.slice(0, 400))
    })
    this.child.on('error', (error) => this.closeAll(error))
    this.child.on('close', (code, signal) => {
      this.closeAll(new Error('codex app-server 已退出（code ' + String(code) + ' signal ' + String(signal) + '）'))
    })
  }

  get exited(): boolean {
    return this.closed
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line.length > 0) this.handleLine(line)
      index = this.buffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch (error) {
      logMain('warn', 'codex', '无法解析的报文：' + line.slice(0, 300) + ' :: ' + String(error))
      return
    }
    const id = message.id as number | string | undefined
    const method = typeof message.method === 'string' ? message.method : null
    if (method && id !== undefined) {
      this.options.onRequest(id, method, (message.params ?? {}) as Record<string, unknown>)
      return
    }
    if (method) {
      this.options.onNotification(method, (message.params ?? {}) as Record<string, unknown>)
      return
    }
    if (id === undefined) return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (message.error) {
      const error = message.error as { message?: string; code?: number }
      pending.reject(new Error(error.message ?? 'app-server 返回错误 ' + String(error.code)))
    } else {
      pending.resolve(message.result)
    }
  }

  request<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('app-server 请求超时：' + method))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, method })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed || !this.child.stdin?.writable) return
    try {
      this.child.stdin.write(JSON.stringify(message) + '\n')
    } catch (error) {
      logMain('warn', 'codex', '写入 app-server 失败：' + String(error))
    }
  }

  private closeAll(error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.options.onClosed(error)
  }

  dispose(): void {
    this.closeAll(new Error('会话已关闭'))
  }
}

// ---------------------------------------------------------------- 报文翻译（纯函数，可单测）

export interface CodexTurnState {
  /** 已经被流式增量吐过的条目 id：完整 item 到达时不再重复 */
  streamed: Set<string>
  /** tool itemId → 展示信息（item/completed 时用同一个 id 关联结果） */
  tools: Map<string, { name: string; title: string }>
  /** 本轮助手正文（一次性任务与"计划"的文本来源） */
  text: string
  /** 当前线程 id */
  threadId: string | null
}

export function newCodexTurn(threadId: string | null = null): CodexTurnState {
  return { streamed: new Set(), tools: new Map(), text: '', threadId }
}

/** Codex 的 item 类型 → 我们的工具卡片名。 */
function toolNameOfItem(item: Record<string, unknown>): string | null {
  switch (String(item.type ?? '')) {
    case 'commandExecution':
      return 'Bash'
    case 'fileChange':
      return 'Edit'
    case 'mcpToolCall':
      return 'MCP'
    case 'dynamicToolCall':
      return 'Tool'
    case 'webSearch':
      return 'WebSearch'
    case 'imageView':
      return 'ImageView'
    case 'imageGeneration':
      return 'ImageGeneration'
    default:
      return null
  }
}

/** 工具卡片的一行人话标题：命令 / 路径 / 查询优先。 */
function toolTitleOfItem(item: Record<string, unknown>): string {
  const command = item.command
  if (typeof command === 'string' && command.length > 0) {
    return command.length > 120 ? command.slice(0, 120) + '…' : command
  }
  const changes = item.changes
  if (Array.isArray(changes) && changes.length > 0) {
    const paths = changes
      .map((change) => String((change as { path?: unknown })?.path ?? ''))
      .filter((path) => path.length > 0)
    if (paths.length === 1) return paths[0]
    if (paths.length > 1) return paths[0] + ' 等 ' + paths.length + ' 个文件'
  }
  if (typeof item.query === 'string' && item.query.length > 0) return item.query
  const server = typeof item.server === 'string' ? item.server : ''
  const tool = typeof item.tool === 'string' ? item.tool : ''
  if (server || tool) return (server ? server + ' / ' : '') + tool
  return String(item.type ?? 'tool')
}

/** 工具结果的可读文本（送进工具卡片）。 */
function toolOutputOfItem(item: Record<string, unknown>): unknown {
  if (typeof item.aggregatedOutput === 'string') return item.aggregatedOutput
  if (item.result !== undefined) return item.result
  if (item.error !== undefined && item.error !== null) return item.error
  if (Array.isArray(item.changes)) {
    return item.changes
      .map((change) => {
        const record = change as { path?: unknown; diff?: unknown }
        return String(record.path ?? '') + '\n' + String(record.diff ?? '')
      })
      .join('\n')
  }
  if (Array.isArray(item.results)) return item.results
  return null
}

function textOfReasoning(item: Record<string, unknown>): string {
  const parts: string[] = []
  for (const key of ['summary', 'content']) {
    const value = item[key]
    if (Array.isArray(value)) {
      for (const entry of value) if (typeof entry === 'string' && entry.length > 0) parts.push(entry)
    }
  }
  return parts.join('\n')
}

/**
 * app-server 通知 → AgentEvent。
 *
 * 形状全部取自本机实测报文：
 *  - `item/agentMessage/delta {threadId, turnId, itemId, delta}`
 *  - `item/completed {item}`：item.type ∈ userMessage / agentMessage / reasoning /
 *    commandExecution / fileChange / mcpToolCall / webSearch / plan / …
 *  - `turn/completed {threadId, turn:{id, status, error}}`
 */
export function translateCodexNotification(
  method: string,
  params: Record<string, unknown>,
  emit: (event: AgentEvent) => void,
  state: CodexTurnState
): void {
  switch (method) {
    case 'thread/started': {
      const thread = (params.thread ?? {}) as Record<string, unknown>
      const id = typeof thread.id === 'string' ? thread.id : state.threadId
      if (id) state.threadId = id
      emit({
        type: 'session',
        remoteSessionId: id ?? null,
        resumed: false,
        ...(typeof thread.model === 'string' && thread.model.length > 0 ? { activeModel: thread.model } : {})
      })
      return
    }
    case 'model/rerouted': {
      const model = typeof params.model === 'string' ? params.model : typeof params.to === 'string' ? params.to : null
      if (model) emit({ type: 'session', remoteSessionId: state.threadId, resumed: false, activeModel: model })
      return
    }
    case 'item/agentMessage/delta': {
      const itemId = typeof params.itemId === 'string' ? params.itemId : ''
      const delta = typeof params.delta === 'string' ? params.delta : ''
      if (delta.length === 0) return
      if (itemId) state.streamed.add(itemId)
      state.text += delta
      emit({ type: 'text-delta', text: delta })
      return
    }
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta': {
      const itemId = typeof params.itemId === 'string' ? params.itemId : ''
      const delta = typeof params.delta === 'string' ? params.delta : ''
      if (delta.length === 0) return
      if (itemId) state.streamed.add(itemId)
      emit({ type: 'thinking', text: delta })
      return
    }
    case 'item/started': {
      const item = (params.item ?? {}) as Record<string, unknown>
      const name = toolNameOfItem(item)
      if (!name) return
      const id = String(item.id ?? createId('tool'))
      const title = toolTitleOfItem(item)
      state.tools.set(id, { name, title })
      emit({ type: 'tool-call', id, name, input: item, title })
      return
    }
    case 'item/completed': {
      const item = (params.item ?? {}) as Record<string, unknown>
      const id = String(item.id ?? '')
      const type = String(item.type ?? '')
      if (type === 'agentMessage') {
        // 没有流式增量时（某些模型不吐 delta）才用完整正文兜底
        const text = typeof item.text === 'string' ? item.text : ''
        if (text.length > 0 && !(id && state.streamed.has(id))) {
          state.text += text
          emit({ type: 'text-delta', text })
        }
        return
      }
      if (type === 'reasoning') {
        if (id && state.streamed.has(id)) return
        const text = textOfReasoning(item)
        if (text.length > 0) emit({ type: 'thinking', text })
        return
      }
      if (type === 'plan') {
        const text = typeof item.text === 'string' ? item.text : ''
        if (text.length > 0) emit({ type: 'plan', entries: [{ content: text, status: 'pending' }] })
        return
      }
      if (!toolNameOfItem(item)) return
      const known = state.tools.get(id)
      emit({
        type: 'tool-result',
        id,
        name: known?.name ?? toolNameOfItem(item) ?? 'tool',
        output: toolOutputOfItem(item),
        isError: String(item.status ?? '') === 'failed' || item.error != null
      })
      state.tools.delete(id)
      return
    }
    case 'turn/plan/updated': {
      const plan = Array.isArray(params.plan) ? params.plan : []
      const entries = plan.map((entry) => {
        const record = (entry ?? {}) as Record<string, unknown>
        return { content: String(record.step ?? ''), status: String(record.status ?? 'pending') }
      })
      if (entries.length > 0) emit({ type: 'plan', entries })
      return
    }
    case 'thread/tokenUsage/updated': {
      const usage = (params.tokenUsage ?? {}) as Record<string, unknown>
      const last = (usage.last ?? usage.total ?? {}) as Record<string, unknown>
      const input = Number(last.inputTokens ?? 0) + Number(last.cachedInputTokens ?? 0)
      const output = Number(last.outputTokens ?? 0)
      if (input > 0 || output > 0) emit({ type: 'usage', inputTokens: input, outputTokens: output })
      return
    }
    case 'turn/completed': {
      const turn = (params.turn ?? {}) as Record<string, unknown>
      const status = String(turn.status ?? 'completed')
      const error = turn.error as { message?: string } | null | undefined
      if (status === 'failed' || error) {
        emit({ type: 'error', message: String(error?.message ?? '回合失败（' + status + '）'), retryable: true })
      }
      emit({ type: 'done', stopReason: status === 'completed' ? 'end_turn' : status })
      return
    }
    case 'error': {
      const error = params.error as { message?: string } | string | undefined
      const message = typeof error === 'string' ? error : String(error?.message ?? params.message ?? 'app-server 报错')
      emit({ type: 'error', message, retryable: true })
      return
    }
    default:
      return
  }
}

// ---------------------------------------------------------------- 审批映射

const APPROVAL_OPTIONS: Record<string, { optionId: string; name: string; kind: string }> = {
  accept: { optionId: 'accept', name: '允许一次', kind: 'allow_once' },
  acceptForSession: { optionId: 'acceptForSession', name: '本会话内始终允许', kind: 'allow_always' },
  acceptWithExecpolicyAmendment: { optionId: 'acceptWithExecpolicyAmendment', name: '允许，并记住这类命令', kind: 'allow_always' },
  decline: { optionId: 'decline', name: '拒绝', kind: 'reject_once' },
  cancel: { optionId: 'cancel', name: '拒绝并中断', kind: 'reject_cancel' }
}

/**
 * `availableDecisions` 里既有字符串（`"accept"`），也有单键对象
 * （`{acceptWithExecpolicyAmendment:{execpolicy_amendment:[...]}}`，本机实测）。
 * 统一取出"这一项是什么决定"，顺序保持不变。
 */
function approvalIdsOf(params: Record<string, unknown>): string[] {
  const raw = Array.isArray(params.availableDecisions) ? params.availableDecisions : []
  return raw
    .map((entry) => {
      if (typeof entry === 'string') return entry
      if (entry !== null && typeof entry === 'object') {
        const keys = Object.keys(entry as Record<string, unknown>)
        return keys.length > 0 ? keys[0] : ''
      }
      return ''
    })
    .filter((id) => id.length > 0)
}

/** app-server 的审批请求 → 我们统一的权限卡片。返回 null 表示"这条请求我们不认"。 */
export function toCodexApprovalDetail(method: string, params: Record<string, unknown>): PermissionDetail | null {
  if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
    const available = approvalIdsOf(params)
    const ids = available.length > 0 ? available : ['accept', 'decline', 'cancel']
    const command = String(params.command ?? '')
    return {
      title: command.length > 0 ? command : '执行命令',
      kind: 'execute',
      rawInput: { command, cwd: params.cwd, reason: params.reason },
      options: ids.map((id) => APPROVAL_OPTIONS[id] ?? { optionId: id, name: id, kind: 'allow_once' }),
      reason: params.reason ? String(params.reason) : undefined
    }
  }
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    return {
      title: '文件改动待确认',
      kind: 'write',
      rawInput: params,
      options: ['accept', 'acceptForSession', 'decline', 'cancel'].map((id) => APPROVAL_OPTIONS[id]),
      reason: params.reason ? String(params.reason) : undefined
    }
  }
  if (method === 'item/permissions/requestApproval') {
    return {
      title: '申请额外权限',
      kind: 'write',
      rawInput: params.permissions ?? params,
      options: ['accept', 'decline'].map((id) => APPROVAL_OPTIONS[id]),
      reason: params.reason ? String(params.reason) : undefined
    }
  }
  return null
}

/** 权限卡片的选择 → app-server 的回执报文。 */
export function toCodexApprovalResponse(
  method: string,
  params: Record<string, unknown>,
  chosen: string | null
): Record<string, unknown> {
  if (method === 'item/permissions/requestApproval') {
    if (chosen === 'accept') return { permissions: params.permissions ?? {}, scope: 'turn' }
    // 拒绝 = 不给任何额外权限（GrantedPermissionProfile 的空形状）
    return { permissions: { fileSystem: null, network: null } }
  }
  if (chosen === 'acceptWithExecpolicyAmendment') {
    // 修正案可能随候选对象一起下发（`{acceptWithExecpolicyAmendment:{execpolicy_amendment:[...]}}`），
    // 也可能单独放在 `proposedExecpolicyAmendment`；两处都认。
    const fromDecision = Array.isArray(params.availableDecisions)
      ? params.availableDecisions
          .map((entry) =>
            entry !== null && typeof entry === 'object'
              ? (entry as { acceptWithExecpolicyAmendment?: { execpolicy_amendment?: unknown } })
                  .acceptWithExecpolicyAmendment
              : null
          )
          .find((entry) => entry != null)
      : null
    return {
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: Array.isArray(fromDecision?.execpolicy_amendment)
            ? fromDecision?.execpolicy_amendment
            : Array.isArray(params.proposedExecpolicyAmendment)
              ? params.proposedExecpolicyAmendment
              : []
        }
      }
    }
  }
  if (chosen === 'accept' || chosen === 'acceptForSession' || chosen === 'cancel') return { decision: chosen }
  return { decision: 'decline' }
}

// ---------------------------------------------------------------- 会话

export interface CodexSessionCreateOptions {
  sessionId: string
  executable: string
  prefixArgs: string[]
  /** 注册表里配置的附加参数（放在 `app-server` 之后） */
  args: string[]
  options: SessionOptions
  onEvent: (event: AgentEvent) => void
  requestPermission: (detail: PermissionDetail) => Promise<string | null>
}

/** UI 授权档位 → app-server 的审批策略（AskForApproval）。 */
export function approvalPolicyFor(mode: SessionOptions['permissionMode']): string {
  // manual / plan：一律问人（plan 额外用只读沙箱兜底）
  if (mode === 'plan' || mode === 'manual' || mode == null) return 'untrusted'
  // edit / auto：让 Agent 先动手，风险动作由它主动请求审批，我们再按策略放行或转人工
  return 'on-request'
}

export class CodexSession implements AgentSessionHandle {
  readonly id: string
  private child: ChildProcess | null = null
  private readonly client: CodexAppServerClient
  private readonly state: CodexTurnState
  private readonly options: SessionOptions
  private readonly onEvent: (event: AgentEvent) => void
  private threadId: string | null = null
  private activeModelName: string | null = null
  private turnId: string | null = null
  private turnWait: { resolve: () => void; settled: boolean } | null = null
  private disposed = false

  private constructor(create: CodexSessionCreateOptions, client: CodexAppServerClient, child: ChildProcess) {
    this.id = create.sessionId
    this.client = client
    this.child = child
    this.options = create.options
    this.onEvent = create.onEvent
    this.state = newCodexTurn(null)
  }

  static async create(create: CodexSessionCreateOptions): Promise<CodexSession> {
    const child = spawnAgent(create.executable, [...create.prefixArgs, 'app-server', ...create.args], {
      cwd: create.options.cwd,
      timeoutMs: 0
    })
    let session: CodexSession
    const client = new CodexAppServerClient({
      child,
      onNotification: (method, params) => session?.handleNotification(method, params),
      onRequest: (id, method, params) => void session?.handleServerRequest(id, method, params),
      onClosed: (error) => session?.handleClosed(error)
    })
    session = new CodexSession(create, client, child)
    await session.initialize()
    return session
  }

  private async initialize(): Promise<void> {
    await this.client.request(
      'initialize',
      { clientInfo: { name: 'logicreader', title: 'LogicReader', version: '0.1.0' } },
      HANDSHAKE_TIMEOUT_MS
    )
    const thread = await this.openThread()
    this.threadId = thread.id
    this.state.threadId = thread.id
    if (thread.model) this.activeModelName = thread.model
    this.onEvent({
      type: 'session',
      remoteSessionId: thread.id,
      resumed: thread.resumed,
      ...(this.activeModelName ? { activeModel: this.activeModelName } : {})
    })
    logMain(
      'info',
      'codex',
      'app-server 会话已建立：' + thread.id + (thread.resumed ? '（续聊）' : '') + ' 模型=' + String(this.activeModelName)
    )
  }

  /** 建线程：续聊 / 分叉 / 新建三选一，失败一律回落到新建（不假装续上了）。 */
  private async openThread(): Promise<{ id: string; model: string | null; resumed: boolean }> {
    const resumeId = this.options.resumeSessionId ?? null
    if (resumeId) {
      const method = this.options.forkSession ? 'thread/fork' : 'thread/resume'
      try {
        const result = await this.client.request<{ thread?: Record<string, unknown> }>(
          method,
          { threadId: resumeId },
          REQUEST_TIMEOUT_MS
        )
        const thread = result.thread ?? {}
        return {
          id: String(thread.id ?? resumeId),
          model: typeof thread.model === 'string' ? thread.model : null,
          resumed: true
        }
      } catch (error) {
        logMain('warn', 'codex', (this.options.forkSession ? '分叉' : '续聊') + '会话失败，改为新建：' + String(error))
      }
    }
    const result = await this.client.request<{ thread?: Record<string, unknown> }>(
      'thread/start',
      {
        cwd: this.options.cwd,
        approvalPolicy: approvalPolicyFor(this.options.permissionMode),
        sandbox: this.options.permissionMode === 'plan' ? 'read-only' : 'workspace-write'
      },
      REQUEST_TIMEOUT_MS
    )
    const thread = result.thread ?? {}
    return {
      id: String(thread.id ?? ''),
      model: typeof thread.model === 'string' ? thread.model : null,
      resumed: false
    }
  }

  get remoteSessionId(): string | null {
    return this.threadId
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'turn/completed') {
      const turn = (params.turn ?? {}) as Record<string, unknown>
      if (typeof turn.id === 'string') this.turnId = turn.id
    }
    translateCodexNotification(method, params, (event) => this.onEvent(event), this.state)
    if (method === 'turn/completed') {
      const wait = this.turnWait
      this.turnWait = null
      if (wait && !wait.settled) {
        wait.settled = true
        wait.resolve()
      }
    }
  }

  private async handleServerRequest(id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
    const detail = toCodexApprovalDetail(method, params)
    if (!detail) {
      // 不认识的服务器请求一律**明确拒绝**，而不是猜一个形状回去 —— 猜错会污染会话状态
      logMain('warn', 'codex', '不支持的服务器请求，已拒绝：' + method)
      this.client.respondError(id, -32601, 'LogicReader 暂不支持该请求：' + method)
      return
    }
    let chosen: string | null = null
    try {
      chosen = (await this.options.requestPermission?.(detail)) ?? null
    } catch (error) {
      logMain('warn', 'codex', '审批往返失败：' + String(error))
    }
    this.client.respond(id, toCodexApprovalResponse(method, params, chosen))
    logMain('info', 'codex', '审批已回执：' + method + ' → ' + String(chosen ?? 'decline'))
  }

  private handleClosed(error: Error): void {
    if (this.disposed) return
    this.onEvent({ type: 'error', message: error.message, retryable: true })
    const wait = this.turnWait
    this.turnWait = null
    if (wait && !wait.settled) {
      wait.settled = true
      wait.resolve()
    }
  }

  async prompt(input: PromptInput): Promise<void> {
    if (this.disposed) throw new Error('会话已关闭')
    if (!this.threadId) throw new Error('Codex 线程尚未建立')

    const text = input.systemContext ? input.systemContext + '\n\n' + input.text : input.text
    const params: Record<string, unknown> = {
      threadId: this.threadId,
      input: [{ type: 'text', text }]
    }
    const model = input.modelId ?? this.options.modelId
    if (model && model !== 'default') params.model = model
    const effort = input.thinkingEffort ?? this.options.thinkingEffort
    if (effort && effort !== 'off') params.effort = effort

    const wait = new Promise<void>((resolve) => {
      this.turnWait = { resolve, settled: false }
    })
    try {
      const result = await this.client.request<{ turn?: { id?: string } }>('turn/start', params, REQUEST_TIMEOUT_MS)
      this.turnId = result.turn?.id ?? null
    } catch (error) {
      this.turnWait = null
      const message = error instanceof Error ? error.message : String(error)
      logMain('warn', 'codex', '回合启动失败：' + message)
      this.onEvent({ type: 'error', message, retryable: true })
      this.onEvent({ type: 'done', stopReason: 'error' })
      return
    }

    let timer: NodeJS.Timeout | null = null
    try {
      await Promise.race([
        wait,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            logMain('warn', 'codex', '回合超时（' + Math.round(TURN_TIMEOUT_MS / 1000) + 's），已中断')
            void this.cancel()
            resolve()
          }, TURN_TIMEOUT_MS)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async cancel(): Promise<void> {
    if (!this.threadId || !this.turnId) return
    try {
      await this.client.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 15_000)
    } catch (error) {
      logMain('warn', 'codex', '中断失败：' + String(error))
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.client.dispose()
    killTree(this.child)
    this.child = null
  }

  /** 真实模型清单（`model/list`）。 */
  async models(): Promise<ModelView[]> {
    const result = await this.client.request<{ data?: CodexModelInfo[] }>('model/list', {}, HANDSHAKE_TIMEOUT_MS)
    const list = Array.isArray(result.data) ? result.data : []
    return list.filter((item) => item.hidden !== true).map(mapCodexModel).filter((item) => item.id.length > 0)
  }

  /**
   * 斜杠命令：Codex 的"命令"就是**技能**（`skills/list`）。
   * 返回这台机器上真实装着的技能（含用户自己的），界面只做展示与补全。
   */
  async commands(): Promise<{ name: string; description?: string; argumentHint?: string }[]> {
    try {
      const result = await this.client.request<{ data?: { skills?: { name?: string; description?: string }[] }[] }>(
        'skills/list',
        {},
        HANDSHAKE_TIMEOUT_MS
      )
      const groups = Array.isArray(result.data) ? result.data : []
      const seen = new Set<string>()
      const out: { name: string; description?: string }[] = []
      for (const group of groups) {
        for (const skill of group.skills ?? []) {
          const name = String(skill.name ?? '')
          if (name.length === 0 || seen.has(name)) continue
          seen.add(name)
          out.push({ name, description: skill.description ? String(skill.description) : undefined })
        }
      }
      return out
    } catch (error) {
      logMain('debug', 'codex', '取技能清单失败：' + String(error))
      return []
    }
  }

  /** 当前真正在跑的模型（来自线程元数据 / `model/rerouted`）。 */
  activeModel(): string | null {
    return this.activeModelName
  }

  /**
   * 会话级配置：模型与思考强度由**下一个回合**的参数携带（`turn/start` 的 model / effort），
   * 所以这里只改本地状态，不需要往 app-server 发请求 —— 这正是不用重开进程的好处。
   */
  async setConfigOption(optionId: string, value: string | boolean): Promise<void> {
    if (optionId === 'model') {
      this.options.modelId = String(value)
      return
    }
    if (optionId === 'thought_level') this.options.thinkingEffort = String(value)
  }
}

/** 会话句柄的能力扩展（运行时用来做模型清单 / 技能清单 / 当前模型）。 */
export interface CodexCapableHandle extends AgentSessionHandle {
  models?: () => Promise<ModelView[]>
  commands?: () => Promise<{ name: string; description?: string; argumentHint?: string }[]>
  activeModel?: () => string | null
}

export function asCodexHandle(handle: AgentSessionHandle): CodexCapableHandle | null {
  return handle instanceof CodexSession ? (handle as CodexCapableHandle) : null
}

// ---------------------------------------------------------------- 适配器

export interface CodexAdapterOptions {
  id: string
  displayName?: string
  /** 用户配置的可执行文件；为空则用 VS Code 扩展自带 / PATH */
  executable?: string | null
  /** 注册表里配置的附加启动参数 */
  args?: string[]
}

export class CodexAdapter implements AgentAdapter {
  readonly id: string
  readonly kind = 'codex' as const
  readonly protocol = 'app-server' as const
  private readonly displayName: string
  private readonly configuredExecutable: string | null
  private readonly extraArgs: string[]

  constructor(options: CodexAdapterOptions) {
    this.id = options.id
    this.displayName = options.displayName ?? 'Codex'
    this.configuredExecutable = options.executable ?? null
    this.extraArgs = options.args ?? []
  }

  /** 带真实握手的能力探测：起一次 app-server，问完模型清单就关。 */
  async probe(): Promise<AgentCapability> {
    const resolved = await resolveCodexExecutable(this.configuredExecutable)
    if (!resolved.command) return this.unavailable(resolved.error ?? '未找到 codex 可执行文件')
    const launchArgs = [...resolved.prefixArgs, 'app-server', ...this.extraArgs]

    const probed = await probeAppServer(resolved.command, resolved.prefixArgs, this.extraArgs)
    if (!probed.ok) {
      logMain('warn', 'codex', 'app-server 探测失败：' + String(probed.error))
      return this.unavailable(probed.error ?? 'app-server 握手失败', resolved.command, launchArgs)
    }
    const version = await readVersion(resolved.command, [...resolved.prefixArgs, '--version'], process.cwd())
    const models: ModelOption[] = probed.models.map(mapCodexModel).filter((item) => item.id.length > 0)
    return {
      id: this.id,
      kind: 'codex',
      displayName: this.displayName,
      protocol: 'app-server',
      available: true,
      version,
      executable: resolved.command,
      launchArgs,
      supportsAcp: false,
      supportsSdk: false,
      supportsResume: true,
      supportsStreaming: true,
      supportsModel: models.length > 0,
      supportsThoughtLevel: models.some((model) => (model.thoughtLevels?.length ?? 0) > 0),
      // 模型与思考强度是逐回合参数，不需要重建会话
      supportsPermissionModeSwitch: true,
      models,
      configOptions: buildModelConfigOptions(models),
      defaultModel: models[0]?.id ?? null,
      defaultThoughtLevel: models[0]?.defaultThoughtLevel ?? models[0]?.thoughtLevels?.[0]?.id ?? null,
      error: null,
      probedAt: Date.now(),
      builtin: true
    }
  }

  private unavailable(error: string, executable: string | null = null, launchArgs: string[] = []): AgentCapability {
    return {
      id: this.id,
      kind: 'codex',
      displayName: this.displayName,
      protocol: 'app-server',
      available: false,
      version: null,
      executable,
      launchArgs,
      supportsAcp: false,
      supportsSdk: false,
      supportsResume: false,
      supportsStreaming: false,
      supportsModel: false,
      supportsThoughtLevel: false,
      supportsPermissionModeSwitch: false,
      models: [],
      configOptions: [] as ConfigOption[],
      defaultModel: null,
      defaultThoughtLevel: null,
      error,
      probedAt: Date.now(),
      builtin: true
    }
  }

  async start(options: SessionOptions, onEvent: (event: AgentEvent) => void): Promise<AgentSessionHandle> {
    const resolved = await resolveCodexExecutable(this.configuredExecutable)
    if (!resolved.command) throw new Error(resolved.error ?? '未找到 codex 可执行文件')
    if (!options.requestPermission) throw new Error('运行时未提供权限回调（app-server 通道需要它来回答审批）')
    return CodexSession.create({
      sessionId: options.sessionId ?? createId('sess'),
      executable: resolved.command,
      prefixArgs: resolved.prefixArgs,
      args: this.extraArgs,
      options,
      onEvent,
      requestPermission: options.requestPermission
    })
  }
}

/** 一次性握手：起 app-server → initialize → model/list → 关。 */
async function probeAppServer(
  command: string,
  prefixArgs: string[],
  extraArgs: string[]
): Promise<{ ok: boolean; error: string | null; models: CodexModelInfo[] }> {
  const child = spawnAgent(command, [...prefixArgs, 'app-server', ...extraArgs], {
    cwd: process.cwd(),
    timeoutMs: HANDSHAKE_TIMEOUT_MS + 5_000
  })
  // 用对象持有：进程退出的错误是在回调里写的，闭包直接改局部变量会被 TS 的
  // 控制流分析判成"永远还是初始值"（never）
  const closed: { error: Error | null } = { error: null }
  const client = new CodexAppServerClient({
    child,
    onNotification: () => undefined,
    onRequest: (id) => client.respondError(id, -32601, '探测进程不处理请求'),
    onClosed: (error) => {
      closed.error = error
    }
  })
  try {
    await client.request('initialize', { clientInfo: { name: 'logicreader', title: 'LogicReader', version: '0.1.0' } }, HANDSHAKE_TIMEOUT_MS)
    const list = await client.request<{ data?: CodexModelInfo[] }>('model/list', {}, HANDSHAKE_TIMEOUT_MS)
    return { ok: true, error: null, models: Array.isArray(list.data) ? list.data : [] }
  } catch (error) {
    return { ok: false, error: closed.error?.message ?? (error instanceof Error ? error.message : String(error)), models: [] }
  } finally {
    client.dispose()
    killTree(child)
  }
}

/**
 * 历史线程（`thread/list`）—— 与 VS Code 扩展共用同一份 rollout 记录，
 * 所以用户在 VS Code / 桌面 App 里聊过的线程，这里也能看到并续聊。
 */
export async function listCodexSessions(options: {
  command: string
  prefixArgs: string[]
  extraArgs?: string[]
  cwd: string
  limit: number
}): Promise<AgentSessionInfoView[]> {
  const child = spawnAgent(options.command, [...options.prefixArgs, 'app-server', ...(options.extraArgs ?? [])], {
    cwd: options.cwd,
    timeoutMs: HANDSHAKE_TIMEOUT_MS + 5_000
  })
  const client = new CodexAppServerClient({
    child,
    onNotification: () => undefined,
    onRequest: (id) => client.respondError(id, -32601, '探测进程不处理请求'),
    onClosed: () => undefined
  })
  try {
    await client.request('initialize', { clientInfo: { name: 'logicreader', title: 'LogicReader', version: '0.1.0' } }, HANDSHAKE_TIMEOUT_MS)
    const result = await client.request<{ data?: Record<string, unknown>[] }>(
      'thread/list',
      { limit: options.limit },
      HANDSHAKE_TIMEOUT_MS
    )
    const rows = Array.isArray(result.data) ? result.data : []
    return rows
      .map((row): AgentSessionInfoView | null => {
        const id = String(row.id ?? row.sessionId ?? '')
        if (id.length === 0) return null
        const updated = Number(row.updatedAt ?? row.createdAt ?? 0)
        const cwd = typeof row.cwd === 'string' ? row.cwd : undefined
        // 只保留当前工作目录下的线程（与 Claude 那侧"按项目目录隔离"一致）
        if (cwd && options.cwd && cwd.replace(/\\/g, '/').toLowerCase() !== options.cwd.replace(/\\/g, '/').toLowerCase()) {
          return null
        }
        const git = (row.gitInfo ?? null) as { branch?: unknown } | null
        return {
          sessionId: id,
          summary: row.name ? String(row.name) : row.preview ? String(row.preview) : undefined,
          firstPrompt: row.preview ? String(row.preview) : undefined,
          customTitle: row.name ? String(row.name) : undefined,
          // app-server 给的是**秒**，界面按毫秒消费
          lastModified: updated > 0 ? updated * 1000 : undefined,
          cwd,
          gitBranch: git?.branch ? String(git.branch) : undefined
        }
      })
      .filter((row): row is AgentSessionInfoView => row !== null)
  } catch (error) {
    logMain('warn', 'codex', '列历史线程失败：' + String(error))
    return []
  } finally {
    client.dispose()
    killTree(child)
  }
}

/**
 * 给运行时用的入口：自己解析可执行文件（与建会话同一套优先级），
 * 调用方只要给"注册表里配置的可执行文件"即可。
 */
export async function listCodexSessionsFor(options: {
  executable: string | null
  extraArgs?: string[]
  cwd: string
  limit: number
}): Promise<AgentSessionInfoView[]> {
  const resolved = await resolveCodexExecutable(options.executable)
  if (!resolved.command) return []
  return listCodexSessions({
    command: resolved.command,
    prefixArgs: resolved.prefixArgs,
    extraArgs: options.extraArgs,
    cwd: options.cwd,
    limit: options.limit
  })
}
