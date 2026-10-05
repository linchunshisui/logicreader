import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode } from '@logicreader/graph-schema'
import { buildAggregatedGraph, computeCommunities } from './graphClusters'

/**
 * 社区检测与折叠的单测。
 *
 * 为什么必须钉住：聚合视图的"分组对不对"没法靠眼睛判 —— 两个三角形被一条边连着，
 * 分成两团是正解、分成一团或三团都是错的，而图上看起来都"像那么回事"。
 */

function node(id: string, title = id): GraphNode {
  return {
    id,
    kind: 'claim',
    title,
    summary: '',
    anchorIds: ['anchor-' + id],
    parentId: null,
    clusterId: null,
    x: 0,
    y: 0,
    collapsed: false
  }
}

function edge(from: string, to: string, kind: GraphEdge['kind'] = 'supports', weight = 1): GraphEdge {
  return { id: from + '->' + to, from, to, kind, label: '', anchorIds: [], weight }
}

/** 两个三角形，中间只有一条边相连：正解是两个社区。 */
function twoTriangles(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  return {
    nodes: [node('a1', '甲'), node('a2', '乙乙乙'), node('a3', '丙丙'), node('b1', '丁'), node('b2', '戊戊戊'), node('b3', '己己')],
    edges: [
      edge('a1', 'a2'),
      edge('a2', 'a3'),
      edge('a3', 'a1'),
      edge('b1', 'b2'),
      edge('b2', 'b3'),
      edge('b3', 'b1'),
      edge('a1', 'b1')
    ]
  }
}

describe('社区检测', () => {
  it('两个稠密三角形 + 一条弱连接 → 分成两个社区', () => {
    const { nodes, edges } = twoTriangles()
    const communities = computeCommunities(nodes, edges)
    const a = new Set(['a1', 'a2', 'a3'].map((id) => communities.get(id)))
    const b = new Set(['b1', 'b2', 'b3'].map((id) => communities.get(id)))
    expect(a.size).toBe(1)
    expect(b.size).toBe(1)
    expect([...a][0]).not.toBe([...b][0])
  })

  it('一条边都没有时，每个节点自成一社区（不并成一颗大球）', () => {
    const nodes = [node('n1'), node('n2'), node('n3')]
    const communities = computeCommunities(nodes, [])
    expect(new Set([...communities.values()]).size).toBe(3)
  })

  it('空图返回空映射，不抛错', () => {
    expect(computeCommunities([], []).size).toBe(0)
  })

  it('自环与指向不存在节点的边被忽略', () => {
    const nodes = [node('n1'), node('n2')]
    const edges = [edge('n1', 'n1'), edge('n1', 'ghost')]
    // 没有可用边 → 各成一社区
    const communities = computeCommunities(nodes, edges)
    expect(new Set([...communities.values()]).size).toBe(2)
  })

  it('同一张图重算结果稳定（固定种子，不随 Math.random 抖动）', () => {
    const { nodes, edges } = twoTriangles()
    const first = [...computeCommunities(nodes, edges).entries()].sort()
    const second = [...computeCommunities(nodes, edges).entries()].sort()
    expect(second).toEqual(first)
  })
})

describe('折叠成超级节点', () => {
  it('两个社区 → 两个超级节点，各 3 个成员', () => {
    const { nodes, edges } = twoTriangles()
    const folded = buildAggregatedGraph(nodes, edges)
    expect(folded.clusters).toHaveLength(2)
    expect(folded.clusters.map((cluster) => cluster.size).sort()).toEqual([3, 3])
  })

  it('超级节点 id 取成员里最小的 id（成员不变则 id 不变）', () => {
    const { nodes, edges } = twoTriangles()
    const ids = buildAggregatedGraph(nodes, edges).clusters.map((cluster) => cluster.id).sort()
    expect(ids).toEqual(['cluster:a1', 'cluster:b1'])
  })

  it('代表成员取社区内连接度最高者', () => {
    const { nodes, edges } = twoTriangles()
    const clusterA = buildAggregatedGraph(nodes, edges).clusters.find((cluster) => cluster.id === 'cluster:a1')
    // 三角形里三人连接度都是 2，按"标题最短"破平 → a1 的「甲」
    expect(clusterA?.title).toBe('甲')
  })

  /**
   * 断言**不依赖** Louvain 具体怎么分组 —— 那属于它自己的实现细节，我们只承诺
   * "按真实分区把跨社区边按社区对合并、权重累计"。按真实分区算期望值，再比对。
   */
  it('跨社区的边按"社区对"合并，权重累计', () => {
    const base = twoTriangles()
    const edges = [...base.edges, edge('a2', 'b2', 'causes', 3)]
    const view = buildAggregatedGraph(base.nodes, edges)

    const clusterOf = new Map<string, string>()
    for (const cluster of view.clusters) for (const member of cluster.members) clusterOf.set(member.id, cluster.id)

    const groups = new Map<string, number>()
    for (const item of edges) {
      const from = clusterOf.get(item.from)
      const to = clusterOf.get(item.to)
      if (!from || !to || from === to) continue
      const key = [from, to].sort().join('>')
      groups.set(key, (groups.get(key) ?? 0) + Math.max(1, item.weight || 1))
    }

    expect(view.edges).toHaveLength(groups.size)
    for (const item of view.edges) expect(item.weight).toBe(groups.get(item.id))
    // 至少有一条跨社区边，否则这条用例什么也没测到
    expect(groups.size).toBeGreaterThan(0)
  })

  it('社区内部的边不进折叠结果（聚合视图里它们就是"这一团自己"）', () => {
    const nodes = [node('a1'), node('a2')]
    const edges = [edge('a1', 'a2')]
    expect(buildAggregatedGraph(nodes, edges).edges).toHaveLength(0)
  })

  it('无向：A→B 与 B→A 合成同一条', () => {
    const nodes = [node('a1'), node('a2'), node('b1'), node('b2')]
    const edges = [edge('a1', 'a2'), edge('b1', 'b2'), edge('a1', 'b1'), edge('b2', 'a2')]
    const folded = buildAggregatedGraph(nodes, edges)
    expect(folded.edges).toHaveLength(1)
    expect(folded.edges[0].weight).toBe(2)
  })

  it('空图折叠为空，不抛错', () => {
    expect(buildAggregatedGraph([], [])).toEqual({ clusters: [], nodes: [], edges: [] })
  })
})

describe('聚合视图（支持部分展开）', () => {
  it('未展开时全是超级节点，社区之间只有一条边', () => {
    const { nodes, edges } = twoTriangles()
    const view = buildAggregatedGraph(nodes, edges)
    expect(view.nodes).toHaveLength(2)
    expect(view.nodes.every((item) => item.isCluster)).toBe(true)
    expect(view.edges).toHaveLength(1)
  })

  it('展开其中一个社区：它画 3 个成员，另一个仍是超级节点', () => {
    const { nodes, edges } = twoTriangles()
    const view = buildAggregatedGraph(nodes, edges, new Set(['cluster:a1']))
    const supers = view.nodes.filter((item) => item.isCluster)
    const members = view.nodes.filter((item) => !item.isCluster)
    expect(supers.map((item) => item.id)).toEqual(['cluster:b1'])
    expect(members.map((item) => item.id).sort()).toEqual(['a1', 'a2', 'a3'])
  })

  /**
   * 这条是"部分展开"最容易写错的地方：只换节点、不重连边，展开后就会一条线都没有。
   *
   * 断言同样不绑分组：展开**任意**一个社区后，该社区成员必须被画出、它自己不再有超级节点、
   * 别的社区仍聚合，且**没有一条边悬空**（两端都在画面上）。
   */
  it('展开一个社区：成员被画出、该社区不再有超级节点、边不悬空', () => {
    const { nodes, edges } = twoTriangles()
    const collapsed = buildAggregatedGraph(nodes, edges)
    const target = collapsed.clusters[0]
    const view = buildAggregatedGraph(nodes, edges, new Set([target.id]))

    const drawn = new Set(view.nodes.map((item) => item.id))
    for (const member of target.members) expect(drawn.has(member.id)).toBe(true)
    expect(drawn.has(target.id)).toBe(false)
    expect(view.nodes.some((item) => item.isCluster)).toBe(true)
    for (const item of view.edges) {
      expect(drawn.has(item.from)).toBe(true)
      expect(drawn.has(item.to)).toBe(true)
    }
  })

  it('全部展开时退化为原图：没有超级节点，边数与原图一致', () => {
    const { nodes, edges } = twoTriangles()
    const view = buildAggregatedGraph(nodes, edges, new Set(['cluster:a1', 'cluster:b1']))
    expect(view.nodes).toHaveLength(6)
    expect(view.nodes.some((item) => item.isCluster)).toBe(false)
    expect(view.edges).toHaveLength(edges.length)
  })

  it('超级节点带上成员 id 与成员数（供下钻与提示）', () => {
    const { nodes, edges } = twoTriangles()
    const superA = buildAggregatedGraph(nodes, edges).nodes.find((item) => item.id === 'cluster:a1')
    expect(superA?.size).toBe(3)
    expect(superA?.memberIds.slice().sort()).toEqual(['a1', 'a2', 'a3'])
  })
})
