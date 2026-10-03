/**
 * 手工连线的规则：不许连自己、同方向不许重复、反向可以；
 * 以及"人工连线要留痕"（meta.manual，重生成时不被抹掉）。
 */
import { describe, expect, it } from 'vitest'
import type { EdgeKind, GraphEdge, GraphNode, LogicGraph } from '@logicreader/graph-schema'
import { canLinkNodes, createManualEdge } from '../apps/renderer/src/state/graphEdits'

const node = (id: string): GraphNode => ({
  id,
  kind: 'claim',
  title: id,
  summary: '',
  anchorIds: [],
  parentId: null,
  clusterId: null,
  x: 0,
  y: 0,
  collapsed: false
})

const edge = (id: string, from: string, to: string, kind: EdgeKind = 'supports'): GraphEdge => ({
  id,
  from,
  to,
  kind,
  label: '',
  anchorIds: [],
  weight: 1
})

const graph = (nodes: string[], edges: GraphEdge[]): LogicGraph => ({
  id: 'g1',
  docId: 'doc1',
  docHash: 'hash',
  title: 't',
  version: 1,
  createdAt: 0,
  updatedAt: 0,
  status: 'done',
  generation: {
    agentId: 'a',
    agentName: 'a',
    modelId: null,
    thinkingEffort: null,
    precision: 'structure',
    promptVersion: '1',
    scope: 'full'
  },
  nodes: nodes.map(node),
  edges,
  stats: {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    anchorCoverage: 1,
    failedChunks: 0,
    isolatedNodes: 0,
    avgEvidenceLength: 0,
    mergedEntities: 0,
    inputTokens: 0,
    outputTokens: 0,
    elapsedMs: 0,
    droppedUnanchored: 0
  }
})

describe('canLinkNodes', () => {
  it('两个存在的节点、同方向还没连过 → 允许', () => {
    expect(canLinkNodes(graph(['a', 'b'], []), 'a', 'b')).toEqual({ ok: true })
  })

  it('不许把节点连到它自己', () => {
    expect(canLinkNodes(graph(['a'], []), 'a', 'a')).toEqual({ ok: false, reason: 'self' })
  })

  it('同方向已有连线 → 判重（手一抖连两条，图上还看不出来）', () => {
    expect(canLinkNodes(graph(['a', 'b'], [edge('e1', 'a', 'b')]), 'a', 'b')).toEqual({
      ok: false,
      reason: 'duplicate'
    })
  })

  it('反向可以再连一条（"A 支持 B" 与 "B 反对 A" 是两条关系）', () => {
    expect(canLinkNodes(graph(['a', 'b'], [edge('e1', 'a', 'b')]), 'b', 'a')).toEqual({ ok: true })
  })

  it('节点不存在 / 图还没加载 → 拒绝', () => {
    expect(canLinkNodes(graph(['a', 'b'], []), 'a', 'zzz')).toEqual({ ok: false, reason: 'missing-node' })
    expect(canLinkNodes(null, 'a', 'b')).toEqual({ ok: false, reason: 'no-graph' })
  })
})

describe('createManualEdge', () => {
  it('打上 manual 标记并带上依据锚点（重生成时不被覆盖；跳转仍可落到原文）', () => {
    const created = createManualEdge({
      id: 'e-manual',
      from: 'a',
      to: 'b',
      kind: 'references',
      label: '前提',
      anchorIds: ['anc-1'],
      evidence: '人工建立的关系',
      createdAt: 123
    })
    expect(created).toMatchObject({
      id: 'e-manual',
      from: 'a',
      to: 'b',
      kind: 'references',
      label: '前提',
      anchorIds: ['anc-1'],
      weight: 1
    })
    expect(created.meta).toMatchObject({ manual: true, createdAt: 123, evidence: '人工建立的关系' })
  })

  it('没有锚点时留空数组（跳转会明确提示"无原文依据"，而不是假装有依据）', () => {
    const created = createManualEdge({ id: 'e2', from: 'a', to: 'b', kind: 'elaborates' })
    expect(created.anchorIds).toEqual([])
    expect(created.label).toBe('')
  })
})
