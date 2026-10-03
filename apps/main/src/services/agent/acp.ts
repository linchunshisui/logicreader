/**
 * ACP 客户端：以 stdio + 换行分隔 JSON-RPC 与 Agent 通信（规划书 §5.4）。
 * 这里直接实现协议子集，不引入额外运行时依赖，便于打包与版本控制。
 */
import type { ChildProcess } from 'node:child_process'
import { createId } from '@logicreader/shared'
import { logMain } from '../../util/ipc'
import type { AgentEvent, ConfigOption, PermissionDetail } from './types'

export const ACP_PROTOCOL_VERSION = 1

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

  request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('ACP 请求超时：' + method))
      }, this.options.timeoutMs ?? 120000)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method, timer })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  async initialize(capabilities: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: capabilities
    })
  }

  async newSession(cwd: string, mcpServers: unknown[] = []): Promise<{ sessionId: string; configOptions?: ConfigOption[] }> {
    const result = await this.request<{ sessionId: string; configOptions?: ConfigOption[] }>('session/new', { cwd, mcpServers })
    return result
  }

  async prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    return this.request<{ stopReason: string }>('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }]
    })
  }

  cancel(sessionId: string): void {
    this.notify('session/cancel', { sessionId })
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<ConfigOption[] | null> {
    try {
      const result = await this.request<{ configOptions?: ConfigOption[] }>('session/set_config_option', {
        sessionId,
        configId,
        value
      })
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
