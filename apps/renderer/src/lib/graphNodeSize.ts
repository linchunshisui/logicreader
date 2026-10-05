/**
 * 节点按**重要度**分级（供关系图与布局共用）。
 *
 * 依据：节点-连线图的通行做法（Gephi / Obsidian 的度中心性、Neo4j Bloom 的重要性尺寸）——
 * 一张图里"枢纽概念"和"只出现一次的小点"如果长得一样大，读者就得逐个读文字才知道该看哪里。
 * 度数（含边权累加）是最便宜、最可解释的重要性判据：连接越多的概念，越像这一片的中心话题。
 *
 * 尺寸必须**同时**给布局与渲染（布局要按真实包围盒留间距，否则放大的节点会互相压住），
 * 所以这里做成纯函数，两边都从它取。
 */
import type { GraphEdge, GraphNode } from '@logicreader/graph-schema'

/** 与 CSS `.lr-gnode` 的基准尺寸对齐 */
export const GRAPH_NODE_BASE_WIDTH = 220
export const GRAPH_NODE_BASE_HEIGHT = 64
/** 章节节点的固定高度（它是结构件，不参与重要性分级） */
export const GRAPH_SECTION_HEIGHT = 44
/** 最大放大系数：再大就会喧宾夺主、把画布挤满 */
export const GRAPH_NODE_MAX_SCALE = 1.4

/** 无向度数（按边权累加）。 */
export function degreesOf(edges: readonly GraphEdge[]): Map<string, number> {
  const degree = new Map<string, number>()
  for (const edge of edges) {
    const weight = Math.max(1, Number(edge.weight) || 1)
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + weight)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + weight)
  }
  return degree
}

/**
 * 度数 → 尺寸系数。
 *
 * 用 `sqrt` 而不是线性：少数枢纽的度数会比平均高一个数量级，线性映射会把它们撑到极大、
 * 其余全挤成同一档；开方近似"面积与度数成正比"的直觉，分档更均匀。
 */
export function nodeScaleOf(degree: number, maxDegree: number): number {
  if (!(maxDegree > 0) || !(degree > 0)) return 1
  const ratio = Math.max(0, Math.min(1, degree / maxDegree))
  return 1 + (GRAPH_NODE_MAX_SCALE - 1) * Math.sqrt(ratio)
}

/** 节点在图上占的盒子（布局与渲染必须用同一个）。 */
export function nodeSizeOf(
  node: Pick<GraphNode, 'meta'>,
  degree: number,
  maxDegree: number
): { width: number; height: number; scale: number } {
  const isSection = Boolean(node.meta?.isSection)
  const scale = isSection ? 1 : nodeScaleOf(degree, maxDegree)
  const height = isSection ? GRAPH_SECTION_HEIGHT : GRAPH_NODE_BASE_HEIGHT
  return {
    width: Math.round(GRAPH_NODE_BASE_WIDTH * scale),
    height: Math.round(height * scale),
    scale
  }
}
