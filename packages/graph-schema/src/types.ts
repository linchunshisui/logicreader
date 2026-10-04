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
  /** 本轮实际参与抽取的分块数（增量重试时小于全量分块数） */
  chunkCount: number
  /** 并发波数 = ceil(分块数 / 并发度)：历史耗时折算单块耗时用它除 */
  waveCount: number
  /** 参与抽取的分块总字符数（估算单块体量用） */
  chunkChars: number
  /** 校验失败的分块下标（供"重试失败块"走增量路径） */
  failedChunkIndexes: number[]
}

export interface GraphGenerationInfo {
  agentId: string
  agentName: string
  modelId: string | null
  thinkingEffort: string | null
  precision: string
  promptVersion: string
  scope: string
  /**
   * 生成时**生效**的分块目标（tokens）。
   * 增量重试必须按它复现同一套分块边界 —— failedChunkIndexes 是相对那一次分块的下标，
   * 换了分块大小，下标就会指到别的分块上。
   */
  chunkTokens?: number | null
  /** 生成时生效的关系类型白名单（重试沿用，避免把已过滤的连线复活或误删） */
  edgeKinds?: string[] | null
  /** 生成时的并发度 */
  concurrency?: number | null
  /** 生成时的实体消解阈值 */
  entityThreshold?: number | null
  /** 生成时的节点上限 */
  nodeLimit?: number | null
  /** scope=section 时的章节 id：failedChunkIndexes 相对这套过滤后的分块下标 */
  sectionIds?: string[] | null
  /** scope=from-page 时的起始页 */
  fromPage?: number | null
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
    droppedUnanchored: 0,
    chunkCount: 0,
    waveCount: 0,
    chunkChars: 0,
    failedChunkIndexes: []
  }
}
