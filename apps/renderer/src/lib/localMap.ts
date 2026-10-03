/**
 * 阅读器右侧「局部关系图」的**纯几何计算**。
 *
 * 为什么单独抽一个纯函数：面板只有 320px 宽，节点/连线的坐标一旦写死在组件里，
 * 就没法用单测保证"箭头真的连在两个盒子之间""中心节点真的在中间列"这类几何事实
 * （见避坑指南 §7.7：几何断言用等式代替"看着对"）。
 *
 * 布局取关系图里「分层」的同一套心智：左列 = 指向它的，中列 = 它自己，右列 = 由它指向。
 * 单位是 SVG 用户坐标，整张图按容器宽度等比缩放，所以窄面板也不会错位。
 */
import type { GraphEdge, GraphNode } from '@logicreader/graph-schema'

export const LOCAL_MAP = {
  /** 设计宽度：86 + 22 + 104 + 22 + 86 */
  width: 320,
  pad: 6,
  peerWidth: 86,
  peerHeight: 36,
  centerWidth: 104,
  centerHeight: 48,
  gapX: 22,
  rowGap: 6
} as const

export interface LocalMapBox {
  x: number
  y: number
  width: number
  height: number
}

export interface LocalMapPeerBox extends LocalMapBox {
  node: GraphNode
  /** 代表这条边的样式（同一对节点之间有多条边时取权重最高的那条） */
  edge: GraphEdge
  direction: 'in' | 'out'
  /** 这对节点之间有几条关系（>1 时界面标 ×N） */
  multi: number
  index: number
}

export interface LocalMapLink {
  edge: GraphEdge
  direction: 'in' | 'out'
  /** 三次贝塞尔的 path 的 d */
  d: string
}

export interface LocalMapLayout {
  width: number
  height: number
  centerNode: GraphNode
  center: LocalMapBox
  peers: LocalMapPeerBox[]
  links: LocalMapLink[]
  /** 两侧各有多少个放不下的邻居（面板里用"还有 N 个"提示） */
  hidden: { in: number; out: number }
}

function totalWeight(edges: GraphEdge[]): number {
  return edges.reduce((sum, edge) => sum + (edge.weight ?? 1), 0)
}

function primaryEdge(edges: GraphEdge[]): GraphEdge {
  return edges.reduce((best, edge) => ((edge.weight ?? 1) > (best.weight ?? 1) ? edge : best), edges[0])
}

function linkPath(direction: 'in' | 'out', peer: LocalMapBox, center: LocalMapBox): string {
  const peerY = peer.y + peer.height / 2
  const centerY = center.y + center.height / 2
  if (direction === 'in') {
    // 从对端盒子的右边缘 → 中心盒子的左边缘
    const x1 = peer.x + peer.width
    const x2 = center.x
    const cx = (x1 + x2) / 2
    return 'M ' + x1 + ' ' + peerY + ' C ' + cx + ' ' + peerY + ', ' + cx + ' ' + centerY + ', ' + x2 + ' ' + centerY
  }
  // 从中心盒子的右边缘 → 对端盒子的左边缘
  const x1 = center.x + center.width
  const x2 = peer.x
  const cx = (x1 + x2) / 2
  return 'M ' + x1 + ' ' + centerY + ' C ' + cx + ' ' + centerY + ', ' + cx + ' ' + peerY + ', ' + x2 + ' ' + peerY
}

/**
 * 算出以 `centerId` 为中心的一度局部图。
 * 找不到中心节点（图被换过 / 节点被删）时返回 null，调用方据此不渲染。
 */
export function layoutLocalMap(
  centerId: string,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  options: { maxPerSide?: number } = {}
): LocalMapLayout | null {
  const maxPerSide = Math.max(1, options.maxPerSide ?? 4)
  const centerNode = nodes.find((node) => node.id === centerId)
  if (!centerNode) return null
  const byId = new Map(nodes.map((node) => [node.id, node]))

  /** 一侧的邻居：按对端合并（一对节点多条边只画一条），权重高的排前面。 */
  const collect = (direction: 'in' | 'out'): Map<string, GraphEdge[]> => {
    const grouped = new Map<string, GraphEdge[]>()
    for (const edge of edges) {
      if (direction === 'in' ? edge.to !== centerId : edge.from !== centerId) continue
      const peerId = direction === 'in' ? edge.from : edge.to
      if (peerId === centerId || !byId.has(peerId)) continue
      const list = grouped.get(peerId)
      if (list) list.push(edge)
      else grouped.set(peerId, [edge])
    }
    return new Map([...grouped].sort((a, b) => totalWeight(b[1]) - totalWeight(a[1])))
  }

  const inbound = collect('in')
  const outbound = collect('out')
  const inShown = [...inbound.entries()].slice(0, maxPerSide)
  const outShown = [...outbound.entries()].slice(0, maxPerSide)

  const columnHeight = (count: number): number =>
    count > 0 ? count * (LOCAL_MAP.peerHeight + LOCAL_MAP.rowGap) - LOCAL_MAP.rowGap : 0
  const inHeight = columnHeight(inShown.length)
  const outHeight = columnHeight(outShown.length)
  const bodyHeight = Math.max(LOCAL_MAP.centerHeight, inHeight, outHeight)
  const height = bodyHeight + LOCAL_MAP.pad * 2
  const topOf = (column: number): number => LOCAL_MAP.pad + (bodyHeight - column) / 2

  const leftX = 0
  const centerX = LOCAL_MAP.peerWidth + LOCAL_MAP.gapX
  const rightX = centerX + LOCAL_MAP.centerWidth + LOCAL_MAP.gapX
  const center: LocalMapBox = {
    x: centerX,
    y: topOf(LOCAL_MAP.centerHeight),
    width: LOCAL_MAP.centerWidth,
    height: LOCAL_MAP.centerHeight
  }

  const peers: LocalMapPeerBox[] = []
  const links: LocalMapLink[] = []
  const addColumn = (rows: [string, GraphEdge[]][], direction: 'in' | 'out'): void => {
    const top = topOf(columnHeight(rows.length))
    rows.forEach(([peerId, group], index) => {
      const node = byId.get(peerId)
      if (!node) return
      const edge = primaryEdge(group)
      const box: LocalMapPeerBox = {
        node,
        edge,
        direction,
        multi: group.length,
        index,
        x: direction === 'in' ? leftX : rightX,
        y: top + index * (LOCAL_MAP.peerHeight + LOCAL_MAP.rowGap),
        width: LOCAL_MAP.peerWidth,
        height: LOCAL_MAP.peerHeight
      }
      peers.push(box)
      links.push({ edge, direction, d: linkPath(direction, box, center) })
    })
  }
  addColumn(inShown, 'in')
  addColumn(outShown, 'out')

  return {
    width: LOCAL_MAP.width,
    height,
    centerNode,
    center,
    peers,
    links,
    hidden: { in: inbound.size - inShown.length, out: outbound.size - outShown.length }
  }
}
