/**
 * MockAdapter —— 规划书 §11「Agent 测试」：
 * 让 UI、上下文组装、关系图抽取在 CI 中不依赖真实模型与配额。
 */
import { createId } from '@logicreader/shared'
import type { AgentAdapter, AgentCapability, AgentEvent, AgentSessionHandle, PromptInput, SessionOptions } from './types'

const MOCK_MODELS = ['mock-fast', 'mock-balanced', 'mock-deep']

export class MockAdapter implements AgentAdapter {
  readonly id: string
  readonly kind = 'custom' as const
  readonly protocol = 'mock' as const

  constructor(id = 'mock') {
    this.id = id
  }

  async probe(): Promise<AgentCapability> {
    return {
      id: this.id,
      kind: 'custom',
      displayName: 'Mock Agent（离线演示）',
      protocol: 'mock',
      available: true,
      version: 'mock-1.0',
      executable: null,
      launchArgs: [],
      supportsAcp: false,
      supportsSdk: false,
      supportsResume: false,
      supportsStreaming: true,
      supportsModel: true,
      supportsThoughtLevel: true,
      models: MOCK_MODELS.map((id) => ({
        id,
        name: id,
        thoughtLevels: [
          { id: 'low', name: '低' },
          { id: 'medium', name: '中' },
          { id: 'high', name: '高' }
        ],
        defaultThoughtLevel: 'medium'
      })),
      configOptions: [
        {
          id: 'model',
          name: '模型',
          category: 'model',
          type: 'select',
          currentValue: MOCK_MODELS[1],
          options: MOCK_MODELS.map((id) => ({ value: id, name: id }))
        },
        {
          id: 'thought_level',
          name: '思考强度',
          category: 'thought_level',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'low', name: '低' },
            { value: 'medium', name: '中' },
            { value: 'high', name: '高' }
          ]
        }
      ],
      defaultModel: MOCK_MODELS[1],
      defaultThoughtLevel: 'medium',
      error: null,
      probedAt: Date.now(),
      builtin: false
    }
  }

  async start(options: SessionOptions, onEvent: (event: AgentEvent) => void): Promise<AgentSessionHandle> {
    const id = createId('sess')
    let cancelled = false
    let currentValue = options.modelId ?? 'mock-balanced'
    const stream = async (input: PromptInput): Promise<void> => {
      cancelled = false
      const answer = buildAnswer(input, currentValue)
      onEvent({ type: 'thinking', text: '正在阅读上下文并组织答案…' })
      await sleep(160)
      // 工具调用与结果必须用**同一个 id**：否则界面永远停在"进行中"（真实适配层也是这个约定）
      const toolId = createId('tool')
      onEvent({ type: 'tool-call', id: toolId, name: 'read_document', input: { chars: input.text.length }, title: '读取文档片段' })
      await sleep(160)
      onEvent({ type: 'tool-result', id: toolId, name: 'read_document', output: { ok: true }, isError: false })
      const chunks = splitChunks(answer)
      for (const chunk of chunks) {
        if (cancelled) {
          onEvent({ type: 'done', stopReason: 'cancelled' })
          return
        }
        onEvent({ type: 'text-delta', text: chunk })
        await sleep(18)
      }
      onEvent({ type: 'usage', inputTokens: Math.ceil(input.text.length / 3), outputTokens: Math.ceil(answer.length / 3) })
      onEvent({ type: 'done', stopReason: 'end_turn' })
    }
    return {
      id,
      remoteSessionId: 'mock-' + id,
      prompt: async (input) => {
        await stream(input)
        // 冒烟用：写入模式（路径逐字取自提示词里的 mock-write:，避免中文路径编码问题）
        const match = /mock-write:(\S+)/.exec(input.text)
        if (match) {
          const { writeFileSync, mkdirSync } = await import('node:fs')
          const { dirname } = await import('node:path')
          const target = match[1].replace(/"/g, '')
          try {
            mkdirSync(dirname(target), { recursive: true })
            writeFileSync(target, 'alpha\nCHANGED\ncharlie\n', 'utf8')
          } catch (error) {
            console.error('[mock] 写入失败', String(error))
          }
        }
      },
      cancel: async () => {
        cancelled = true
      },
      dispose: async () => {
        cancelled = true
      },
      setConfigOption: async (optionId, value) => {
        if (optionId === 'model' && typeof value === 'string') currentValue = value
      }
    }
  }
}

function splitChunks(text: string): string[] {
  const out: string[] = []
  let cursor = 0
  while (cursor < text.length) {
    const size = 4 + Math.floor(Math.random() * 10)
    out.push(text.slice(cursor, cursor + size))
    cursor += size
  }
  return out
}

/** 抽取类提示词：合成合法 JSON，让关系图管线可以离线端到端验证。 */
function tryExtraction(input: PromptInput): string | null {
  const match = /\[\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(input.text)
  if (!match) return null
  const isExtraction = input.text.includes('只输出 JSON') || input.text.includes('Output JSON only')
  if (!isExtraction) return null
  const start = Number(match[1])
  const end = Number(match[2])
  const span = Math.max(1, Math.min(end - start, 400))
  const trim = (value: string): string => value.replace(/\s+/g, ' ').trim()
  const bodyStart = input.text.indexOf('【片段原文】') >= 0 ? input.text.indexOf('【片段原文】') + 6 : input.text.indexOf('[FRAGMENT]') + 10
  const body = trim(input.text.slice(bodyStart, bodyStart + 700))
  const topics = body
    .split(/[。.!?；;\n]/)
    .map((sentence) => trim(sentence))
    .filter((sentence) => sentence.length >= 8)
    .slice(0, 3)
  const entities = (topics.length > 0 ? topics : ['未命名论点']).map((sentence, index) => ({
    name: sentence.slice(0, 14),
    type: index === 0 ? 'claim' : index === 1 ? 'evidence' : 'definition',
    summary: sentence.slice(0, 40),
    evidence: sentence.slice(0, 60),
    spans: [{ charStart: start + Math.min(index * 40, Math.max(0, span - 20)), charEnd: start + Math.min(index * 40 + 20, span) }]
  }))
  const relations = entities.slice(1).map((entity, index) => ({
    from: entities[index].name,
    to: entity.name,
    type: index % 2 === 0 ? 'supports' : 'elaborates',
    label: '支持',
    evidence: entity.evidence,
    spans: entity.spans
  }))
  return JSON.stringify({ entities, relations })
}

function buildAnswer(input: PromptInput, model: string): string {
  const extraction = tryExtraction(input)
  if (extraction) return extraction
  const quoted = input.text.length > 220 ? input.text.slice(0, 220) + '…' : input.text
  return [
    '（Mock Agent · ' + model + '）',
    '',
    '这是一段离线生成的示例回答，用于验证流式渲染、工具卡片与提问入图链路。',
    '',
    '你提供的上下文摘要：',
    quoted,
    '',
    '结论：逻辑阅读器的 Agent 通道工作正常。'
  ].join('\n')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
