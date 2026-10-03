/** 关系图数据结构 —— 与 §7.1 的表结构、§7.2 的导出 Schema 对齐。 */
import type { NodeKind, EdgeKind } from './vocab'

export interface GraphAnchorRef {
  docId: string
  docHash: string
  charStart: number
  charEnd: number
  quote: string
  primary?: unknown
  extras?: unknown[]
}

export interface GraphNode {
  id: string
  graphId?: string
  kind: NodeKind
  title: string
  summary: string
  anchorIds: string[]
  anchors?: GraphAnchorRef[]
  parentId: string | null
  clusterId: string | null
  x: number | null
  y: number | null
  collapsed: boolean
  /** 人工编辑留痕：true 的字段在重生成时不被覆盖 */
  pinned?: { title?: boolean; position?: boolean; kind?: boolean }
  meta?: Record<string, unknown>
}

export interface GraphEdge {
  id: string
  graphId?: string
  from: string
  to: string
  kind: EdgeKind
  label: string
  anchorIds: string[]
  anchors?: GraphAnchorRef[]
  weight: number
  meta?: Record<string, unknown>
}

export interface GraphStats {
  nodeCount: number
  edgeCount: number
  anchorCoverage: number
  failedChunks: number
  isolatedNodes: number
  avgEvidenceLength: number
  mergedEntities: number
  inputTokens: number
  outputTokens: number
  elapsedMs: number
  droppedUnanchored: number
}

export interface GraphGenerationInfo {
  agentId: string
  agentName: string
  modelId: string | null
  thinkingEffort: string | null
  precision: string
  promptVersion: string
  scope: string
}

export interface LogicGraph {
  id: string
  docId: string
  docHash: string
  title: string
  version: 1
  createdAt: number
  updatedAt: number
  status: 'pending' | 'running' | 'done' | 'failed' | 'partial'
  generation: GraphGenerationInfo
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: GraphStats
  /** 人工删除的边（重生成时不复活） */
  ignoredEdges?: { from: string; to: string; kind: string }[]
  error?: string | null
}

export function emptyStats(): GraphStats {
  return {
    nodeCount: 0,
    edgeCount: 0,
    anchorCoverage: 0,
    failedChunks: 0,
    isolatedNodes: 0,
    avgEvidenceLength: 0,
    mergedEntities: 0,
    inputTokens: 0,
    outputTokens: 0,
    elapsedMs: 0,
    droppedUnanchored: 0
  }
}
