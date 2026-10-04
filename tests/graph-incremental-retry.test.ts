import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * 增量重试与历史校准的集成测试（主进程 graph.service，mock 掉 Agent 通道）。
 *
 * 回归背景（§52"重试失败块"是假的）：
 *  - 旧实现里 IPC `graph:retry-failed-chunks` 只是带着同一个 graphId **全量重跑所有分块**，
 *    失败 1 块也要把整篇重新抽一遍 —— token 与时间双倍烧；
 *  - 旧实现里 `graphs.stats_json` 记了 `elapsedMs` 却从来没人读，生成前的耗时预估
 *    只按 token 比例拍，与实测（单块分钟级、整篇 11 分钟）脱节一个数量级。
 */

const runOnceMock = vi.fn()
vi.mock('../apps/main/src/services/agent/runtime', () => ({
  agentRuntime: { runOnce: (...args: unknown[]) => runOnceMock(...args) }
}))

vi.mock('../apps/main/src/services/settings.service', () => ({
  settingsService: {
    all: () => ({
      graph: {
        concurrency: 3,
        targetNodeLimit: 200,
        entityResolutionThreshold: 0.88,
        edgeKinds: ['causes', 'supports', 'refutes', 'elaborates', 'contrasts', 'sequences', 'defines', 'references', 'inquiry']
      }
    })
  }
}))

import { storeService } from '../apps/main/src/services/store.service'
import { graphService } from '../apps/main/src/services/graph.service'
import { emptyStats, type LogicGraph } from '../packages/graph-schema/src/index'

/** 临时 SQLite 库：每条用例独立文件，跑完即删。 */
const state = { file: '' }
beforeEach(() => {
  state.file = require('node:os').tmpdir() + '/lr-graph-test-' + Math.random().toString(36).slice(2) + '.db'
  storeService.open(state.file)
  runOnceMock.mockReset()
})

/** 模型返回固定的一段抽取 JSON（spans 按提示词给的块区间取值，保证"落在本块内"）。 */
function stubExtraction(name: string): void {
  runOnceMock._stub = async (req: { prompt: string }) => {
    const match = /\[\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(req.prompt)
    const start = match ? Number(match[1]) : 0
    const end = match ? Number(match[2]) : 100
    const half = Math.max(2, Math.floor((end - start) / 2))
    const nameB = name + '据'
    return {
      text: JSON.stringify({
        entities: [
          { name, type: 'claim', summary: '摘要', evidence: '原文依据', spans: [{ charStart: start, charEnd: start + half }] },
          { name: nameB, type: 'evidence', summary: '证据摘要', evidence: '证据原文', spans: [{ charStart: start + half, charEnd: end }] }
        ],
        relations: [
          { from: name, to: nameB, type: 'supports', label: '支持', evidence: '证据原文', spans: [{ charStart: start, charEnd: end }] }
        ]
      }),
      sessionId: 'sess_mock'
    }
  }
  runOnceMock.mockImplementation(runOnceMock._stub)
}

function saveDoc(docId: string): void {
  storeService.upsertDocument({
    id: docId,
    path: 'C:/doc.md',
    format: 'markdown',
    title: '测试文档',
    docHash: 'hash-' + docId,
    sizeBytes: 100,
    pageCount: null,
    textLength: 400,
    outlineJson: '[]',
    openedAt: Date.now(),
    lastPage: 1,
    metaJson: null
  })
  storeService.saveBlocks(
    docId,
    Array.from({ length: 4 }, (_, index) => ({
      id: 'b' + index,
      docId,
      seq: index,
      kind: 'paragraph',
      level: null,
      text: '这是第' + index + '段的测试内容，用来撑起一个分块。',
      charStart: index * 100,
      charEnd: (index + 1) * 100,
      locatorJson: JSON.stringify({ kind: 'text', line: index + 1, column: 0 }),
      parentId: null
    }))
  )
}

/** 所有用例都传 chunkTokens=1（每块一段），让 4 个块保持独立 —— 测试关心的是分块编排，不是分块策略。 */
const BASE = { agentId: 'mock', precision: 'structure' as const, chunkTokens: 1, locale: 'zh-CN' }

describe('增量重试：只重跑失败的分块', () => {
  it('retryChunkIndexes 指定时，Map 阶段只调那几块，其余抽取从旧图继承', async () => {
    const docId = 'doc_retry'
    saveDoc(docId)

    // 第一轮：4 块里第 2 块失败（该块的每一轮都返回垃圾），其余成功
    stubExtraction('概念甲')
    runOnceMock.mockImplementation(async (req: { prompt: string }) => {
      if (req.prompt.includes('[ 21, 41 )')) return { text: '这不是 JSON', sessionId: 's' }
      return runOnceMock._stub(req)
    })
    const first = (await graphService.generate(
      { docId, graphId: null, ...BASE, concurrency: 1 },
      () => undefined
    )) as LogicGraph
    expect(first.stats.chunkCount).toBe(4)
    expect(first.stats.failedChunkIndexes).toEqual([1])

    // 第二轮：只重跑失败的下标 1；其余从 first 继承。模型这次表现正常
    stubExtraction('概念乙')
    runOnceMock.mockClear()
    const second = (await graphService.generate(
      {
        docId,
        graphId: first.id,
        ...BASE,
        concurrency: 1,
        retryChunkIndexes: [1]
      },
      () => undefined
    )) as LogicGraph

    // 只烧了 1 次模型调用（旧实现是 4 次）
    expect(runOnceMock).toHaveBeenCalledTimes(1)
    // 继承 + 新抽取：节点数不少于第一轮
    expect(second.nodes.length).toBeGreaterThanOrEqual(first.nodes.length)
    expect(second.stats.chunkCount).toBe(1)
    expect(second.stats.failedChunks).toBe(0)
    // 保留了原 id（还是同一张图）
    expect(second.id).toBe(first.id)
  })

  it('没有失败分块时 retryChunkIndexes 为空 → 正常全量语义不受影响', async () => {
    const docId = 'doc_full'
    saveDoc(docId)
    stubExtraction('概念丙')
    const graph = (await graphService.generate(
      { docId, graphId: null, ...BASE, concurrency: 2 },
      () => undefined
    )) as LogicGraph
    expect(graph.stats.chunkCount).toBe(4)
    expect(graph.stats.failedChunks).toBe(0)
    expect(graph.stats.failedChunkIndexes).toEqual([])
  })
})

describe('重试失败块：严格只重跑失败的分块（本轮收紧）', () => {
  it('重试按旧图 generation 复现分块：请求里改了 chunkTokens 也不会指错块', async () => {
    const docId = 'doc_cfg'
    saveDoc(docId)

    // 第一轮（chunkTokens=1，4 块）：第 2 块失败
    stubExtraction('概念配置')
    runOnceMock.mockImplementation(async (req: { prompt: string }) => {
      if (req.prompt.includes('[ 21, 41 )')) return { text: '这不是 JSON', sessionId: 's' }
      return runOnceMock._stub(req)
    })
    const first = (await graphService.generate(
      { docId, graphId: null, ...BASE, concurrency: 1 },
      () => undefined
    )) as LogicGraph
    expect(first.stats.failedChunkIndexes).toEqual([1])
    expect(first.generation.chunkTokens).toBe(1)

    // 第二轮：请求里故意带一个**不同的** chunkTokens（500 会把 4 块合并成 1 块）——
    // 必须仍按旧图的 chunkTokens=1 分块，重跑的仍然是下标 1
    stubExtraction('概念新词')
    runOnceMock.mockClear()
    const second = (await graphService.generate(
      {
        docId,
        graphId: first.id,
        ...BASE,
        chunkTokens: 500,
        concurrency: 1,
        retryChunkIndexes: [1]
      },
      () => undefined
    )) as LogicGraph
    // 分块按旧图复现：确实只跑了 1 次模型调用，且它的区间是第 1 块的 [21, 41)
    expect(runOnceMock).toHaveBeenCalledTimes(1)
    const promptedRange = /\[\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(runOnceMock.mock.calls[0][0].prompt)
    expect(promptedRange?.slice(1)).toEqual(['21', '41'])
    // 重试的 generation 记录仍是复现配置（chunkTokens=1），不是请求里的 500
    expect(second.generation.chunkTokens).toBe(1)
  })

  it('继承连线保留原权重：重试不会把权重≥2 的边误删', async () => {
    const docId = 'doc_w'
    saveDoc(docId)

    // 第一轮：同一条边在 2 个分块里被抽到（权重 2）；另 1 块失败
    stubExtraction('概念权重')
    runOnceMock.mockImplementation(async (req: { prompt: string }) => {
      if (req.prompt.includes('[ 21, 41 )')) return { text: '这不是 JSON', sessionId: 's' }
      return runOnceMock._stub(req)
    })
    const first = (await graphService.generate(
      { docId, graphId: null, ...BASE, concurrency: 1 },
      () => undefined
    )) as LogicGraph
    expect(first.stats.failedChunkIndexes).toEqual([1])
    const heavyEdge = first.edges.find((edge) => edge.weight >= 2)
    expect(heavyEdge).toBeDefined()

    // 第二轮：只重跑失败块 1；结构档 minEdgeWeight=2 对 4 块文档生效（chunks>3）
    stubExtraction('概念权重')
    runOnceMock.mockClear()
    const second = (await graphService.generate(
      { docId, graphId: first.id, ...BASE, concurrency: 1, retryChunkIndexes: [1] },
      () => undefined
    )) as LogicGraph
    // 那条重边必须还在（继承权重）。节点在重试中会重建（新 id），按标题定位
    const titleOf = new Map(first.nodes.map((node) => [node.id, node.title]))
    const heavyFrom = titleOf.get(heavyEdge!.from)
    const heavyTo = titleOf.get(heavyEdge!.to)
    const kept = second.edges.find(
      (edge) =>
        (second.nodes.find((node) => node.id === edge.from)?.title ?? edge.from) === heavyFrom &&
        (second.nodes.find((node) => node.id === edge.to)?.title ?? edge.to) === heavyTo &&
        edge.kind === heavyEdge!.kind
    )
    expect(kept).toBeDefined()
    expect(kept!.weight).toBeGreaterThanOrEqual(2)
  })

  it('分块边界已变化（下标全部越界）→ 明确报错，而不是静默跑空', async () => {
    const docId = 'doc_stale'
    saveDoc(docId)
    stubExtraction('概念越界')
    const first = (await graphService.generate(
      { docId, graphId: null, ...BASE, concurrency: 1 },
      () => undefined
    )) as LogicGraph
    // 文档被"重新解析"成分块完全不同的形态：块数从 4 变 1
    storeService.saveBlocks(
      docId,
      [{
        id: 'b0', docId, seq: 0, kind: 'paragraph', level: null,
        text: '全部内容合并成了一大段。',
        charStart: 0, charEnd: 12,
        locatorJson: JSON.stringify({ kind: 'text', line: 1, column: 0 }), parentId: null
      }]
    )
    // 旧图的失败下标是 1（第 2 块）；现在只有 1 块（下标 0），下标 1 已不存在
    await expect(
      graphService.generate(
        { docId, graphId: first.id, ...BASE, concurrency: 1, retryChunkIndexes: [1] },
        () => undefined
      )
    ).rejects.toThrow('分块边界已变化')
  })

  it('重试成功后 failedChunkIndexes 清空（再次点"重试"会被界面拦下）', async () => {
    const docId = 'doc_clear'
    saveDoc(docId)
    stubExtraction('概念清空')
    runOnceMock.mockImplementation(async (req: { prompt: string }) => {
      if (req.prompt.includes('[ 21, 41 )')) return { text: '这不是 JSON', sessionId: 's' }
      return runOnceMock._stub(req)
    })
    const first = (await graphService.generate(
      { docId, graphId: null, ...BASE, concurrency: 1 },
      () => undefined
    )) as LogicGraph
    expect(first.stats.failedChunkIndexes).toEqual([1])

    stubExtraction('概念清空')
    const second = (await graphService.generate(
      { docId, graphId: first.id, ...BASE, concurrency: 1, retryChunkIndexes: [1] },
      () => undefined
    )) as LogicGraph
    expect(second.stats.failedChunkIndexes).toEqual([])
    expect(second.stats.failedChunks).toBe(0)
    expect(second.status).toBe('done')
  })
})

describe('历史校准：elapsedMs / 波数落库，能被下一次预估读到', () => {
  it('成功生成后 stats 带 chunkCount/waveCount/chunkChars，graphHistoryElapsed 能取到样本', async () => {
    const docId = 'doc_hist'
    saveDoc(docId)
    stubExtraction('概念丁')
    const graph = (await graphService.generate(
      { docId, graphId: null, ...BASE, concurrency: 2 },
      () => undefined
    )) as LogicGraph

    expect(graph.stats.chunkCount).toBe(4)
    expect(graph.stats.waveCount).toBe(2)
    expect(graph.stats.chunkChars).toBeGreaterThan(0)
    expect(graph.stats.elapsedMs).toBeGreaterThanOrEqual(0)

    const samples = storeService.graphHistoryElapsed(docId, 3)
    expect(samples.length).toBe(1)
    expect(samples[0].chunkCount).toBe(4)
    expect(samples[0].concurrency).toBe(2)

    // 历史能被纯函数消费：给一个合理区间
    const { estimateMinutesFromHistory } = await import('../apps/main/src/services/graph.service')
    const estimate = estimateMinutesFromHistory(samples, 4, 2)
    expect(estimate).not.toBeNull()
    expect(estimate!.minutes[0]).toBeGreaterThanOrEqual(1)
  })

  it('失败的图不入库：不会污染历史样本（旧实现空图也会盖掉好图）', async () => {
    const docId = 'doc_empty'
    saveDoc(docId)
    runOnceMock.mockImplementation(async () => ({ text: '这不是 JSON', sessionId: 's' }))
    const graph = (await graphService.generate(
      { docId, graphId: null, ...BASE, concurrency: 2 },
      () => undefined
    )) as LogicGraph
    expect(graph.nodes.length).toBe(0)
    expect(storeService.graphHistoryElapsed(docId, 3)).toEqual([])
    void emptyStats
  })
})
