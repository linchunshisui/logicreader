/**
 * 社区检测与"超级节点"折叠（供关系图的**按社区聚合**视图使用）。
 *
 * 为什么单独抽成纯函数：聚合视图的判据要能被单测钉住（分组是否合理、跨社区的边有没有并对、
 * 同一张图重算是否稳定）。放在视图里就只能靠肉眼看。
 *
 * 与"章节层级折叠"的关系：那是**并存**的另一种聚合 —— 章节折叠走 `parentId`（抽取时就带上的层级），
 * 这里走 `clusterId`（由图结构算出来的社区）。两者互不替代，也都不改变原图数据。
 */
import Graph from 'graphology'
import louvain from 'graphology-communities-louvain'
import type { EdgeKind, GraphEdge, GraphNode } from '@logicreader/graph-schema'

export interface ClusterMember {
  id: string
  kind: string
  title: string
}

export interface GraphCluster {
  /**
   * 超级节点 id：取成员里最小的 id。
   *
   * 不直接用 Louvain 的社区下标：那个下标会随节点顺序/随机数变化 ——
   * 于是"重算一次聚合"就会让界面上的点整个换位置、选中状态也跟着丢。用成员指纹才稳定。
   */
  id: string
  /** 代表成员的名字（社区里连接度最高者） */
  title: string
  size: number
  members: ClusterMember[]
  /** 成员出现过的节点类型（给超级节点上色用） */
  kinds: string[]
}

export interface ClusterEdge {
  id: string
  /** 无向：两端按 id 排序后存放，避免 A→B 与 B→A 变成两条 */
  from: string
  to: string
  weight: number
  kinds: EdgeKind[]
}

/** 聚合视图里实际要画的一个点：要么是超级节点，要么是（被展开的那个社区的）成员节点。 */
export interface DisplayNode {
  id: string
  clusterId: string
  kind: string
  title: string
  /** 超级节点的成员数；成员节点恒为 1 */
  size: number
  /** true = 超级节点 */
  isCluster: boolean
  /** 超级节点携带的成员（供下钻与"导出/跳转"用）；成员节点为空数组 */
  memberIds: string[]
}

/**
 * 固定种子的伪随机（mulberry32）。
 *
 * Louvain 内部会打乱节点顺序，默认取 `Math.random` —— 那样**同一张图每次聚合都会分组不同**，
 * 用户每切一次视图，图上的分组就变一次。给个固定种子，聚合结果就是确定的、可复现的。
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LOUVAIN_SEED = 0x5eed

/** 社区检测：返回 nodeId → 社区下标。 */
export function computeCommunities(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[]
): Map<string, number> {
  const out = new Map<string, number>()
  if (nodes.length === 0) return out
  for (const node of nodes) out.set(node.id, 0)

  const graph = new Graph({ type: 'undirected', multi: false })
  for (const node of nodes) if (!graph.hasNode(node.id)) graph.addNode(node.id)

  let usableEdges = 0
  for (const edge of edges) {
    if (edge.from === edge.to) continue
    if (!graph.hasNode(edge.from) || !graph.hasNode(edge.to)) continue
    if (graph.hasEdge(edge.from, edge.to)) continue
    graph.addEdge(edge.from, edge.to, { weight: Math.max(1, edge.weight || 1) })
    usableEdges += 1
  }

  /**
   * 一条边都没有时不做社区检测：那时"社区"没有意义，Louvain 的结果也只会退化成
   * 全图一个社区（用户看到的是一颗大球）。此时让每个节点自成一社区，
   * 聚合视图的观感就与普通视图一致 —— 比"全并成一个"更不容易让人困惑。
   */
  if (usableEdges === 0) {
    nodes.forEach((node, index) => out.set(node.id, index))
    return out
  }

  const mapping = louvain(graph, { getEdgeWeight: 'weight', rng: seededRandom(LOUVAIN_SEED) })
  for (const node of nodes) out.set(node.id, mapping[node.id] ?? 0)
  return out
}

/** 社区内连接度：用来挑"代表成员"（连接最多的那个最像这一团的中心话题）。 */
function degreeWithin(nodeIds: readonly string[], edges: readonly GraphEdge[]): Map<string, number> {
  const member = new Set(nodeIds)
  const degree = new Map<string, number>()
  for (const id of nodeIds) degree.set(id, 0)
  for (const edge of edges) {
    if (!member.has(edge.from) || !member.has(edge.to)) continue
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
  }
  return degree
}

/** 代表成员：连接度最高 → 标题短的优先 → id 小的优先（后两条只为让结果确定）。 */
function pickRepresentative(members: readonly GraphNode[], edges: readonly GraphEdge[]): GraphNode {
  const degree = degreeWithin(members.map((m) => m.id), edges)
  return [...members].sort((a, b) => {
    const byDegree = (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)
    if (byDegree !== 0) return byDegree
    if (a.title.length !== b.title.length) return a.title.length - b.title.length
    return a.id.localeCompare(b.id)
  })[0]
}

/** 按社区分组（`foldToClusters` 与 `buildAggregatedGraph` 共用的第一步）。 */
function groupByCommunity(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[]
): { clusters: GraphCluster[]; clusterOf: Map<string, string> } {
  const communities = computeCommunities(nodes, edges)
  const byCommunity = new Map<number, GraphNode[]>()
  for (const node of nodes) {
    const key = communities.get(node.id) ?? 0
    const list = byCommunity.get(key)
    if (list) list.push(node)
    else byCommunity.set(key, [node])
  }

  const clusters: GraphCluster[] = []
  const clusterOf = new Map<string, string>()
  for (const members of byCommunity.values()) {
    const sorted = [...members].sort((a, b) => a.id.localeCompare(b.id))
    const id = 'cluster:' + sorted[0].id
    for (const member of sorted) clusterOf.set(member.id, id)
    clusters.push({
      id,
      title: pickRepresentative(sorted, edges).title,
      size: sorted.length,
      members: sorted.map((member) => ({ id: member.id, kind: member.kind, title: member.title })),
      kinds: [...new Set(sorted.map((member) => member.kind))]
    })
  }
  clusters.sort((a, b) => b.size - a.size || a.id.localeCompare(b.id))
  return { clusters, clusterOf }
}

/** 把原边按"两端落在谁身上"合并（无向、权重累计、类型去重）。 */
function mergeEdges(edges: readonly GraphEdge[], displayIdOf: (nodeId: string) => string | null): ClusterEdge[] {
  const folded = new Map<string, ClusterEdge>()
  for (const edge of edges) {
    const from = displayIdOf(edge.from)
    const to = displayIdOf(edge.to)
    if (!from || !to || from === to) continue
    const [left, right] = from.localeCompare(to) <= 0 ? [from, to] : [to, from]
    const key = left + '>' + right
    const weight = Math.max(1, edge.weight || 1)
    const existing = folded.get(key)
    if (existing) {
      existing.weight += weight
      if (!existing.kinds.includes(edge.kind)) existing.kinds.push(edge.kind)
    } else {
      folded.set(key, { id: key, from: left, to: right, weight, kinds: [edge.kind] })
    }
  }
  return [...folded.values()]
}

/**
 * 聚合视图的**实际画面**，支持"部分展开"。
 *
 * 未展开的社区画成一个超级节点，展开的社区画它的成员；边按"两端落在谁身上"重新连 ——
 * 所以展开一个社区之后，它与其他社区的连线会回到具体成员身上，而不是凭空消失。
 * （如果只把超级节点换成成员、边却沿用折叠结果，展开后就会出现"成员之间一条线都没有"的假象。）
 *
 * 不传 `expandedClusterIds` 就是"全折叠"：全是超级节点。
 */
export function buildAggregatedGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  expandedClusterIds: ReadonlySet<string> = new Set()
): { clusters: GraphCluster[]; nodes: DisplayNode[]; edges: ClusterEdge[] } {
  const { clusters, clusterOf } = groupByCommunity(nodes, edges)
  const clusterById = new Map(clusters.map((cluster) => [cluster.id, cluster]))

  const displayIdOf = (nodeId: string): string | null => {
    const clusterId = clusterOf.get(nodeId)
    if (!clusterId) return null
    return expandedClusterIds.has(clusterId) ? nodeId : clusterId
  }

  const display: DisplayNode[] = []
  const emitted = new Set<string>()
  for (const node of nodes) {
    const clusterId = clusterOf.get(node.id)
    if (!clusterId) continue
    if (expandedClusterIds.has(clusterId)) {
      display.push({
        id: node.id,
        clusterId,
        kind: node.kind,
        title: node.title,
        size: 1,
        isCluster: false,
        memberIds: []
      })
      continue
    }
    if (emitted.has(clusterId)) continue
    const cluster = clusterById.get(clusterId)
    if (!cluster) continue
    emitted.add(clusterId)
    display.push({
      id: clusterId,
      clusterId,
      kind: cluster.kinds[0] ?? 'claim',
      title: cluster.title,
      size: cluster.size,
      isCluster: true,
      memberIds: cluster.members.map((member) => member.id)
    })
  }

  return { clusters, nodes: display, edges: mergeEdges(edges, displayIdOf) }
}
