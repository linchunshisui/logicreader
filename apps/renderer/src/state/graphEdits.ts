/**
 * 人工编辑关系图的**规则**。
 *
 * 抽成纯函数的原因：这些规则是"什么算合法的一次手工连线"，
 * 与 React Flow、与 store、与 IPC 都无关 —— 放在这里就能被单测钉住，
 * 界面只负责把结果画出来（`GraphCanvas.onConnect`）。
 */
import type { EdgeKind, GraphEdge, LogicGraph } from '@logicreader/graph-schema'

export type LinkFailure = 'self' | 'duplicate' | 'missing-node' | 'no-graph'

export type LinkCheck = { ok: true } | { ok: false; reason: LinkFailure }

/**
 * 能不能在这两个节点之间手工连一条线？
 *
 * 允许**反向**再连一条（"A 支持 B" 与 "B 反对 A" 可以同时成立，方向不同就是两条关系），
 * 但同方向只留一条 —— 否则手一抖就连出两条一模一样的线，图上还看不出来。
 */
export function canLinkNodes(graph: LogicGraph | null, from: string, to: string): LinkCheck {
  if (!graph) return { ok: false, reason: 'no-graph' }
  const hasFrom = graph.nodes.some((node) => node.id === from)
  const hasTo = graph.nodes.some((node) => node.id === to)
  if (!hasFrom || !hasTo) return { ok: false, reason: 'missing-node' }
  if (from === to) return { ok: false, reason: 'self' }
  if (graph.edges.some((edge) => edge.from === from && edge.to === to)) return { ok: false, reason: 'duplicate' }
  return { ok: true }
}

export interface ManualEdgeInput {
  id: string
  from: string
  to: string
  kind: EdgeKind
  label?: string
  /** 依据锚点：人工连线取起点节点的原文位置（可为空 —— 空的话跳转会明确提示"无原文依据"） */
  anchorIds?: string[]
  evidence?: string
  createdAt?: number
}

/**
 * 造一条人工连线。
 *
 * `meta.manual` 是给"重生成时不被覆盖"用的（与节点的 `pinned` 同一套思路）：
 * 人画上去的关系不该因为重新生成关系图就消失。
 */
export function createManualEdge(input: ManualEdgeInput): GraphEdge {
  return {
    id: input.id,
    from: input.from,
    to: input.to,
    kind: input.kind,
    label: input.label ?? '',
    anchorIds: input.anchorIds ?? [],
    weight: 1,
    meta: {
      manual: true,
      createdAt: input.createdAt ?? Date.now(),
      evidence: input.evidence ?? ''
    }
  }
}
