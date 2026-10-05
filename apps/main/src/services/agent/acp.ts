/**
 * ACP 客户端：以 stdio + 换行分隔 JSON-RPC 与 Agent 通信（规划书 §5.4）。
 *
 * 协议形状**不靠人记**：出站报文由下面几个纯函数拼，返回值直接声明成官方 SDK
 * （`@agentclientprotocol/sdk` 的 `schema/types.gen`）的类型 —— 字段名或判别值一旦与协议不符，
 * `pnpm typecheck` 就红。入站判别值同样由单测（`acp-protocol.test.ts`）对着官方 union 钉住。
 *
 * 为什么只用它的**类型**、不用它的运行时（`ClientSideConnection` 那套）：
 * 那个 API 是 handler/context 式的，与本文件"事件流 + 请求-应答"的形状差别很大；
 * 重写会把会话/权限/取消这些**只有接真 Agent 才能验**的语义全部重来一遍，收益远小于风险。
 * 类型是零运行时成本的，且正好治"字段名悄悄对不上"这个最贵的毛病。
 */
import type { ChildProcess } from 'node:child_process'
import type {
  NewSessionRequest,
  PromptRequest,
  SetSessionConfigOptionRequest
} from '@agentclientprotocol/sdk'
import { createId } from '@logicreader/shared'
import { logMain } from '../../util/ipc'
import { killTree, spawnAgent } from './exec'
import type { AgentEvent, ConfigOption, PermissionDetail } from './types'

export const ACP_PROTOCOL_VERSION = 1

/**
 * 出站报文拼装（纯函数，返回值类型来自官方 schema）。
 *
 * 抽出来的理由与仓库里"UI 与冒烟共用同一个拼装函数"是同一条：形状只能有一份来源，
 * 测试断言的就是调用方真正发出去的那一份，而不是测试自己另写的一份。
 */
export function buildSetConfigOptionParams(
  sessionId: string,
  configId: string,
  value: string | boolean
): SetSessionConfigOptionRequest {
  /**
   * 布尔值必须带 `type: 'boolean'`：官方类型是**判别联合**
   * `{ value: boolean, type: 'boolean' } | { value: string }`（再交上 sessionId/configId）。
   * 少了 `type` 两个分支都不匹配 —— 严格的 Agent 直接拒，界面只表现为"改了但值没变"。
   */
  if (typeof value === 'boolean') return { sessionId, configId, value, type: 'boolean' }
  return { sessionId, configId, value }
}

export function buildPromptParams(sessionId: string, text: string): PromptRequest {
  return { sessionId, prompt: [{ type: 'text', text }] }
}

export function buildNewSessionParams(cwd: string, mcpServers: unknown[] = []): NewSessionRequest {
  return { cwd, mcpServers: mcpServers as NewSessionRequest['mcpServers'] }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  method: string
  timer: NodeJS.Timeout
}

export interface AcpClientOptions {
  child: ChildProcess
  onEvent: (event: AgentEvent) => void
  /** 权限请求：返回用户选择 */
  requestPermission: (detail: PermissionDetail) => Promise<string | null>
  readTextFile: (path: string, line?: number, limit?: number) => Promise<string>
  allowWrite: boolean
  writeTextFile: (path: string, content: string) => Promise<void>
  timeoutMs?: number
}

export class AcpClient {
  private child: ChildProcess
  private buffer = ''
  private nextId = 1
  private pending = new Map<number | string, PendingRequest>()
  private options: AcpClientOptions
  private closed = false
  /** toolCallId → 名称，用于把 tool_call_update 关联回原始调用 */
  private toolNames = new Map<string, string>()
  private toolStart = new Map<string, number>()
  private textCalls = 0

  constructor(options: AcpClientOptions) {
    this.options = options
    this.child = options.child
    this.child.stdout?.setEncoding('utf8')
    this.child.stderr?.setEncoding('utf8')
    this.child.stdout?.on('data', (chunk: string) => this.onData(chunk))
    this.child.stderr?.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (text.length > 0) logMain('debug', 'acp', 'stderr: ' + text.slice(0, 400))
    })
    this.child.on('exit', (code, signal) => {
      this.closed = true
      const error = new Error('Agent 进程已退出（code ' + String(code) + ' signal ' + String(signal) + '）')
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      this.pending.clear()
      this.options.onEvent({ type: 'error', message: error.message, retryable: true })
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
      if (line.length > 0) {
        try {
          this.handleMessage(JSON.parse(line))
        } catch (error) {
          logMain('warn', 'acp', '无法解析的报文', line.slice(0, 300) + ' :: ' + String(error))
        }
      }
      index = this.buffer.indexOf('\n')
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    const id = message.id as number | string | undefined
    if (message.method && id !== undefined) {
      // Agent → Client 请求
      void this.handleRequest(id, String(message.method), (message.params ?? {}) as Record<string, unknown>)
      return
    }
    if (message.method && id === undefined) {
      // 通知
      if (message.method === 'session/update') this.handleUpdate((message.params ?? {}) as Record<string, unknown>)
      return
    }
    if (id !== undefined) {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (message.error) {
        const err = message.error as { message?: string; code?: number }
        pending.reject(new Error(err.message ?? 'Agent 返回错误 ' + String(err.code)))
      } else {
        pending.resolve(message.result)
      }
    }
  }

  private async handleRequest(id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
    try {
      switch (method) {
        case 'session/request_permission': {
          const toolCall = (params.toolCall ?? {}) as Record<string, unknown>
          const rawOptions = (params.options ?? []) as { optionId: string; name: string; kind: string }[]
          const detail: PermissionDetail = {
            title: String(toolCall.title ?? '未命名操作'),
            kind: String(toolCall.kind ?? 'other'),
            rawInput: toolCall.rawInput ?? null,
            options: rawOptions.map((option) => ({ optionId: option.optionId, name: option.name, kind: option.kind }))
          }
          const chosen = await this.options.requestPermission(detail)
          this.send({
            jsonrpc: '2.0',
            id,
            result: chosen
              ? { outcome: { outcome: 'selected', optionId: chosen } }
              : { outcome: { outcome: 'cancelled' } }
          })
          return
        }
        case 'fs/read_text_file': {
          const content = await this.options.readTextFile(
            String(params.path ?? ''),
            params.line as number | undefined,
            params.limit as number | undefined
          )
          this.send({ jsonrpc: '2.0', id, result: { content } })
          return
        }
        case 'fs/write_text_file': {
          if (!this.options.allowWrite) {
            this.send({ jsonrpc: '2.0', id, error: { code: -32000, message: '写入文件被客户端策略拒绝' } })
            return
          }
          await this.options.writeTextFile(String(params.path ?? ''), String(params.content ?? ''))
          this.send({ jsonrpc: '2.0', id, result: {} })
          return
        }
        default: {
          this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: '未实现的方法：' + method } })
        }
      }
    } catch (error) {
      this.send({ jsonrpc: '2.0', id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })
    }
  }

  private handleUpdate(params: Record<string, unknown>): void {
    const update = (params.update ?? {}) as Record<string, unknown>
    const kind = String(update.sessionUpdate ?? '')
    switch (kind) {
      case 'agent_message_chunk': {
        const content = update.content as { type?: string; text?: string } | undefined
        if (content?.type === 'text' && content.text) this.options.onEvent({ type: 'text-delta', text: content.text })
        this.textCalls += 1
        break
      }
      case 'agent_thought_chunk': {
        const content = update.content as { type?: string; text?: string } | undefined
        if (content?.type === 'text' && content.text) this.options.onEvent({ type: 'thinking', text: content.text })
        break
      }
      case 'user_message_chunk':
        break
      case 'tool_call': {
        const toolCallId = String(update.toolCallId ?? createId('tool'))
        this.toolNames.set(toolCallId, String(update.title ?? update.kind ?? 'tool'))
        this.toolStart.set(toolCallId, Date.now())
        this.options.onEvent({
          type: 'tool-call',
          id: toolCallId,
          name: String(update.kind ?? 'tool'),
          title: String(update.title ?? ''),
          input: update.rawInput ?? null
        })
        break
      }
      case 'tool_call_update': {
        const toolCallId = String(update.toolCallId ?? '')
        const status = String(update.status ?? '')
        if (status === 'completed' || status === 'failed') {
          this.options.onEvent({
            type: 'tool-result',
            id: toolCallId,
            name: this.toolNames.get(toolCallId) ?? 'tool',
            output: update.rawOutput ?? update.content ?? null,
            isError: status === 'failed'
          })
        }
        break
      }
      case 'plan': {
        const entries = Array.isArray(update.entries) ? update.entries : []
        this.options.onEvent({
          type: 'plan',
          entries: entries.map((entry) => {
            const item = entry as { content?: string; status?: string }
            return { content: String(item.content ?? ''), status: String(item.status ?? 'pending') }
          })
        })
        break
      }
      default:
        /**
         * dsh 0.2 每轮会发 `usage_update`（上下文用量）：`update.used` = 当前对话占用的 token、
         * `update.size` = 窗口总量（拿不到时是 -1 / 缺省）。这跟"单条消息的输入/输出 token"不是一回事，
         * 之前直接丢掉 —— 状态栏于是只能显示文档体量的静态估算、永远不更新。
         * 现在翻成 `context-usage` 事件（字段做防御性解析：数字才认，负数/缺省按 null 处理）。
         */
        if (kind === 'usage_update' || kind === 'usage') {
          const used = Number((update as { used?: unknown }).used)
          const sizeRaw = Number((update as { size?: unknown }).size)
          if (Number.isFinite(used) && used > 0) {
            this.options.onEvent({
              type: 'context-usage',
              used: Math.round(used),
              size: Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.round(sizeRaw) : null
            })
          }
          break
        }
        if (kind.length > 0) logMain('debug', 'acp', '未消费的会话更新：' + kind)
        break
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.closed || !this.child.stdin?.writable) return
    try {
      this.child.stdin.write(JSON.stringify(message) + '\n')
    } catch (error) {
      logMain('warn', 'acp', '写入 Agent 失败', String(error))
    }
  }

  /** `timeoutMs` 只覆盖**这一次**请求（例如关闭会话时不该等满 10 分钟）。 */
  request<T = unknown>(method: string, params: object, timeoutMs?: number): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('ACP 请求超时：' + method))
      }, timeoutMs ?? this.options.timeoutMs ?? 120000)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method, timer })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: object): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  async initialize(capabilities: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: capabilities
    })
  }

  async newSession(cwd: string, mcpServers: unknown[] = []): Promise<{ sessionId: string; configOptions?: ConfigOption[] }> {
    const result = await this.request<{ sessionId: string; configOptions?: ConfigOption[] }>(
      'session/new',
      buildNewSessionParams(cwd, mcpServers)
    )
    return result
  }

  /**
   * 续聊：ACP v1 的 `session/resume`。
   * 与 `session/new` 的区别是它复用磁盘上已持久化的会话（dsh 0.2+ 支持 list/resume/close），
   * 所以「续聊」能带上原来的上下文。Agent 没声明这个能力时会以方法未实现报错，由调用方回落新建。
   */
  async resumeSession(sessionId: string, cwd: string): Promise<{ sessionId: string; configOptions?: ConfigOption[] }> {
    return this.request<{ sessionId: string; configOptions?: ConfigOption[] }>('session/resume', { sessionId, cwd })
  }

  /** 关闭**单个**会话（ACP v1 `session/close`），不关整条连接。 */
  async closeSession(sessionId: string): Promise<void> {
    // 超时压到 4 秒：这是"退出/换 Agent"路径上的收尾动作，不能把界面卡住
    await this.request('session/close', { sessionId }, 4000)
  }

  async prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    return this.request<{ stopReason: string }>('session/prompt', buildPromptParams(sessionId, text))
  }

  cancel(sessionId: string): void {
    this.notify('session/cancel', { sessionId })
  }

  /**
   * 强制收尾：Agent 对 `session/cancel` 不响应时（实测思考型模型空转时 dsh 会拖着不回
   * `session/prompt` 的结果），取消不能只靠 Agent 自觉 —— 这里把**所有挂起请求**按超时错误拒绝。
   * `session/prompt` 的调用方（AcpSession.prompt）会把它翻成 error 事件，UI 的流式状态才能落地。
   */
  forceFailPending(reason: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pending.clear()
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<ConfigOption[] | null> {
    try {
      const result = await this.request<{ configOptions?: ConfigOption[] }>(
        'session/set_config_option',
        buildSetConfigOptionParams(sessionId, configId, value)
      )
      return result.configOptions ?? null
    } catch (error) {
      logMain('warn', 'acp', '设置会话配置项失败：' + configId, String(error))
      return null
    }
  }

  dispose(): void {
    this.closed = true
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('会话已关闭'))
    }
    this.pending.clear()
  }
}

/** `session/list` 的一行（只保留界面真正消费的字段）。 */
export interface AcpSessionSummary {
  sessionId: string
  title?: string | null
  updatedAt?: string | null
  cwd?: string
}

/**
 * 一次性列出某工作目录下的历史会话（ACP `session/list`）。
 *
 * 起一个**临时** ACP 连接、问完就关：只有实现了 `session/list` 的 Agent（dsh 0.2+ 的
 * `--profile acp`）会给结果；别的 ACP 工具会以"方法未实现"报错，这里安静地返回空数组，
 * 界面照旧显示"没有历史会话"，不会把整块面板打挂。
 *
 * 与 Codex 的 `thread/list` 是同一个位置的两条实现，都只为"续聊"服务。
 */
export async function listAcpSessions(options: {
  executable: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  limit?: number
  timeoutMs?: number
}): Promise<AcpSessionSummary[]> {
  const child = spawnAgent(options.executable, options.args, { cwd: options.cwd, env: options.env, timeoutMs: 0 })
  const client = new AcpClient({
    child,
    onEvent: () => undefined,
    requestPermission: async () => null,
    readTextFile: async () => '',
    writeTextFile: async () => undefined,
    allowWrite: false,
    timeoutMs: options.timeoutMs ?? 15000
  })
  try {
    await client.initialize({})
    const result = await client.request<{ sessions?: unknown[] }>('session/list', { cwd: options.cwd })
    const rows = Array.isArray(result?.sessions) ? result.sessions : []
    return rows
      .map((row) => row as Record<string, unknown>)
      .map((row) => ({
        sessionId: String(row.sessionId ?? ''),
        title: row.title == null ? null : String(row.title),
        updatedAt: row.updatedAt == null ? null : String(row.updatedAt),
        cwd: row.cwd == null ? undefined : String(row.cwd)
      }))
      .filter((row) => row.sessionId.length > 0)
      .slice(0, options.limit ?? 30)
  } catch (error) {
    logMain('debug', 'acp', '列历史会话失败（该 Agent 可能不支持 session/list）：' + String(error))
    return []
  } finally {
    client.dispose()
    killTree(child)
  }
}
