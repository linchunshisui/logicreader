import { describe, expect, it } from 'vitest'
import { LOCAL_MAP, layoutLocalMap } from '../apps/renderer/src/lib/localMap'
import type { GraphEdge, GraphNode } from '@logicreader/graph-schema'

/**
 * 「局部关系图」的几何契约。
 *
 * 面板只有 320px 宽，坐标一旦错，箭头就会浮在两个盒子之间或压在文字上。
 * 这些断言全部是**等式**（避坑指南 §7.7）：不靠眼睛看截图。
 */
function node(id: string): GraphNode {
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
    collapsed: false
  }
}

function edge(id: string, from: string, to: string, weight = 1): GraphEdge {
  return { id, from, to, kind: 'supports', label: '', anchorIds: [], weight }
}

function endpoints(d: string): { x1: number; y1: number; x2: number; y2: number } {
  const match = /^M (\S+) (\S+) C .*, (\S+) (\S+)$/.exec(d)
  if (!match) throw new Error('看不懂的路径：' + d)
  return { x1: Number(match[1]), y1: Number(match[2]), x2: Number(match[3]), y2: Number(match[4]) }
}

describe('局部关系图布局', () => {
  it('三列宽度严丝合缝，中心节点在中列', () => {
    const layout = layoutLocalMap('c', [node('c'), node('a')], [edge('e1', 'a', 'c')])
    expect(layout).not.toBeNull()
    const map = layout!
    expect(map.center.x).toBe(LOCAL_MAP.peerWidth + LOCAL_MAP.gapX)
    expect(map.center.x + map.center.width + LOCAL_MAP.gapX + LOCAL_MAP.peerWidth).toBe(map.width)
  })

  it('指向它的排左列、由它指向的排右列', () => {
    const map = layoutLocalMap(
      'c',
      [node('c'), node('a'), node('b')],
      [edge('e1', 'a', 'c'), edge('e2', 'c', 'b')]
    )!
    const inPeer = map.peers.find((peer) => peer.node.id === 'a')!
    const outPeer = map.peers.find((peer) => peer.node.id === 'b')!
    expect(inPeer.direction).toBe('in')
    expect(inPeer.x).toBe(0)
    expect(outPeer.direction).toBe('out')
    expect(outPeer.x).toBe(map.width - LOCAL_MAP.peerWidth)
  })

  it('连线的两端恰好落在两个盒子的边缘中心（不悬空、不压字）', () => {
    const map = layoutLocalMap(
      'c',
      [node('c'), node('a'), node('b')],
      [edge('e1', 'a', 'c'), edge('e2', 'c', 'b')]
    )!
    const centerMid = map.center.y + map.center.height / 2
    const inPeer = map.peers.find((peer) => peer.node.id === 'a')!
    const inLink = map.links.find((link) => link.edge.id === 'e1')!
    const inEnds = endpoints(inLink.d)
    expect(inEnds.x1).toBe(inPeer.x + inPeer.width) // 对端右边缘
    expect(inEnds.y1).toBe(inPeer.y + inPeer.height / 2)
    expect(inEnds.x2).toBe(map.center.x) // 中心左边缘
    expect(inEnds.y2).toBe(centerMid)

    const outPeer = map.peers.find((peer) => peer.node.id === 'b')!
    const outEnds = endpoints(map.links.find((link) => link.edge.id === 'e2')!.d)
    expect(outEnds.x1).toBe(map.center.x + map.center.width)
    expect(outEnds.y1).toBe(centerMid)
    expect(outEnds.x2).toBe(outPeer.x)
    expect(outEnds.y2).toBe(outPeer.y + outPeer.height / 2)
  })

  it('同一对节点之间的多条关系只画一条，代表取权重最高的那条', () => {
    const map = layoutLocalMap(
      'c',
      [node('c'), node('a')],
      [edge('weak', 'a', 'c', 1), edge('strong', 'a', 'c', 5)]
    )!
    expect(map.peers).toHaveLength(1)
    expect(map.peers[0].multi).toBe(2)
    expect(map.peers[0].edge.id).toBe('strong')
    expect(map.links).toHaveLength(1)
  })

  it('每侧超出上限的邻居不画，但要在 hidden 里报数（面板用"还有 N 个"提示）', () => {
    const nodes = [node('c'), node('a'), node('b'), node('d'), node('e')]
    const edges = [
      edge('e1', 'a', 'c'),
      edge('e2', 'b', 'c'),
      edge('e3', 'd', 'c'),
      edge('e4', 'c', 'e')
    ]
    const map = layoutLocalMap('c', nodes, edges, { maxPerSide: 2 })!
    expect(map.peers.filter((peer) => peer.direction === 'in')).toHaveLength(2)
    expect(map.hidden.in).toBe(1)
    expect(map.hidden.out).toBe(0)
  })

  it('中心节点不在图里就返回 null（图被换过 / 节点被删）', () => {
    expect(layoutLocalMap('missing', [node('c')], [])).toBeNull()
  })

  it('忽略自环与指向已消失节点的边（画不出对端盒子）', () => {
    const map = layoutLocalMap(
      'c',
      [node('c'), node('a')],
      [edge('self', 'c', 'c'), edge('ghost', 'ghost', 'c'), edge('ok', 'a', 'c')]
    )!
    expect(map.peers.map((peer) => peer.node.id)).toEqual(['a'])
    expect(map.links).toHaveLength(1)
  })

  it('高度随邻居数量增长（左右取高的一侧）', () => {
    const one = layoutLocalMap('c', [node('c'), node('a')], [edge('e1', 'a', 'c')])!
    const three = layoutLocalMap(
      'c',
      [node('c'), node('a'), node('b'), node('d')],
      [edge('e1', 'a', 'c'), edge('e2', 'b', 'c'), edge('e3', 'd', 'c')]
    )!
    expect(three.height).toBeGreaterThan(one.height)
    // 三行 = 3*36 + 2*6 = 120，加上下内边距 12
    expect(three.height).toBe(132)
  })
})
