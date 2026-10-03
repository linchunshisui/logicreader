/**
 * CLI 兜底适配器 —— 规划书 §4.5「兜底 CLI 参数」。
 *
 * 关键修复：
 * 1. 提示词优先通过 **stdin** 投递。整篇文档 / 分块文本作为命令行参数会突破
 *    Windows 约 32K 字符的命令行上限，导致 spawn 失败（这正是"Agent 不可用"的主因）。
 * 2. Claude Code 使用官方 \`--effort\` 标志，而不是拼 \`--settings\` JSON。
 * 3. 未显式选择模型时不传 \`--model\`，避免覆盖用户自身的 CLI 配置。
 * 4. 支持 \`--include-partial-messages\` 的 token 级流式增量。
 */
import { createId } from '@logicreader/shared'
import type { ChildProcess } from 'node:child_process'
import { logMain } from '../../util/ipc'
import { killTree, spawnAgent } from './exec'
import type { AgentEvent, AgentSessionHandle, PromptInput, SessionOptions } from './types'

/** Windows 命令行长度预算（留出余量） */
const ARGV_PROMPT_LIMIT = 6000

interface ParseState {
  sawStreamDelta: boolean
  contentBlocks: Map<number, { type: string; id?: string; name?: string }>
}

interface CliSpec {
  /** 是否支持用 stdin 投递提示词 */
  supportsStdin: boolean
  buildArgs: (input: PromptInput, options: SessionOptions) => string[]
  /** 解析一行输出；返回 true 表示已消费该行 */
  parseLine?: (line: string, emit: (event: AgentEvent) => void, state: ParseState) => boolean
}

function usageFrom(payload: Record<string, unknown>, emit: (event: AgentEvent) => void): void {
  const usage = (payload.usage ?? (payload.message as { usage?: unknown } | undefined)?.usage) as
    | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }
    | undefined
  if (!usage) return
  emit({
    type: 'usage',
    inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0
  })
}

export const CLI_SPECS: Record<string, CliSpec> = {
  'claude-code': {
    supportsStdin: true,
    buildArgs: (input, options) => {
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
      // 只有用户显式选了非默认模型才覆盖 CLI 自身配置
      if (input.modelId && input.modelId !== 'default') args.push('--model', input.modelId)
      if (input.thinkingEffort && input.thinkingEffort !== 'off') args.push('--effort', input.thinkingEffort)
      return args
    },
    parseLine: (line, emit, state) => {
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(line) as Record<string, unknown>
      } catch {
        return false
      }
      const type = String(payload.type ?? '')

      if (type === 'stream_event') {
        const event = payload.event as Record<string, unknown> | undefined
        const eventType = String(event?.type ?? '')
        if (eventType === 'content_block_start') {
          const block = event?.content_block as { type?: string; id?: string; name?: string } | undefined
          const index = Number(event?.index ?? 0)
          if (block?.type) state.contentBlocks.set(index, { type: block.type, id: block.id, name: block.name })
          if (block?.type === 'tool_use') {
            emit({ type: 'tool-call', id: String(block.id ?? createId('tool')), name: String(block.name ?? 'tool'), input: null })
          }
          return true
        }
        if (eventType === 'content_block_delta') {
          const delta = event?.delta as { type?: string; text?: string; thinking?: string } | undefined
          if (delta?.type === 'text_delta' && delta.text) {
            state.sawStreamDelta = true
            emit({ type: 'text-delta', text: delta.text })
          } else if (delta?.type === 'thinking_delta' && delta.thinking) {
            emit({ type: 'thinking', text: delta.thinking })
          } else if (delta?.type === 'input_json_delta') {
            // 工具入参增量：忽略，完整的入参在 assistant 消息里
          }
          return true
        }
        if (eventType === 'message_start') {
          usageFrom((event?.message ?? {}) as Record<string, unknown>, emit)
          return true
        }
        if (eventType === 'message_delta') {
          usageFrom(event as Record<string, unknown>, emit)
          return true
        }
        return true
      }

      if (type === 'assistant') {
        // 已有 token 级增量时不要重复输出整段文本
        if (state.sawStreamDelta) {
          usageFrom(payload, emit)
          return true
        }
        const message = payload.message as { content?: { type?: string; text?: string; name?: string; input?: unknown }[] } | undefined
        for (const block of message?.content ?? []) {
          if (block.type === 'text' && block.text) emit({ type: 'text-delta', text: block.text })
          if (block.type === 'tool_use') {
            emit({ type: 'tool-call', id: createId('tool'), name: String(block.name ?? 'tool'), input: block.input })
          }
        }
        usageFrom(payload, emit)
        return true
      }

      if (type === 'result') {
        usageFrom(payload, emit)
        const text = payload.result
        if (!state.sawStreamDelta && typeof text === 'string' && text.length > 0) {
          emit({ type: 'text-delta', text })
        }
        return true
      }

      if (type === 'system') return true
      return false
    }
  },

  codex: {
    /**
     * **兜底通道**：Codex 的首选接入是官方 `codex app-server`（见 codex.ts）。
     * 只有 app-server 起不来的老版本 CLI（没有该子命令）才会走到这里：
     * 一次性子进程，提示词走 stdin，没有会话级控制通道（不能中断回合、不能审批往返）。
     */
    supportsStdin: true,
    buildArgs: (input, options) => {
      const args = ['exec', '--json', '--sandbox', 'read-only', '-C', options.cwd]
      if (input.modelId && input.modelId !== 'default') args.push('-c', 'model="' + input.modelId + '"')
      if (input.thinkingEffort && input.thinkingEffort !== 'off') {
        args.push('-c', 'model_reasoning_effort="' + input.thinkingEffort + '"')
      }
      // 末尾的 "-" 表示从 stdin 读取提示词
      args.push('-')
      return args
    },
    parseLine: (line, emit) => {
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(line) as Record<string, unknown>
      } catch {
        return false
      }
      const type = String(payload.type ?? '')
      if (type === 'item.completed' || type === 'agent_message') {
        const text = (payload.text as string) ?? ((payload.item as { text?: string })?.text ?? '')
        if (text) emit({ type: 'text-delta', text })
        return true
      }
      if (type === 'item.started') {
        emit({
          type: 'tool-call',
          id: createId('tool'),
          name: String((payload.item as { type?: string })?.type ?? 'tool'),
          input: payload.item
        })
        return true
      }
      if (type === 'turn.completed') {
        usageFrom(payload, emit)
        return true
      }
      return false
    }
  },

  gemini: {
    supportsStdin: true,
    buildArgs: () => ['-p'],
    parseLine: undefined
  },

  dsh: {
    // 一次性 headless 任务：提示词作为任务参数
    supportsStdin: false,
    buildArgs: (input) => ['--profile', 'headless', input.text]
  }
}

export interface CliAdapterOptions {
  id: string
  executable: string
  prefixArgs: string[]
  spec: CliSpec
  label: string
}

export class CliSession implements AgentSessionHandle {
  readonly id: string
  readonly createdAt = Date.now()
  readonly remoteSessionId: string | null = null
  private child: ChildProcess | null = null
  private cancelled = false

  constructor(
    sessionId: string,
    private readonly executable: string,
    private readonly prefixArgs: string[],
    private readonly spec: CliSpec,
    private readonly options: SessionOptions,
    private readonly onEvent: (event: AgentEvent) => void
  ) {
    this.id = sessionId
  }

  async prompt(input: PromptInput): Promise<void> {
    this.cancelled = false
    const state: ParseState = { sawStreamDelta: false, contentBlocks: new Map() }
    const useStdin = this.spec.supportsStdin
    const promptInput: PromptInput = useStdin ? input : { ...input }
    if (!useStdin && input.text.length > ARGV_PROMPT_LIMIT) {
      this.onEvent({
        type: 'error',
        message:
          '提示词过长（' +
          input.text.length +
          ' 字符），当前 Agent 只支持通过命令行参数接收提示词。' +
          '请改用支持 stdin 的 Agent（如 Claude Code），或降低关系图的精度档位/分块大小。',
        retryable: false
      })
      return
    }

    const args = [...this.prefixArgs, ...this.spec.buildArgs(promptInput, this.options)]
    logMain('info', 'agent', '启动 CLI：' + this.executable + ' ' + args.slice(0, 6).join(' ') + (args.length > 6 ? ' …' : ''))

    const child = spawnAgent(this.executable, args, { cwd: this.options.cwd, timeoutMs: 20 * 60 * 1000 })
    this.child = child

    // 通过 stdin 投递提示词，规避 Windows 命令行长度上限
    if (useStdin) {
      try {
        child.stdin?.setDefaultEncoding('utf8')
        child.stdin?.write(input.text)
        child.stdin?.end()
      } catch (error) {
        logMain('warn', 'agent', '写入 stdin 失败', String(error))
      }
    }

    let emittedAny = false
    let buffer = ''
    let rawOutput = ''
    const emit = (event: AgentEvent): void => {
      if (event.type === 'text-delta') emittedAny = true
      this.onEvent(event)
    }

    const handleLine = (line: string): void => {
      const trimmed = line.trim()
      if (trimmed.length === 0) return
      rawOutput += trimmed + '\n'
      if (this.spec.parseLine) {
        const handled = this.spec.parseLine(trimmed, emit, state)
        if (handled) return
      }
      emittedAny = true
      this.onEvent({ type: 'text-delta', text: trimmed + '\n' })
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        handleLine(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
    })
    let stderrText = ''
    child.stderr?.on('data', (chunk: string) => {
      stderrText += chunk
    })

    const code: number | null = await new Promise((resolve) => {
      child.on('error', (error) => {
        logMain('error', 'agent', 'CLI 启动失败：' + this.executable, String(error))
        this.onEvent({
          type: 'error',
          message:
            '无法启动 ' + this.executable + '：' + error.message + '（可在设置 → Agent 中手动指定可执行文件路径）',
          retryable: true
        })
        resolve(-1)
      })
      child.on('close', (value) => resolve(value))
    })

    if (buffer.trim().length > 0) handleLine(buffer)

    if (this.cancelled) {
      this.onEvent({ type: 'done', stopReason: 'cancelled' })
      return
    }
    if (code !== 0) {
      const detail = (stderrText.trim() || rawOutput.trim() || '命令退出码 ' + String(code)).slice(0, 1200)
      logMain('warn', 'agent', 'CLI 退出码 ' + String(code), detail.slice(0, 500))
      this.onEvent({ type: 'error', message: detail, retryable: true })
      return
    }
    if (!emittedAny) {
      this.onEvent({
        type: 'error',
        message: 'Agent 没有返回任何内容' + (stderrText.trim() ? '：' + stderrText.trim().slice(0, 400) : ''),
        retryable: true
      })
      return
    }
    this.onEvent({ type: 'done', stopReason: 'end_turn' })
  }

  async cancel(): Promise<void> {
    this.cancelled = true
    killTree(this.child)
  }

  async dispose(): Promise<void> {
    await this.cancel()
    this.child = null
  }
}
