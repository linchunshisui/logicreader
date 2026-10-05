import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode } from '@logicreader/graph-schema'
import { degreesOf, GRAPH_NODE_BASE_HEIGHT, GRAPH_NODE_BASE_WIDTH, GRAPH_NODE_MAX_SCALE, nodeScaleOf, nodeSizeOf } from './graphNodeSize'

function node(id: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind: 'claim',
    title: id,
    summary: '',
    anchorIds: [],
    parentId: null,
    clusterId: null,
    x: null,
    y: null,
    collapsed: false,
    ...extra
  }
}

function edge(from: string, to: string, weight = 1): GraphEdge {
  return { id: from + '>' + to, from, to, kind: 'supports', label: '', anchorIds: [], weight }
}

describe('度数分级', () => {
  it('度数按边权累加（枢纽判据用加权度，不是简单计数）', () => {
    const degrees = degreesOf([edge('a', 'b', 3), edge('a', 'c', 1)])
    expect(degrees.get('a')).toBe(4)
    expect(degrees.get('b')).toBe(3)
    expect(degrees.get('c')).toBe(1)
  })

  it('无边的节点度数为 0（不出现在表里）', () => {
    expect(degreesOf([edge('a', 'b')]).get('z')).toBeUndefined()
  })

  it('尺寸系数：无连接为 1、最高度为上限、中间单调', () => {
    expect(nodeScaleOf(0, 10)).toBe(1)
    expect(nodeScaleOf(10, 10)).toBeCloseTo(GRAPH_NODE_MAX_SCALE)
    const low = nodeScaleOf(2, 10)
    const high = nodeScaleOf(8, 10)
    expect(high).toBeGreaterThan(low)
    expect(low).toBeGreaterThan(1)
  })

  it('maxDegree 为 0 时不放大（避免除零把所有点变成最大）', () => {
    expect(nodeScaleOf(3, 0)).toBe(1)
  })

  it('章节节点不参与重要性分级（它是结构件，尺寸固定）', () => {
    const section = node('sec', { meta: { isSection: true } })
    const size = nodeSizeOf(section, 99, 100)
    expect(size.scale).toBe(1)
    expect(size.width).toBe(GRAPH_NODE_BASE_WIDTH)
    expect(size.height).toBeLessThan(GRAPH_NODE_BASE_HEIGHT)
  })

  it('普通节点尺寸随系数放大，布局与渲染拿到同一个盒子', () => {
    const plain = node('n1')
    const size = nodeSizeOf(plain, 10, 10)
    expect(size.scale).toBeCloseTo(GRAPH_NODE_MAX_SCALE)
    expect(size.width).toBe(Math.round(GRAPH_NODE_BASE_WIDTH * GRAPH_NODE_MAX_SCALE))
    expect(size.height).toBe(Math.round(GRAPH_NODE_BASE_HEIGHT * GRAPH_NODE_MAX_SCALE))
  })
})
