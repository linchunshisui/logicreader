import { create } from 'zustand'
import {
  createId,
  type GraphPrecision
} from '@logicreader/shared'
import type { EdgeKind, GraphEdge, GraphNode, LogicGraph, NodeKind } from '@logicreader/graph-schema'
import { EDGE_KINDS, NODE_KINDS } from '@logicreader/graph-schema'
import { api } from '../lib/api'
import { exportGraphImage } from '../lib/graphImage'
import { graphDisplayName } from '../lib/graphName'
import { canLinkNodes, createManualEdge, type LinkFailure } from './graphEdits'
import { notify } from './notifications.store'
import { useSettings } from './settings.store'
import { useTabs } from './tabs.store'

export interface GraphProgressView {
  taskId: string
  phase: string
  done: number
  total: number
  detail: string
  error?: string
}

export interface GraphSummary {
  id: string
  docId: string
  agentId: string
  agentName: string
  modelId: string | null
  thinkingEffort: string | null
  precision: string
  status: string
  createdAt: number
  updatedAt: number
  stats: { nodeCount?: number; edgeCount?: number }
  error: string | null
}

export interface PositionedGraph {
  graph: LogicGraph
  positions: Record<string, { x: number; y: number }>
}

interface GraphState {
  docId: string | null
  graph: LogicGraph | null
  summaries: GraphSummary[]
  loading: boolean
  progress: GraphProgressView | null
  taskId: string | null
  positions: Record<string, { x: number; y: number }>
  selectedNodeIds: string[]
  selectedEdgeIds: string[]
  edgeKindFilter: EdgeKind[]
  nodeKindFilter: NodeKind[]
  searchTerm: string
  layoutMode: 'layered' | 'force' | 'radial'
  aggregated: boolean
  collapsedIds: string[]
  /** 由命令/快捷键发起的"打开生成配置面板"请求（非 0 即待处理） */
  generateRequest: number
  /** 由别处（逻辑链面板等）发起的"把某个节点居中并选中"请求 */
  focusRequest: { nodeId: string; nonce: number } | null

  requestGenerate: () => void
  consumeGenerate: () => void
  /** 请画布把某个节点居中并选中（在关系图标签挂载后由它消费） */
  requestFocus: (nodeId: string) => void
  consumeFocus: () => void
  bind: (docId: string) => Promise<void>
  reload: () => Promise<void>
  generate: (request: GenerateRequest) => Promise<void>
  cancel: () => Promise<void>
  retryFailed: () => Promise<void>
  refine: (sectionIds: string[]) => Promise<void>
  runLayout: (mode: 'layered' | 'force' | 'radial') => Promise<void>
  setPositions: (positions: Record<string, { x: number; y: number }>, persist?: boolean) => void
  select: (nodeIds: string[], edgeIds?: string[]) => void
  setEdgeKindFilter: (kinds: EdgeKind[]) => void
  setNodeKindFilter: (kinds: NodeKind[]) => void
  setSearch: (value: string) => void
  toggleAggregate: () => void
  toggleCollapsed: (nodeId: string) => void
  renameNode: (nodeId: string, title: string) => Promise<void>
  changeNodeKind: (nodeId: string, kind: NodeKind) => Promise<void>
  deleteNode: (nodeId: string) => Promise<void>
  changeEdgeKind: (edgeId: string, kind: EdgeKind) => Promise<void>
  deleteEdge: (edgeId: string) => Promise<void>
  /** 人工建立联系（图上的连线拖拽）；返回失败原因供界面给一句明确的话 */
  addEdge: (input: {
    from: string
    to: string
    kind?: EdgeKind
    label?: string
    evidence?: string
  }) => Promise<{ ok: boolean; id?: string; reason?: LinkFailure }>
  /** 改连线上的关系说明（人工连线的补充信息） */
  setEdgeLabel: (edgeId: string, label: string) => Promise<void>
  addInquiryNode: (input: { title: string; summary: string; anchorIds: string[]; fromNodeId?: string | null }) => Promise<string | null>
  importJson: () => Promise<void>
  exportAs: (format: 'json' | 'markdown' | 'svg' | 'png' | 'jpg') => Promise<void>
  appendGenerated: (graph: LogicGraph) => void
}

export interface GenerateRequest {
  docId: string
  graphId?: string | null
  agentId: string
  modelId?: string | null
  thinkingEffort?: string | null
  precision: GraphPrecision
  scope?: 'full' | 'section' | 'from-page'
  sectionIds?: string[]
  nodeLimit?: number
  edgeKinds?: EdgeKind[]
  chunkTokens?: number
  concurrency?: number
  entityThreshold?: number
}

const NODE_W = 220
const NODE_H = 64

function nodeSize(node: GraphNode): { width: number; height: number } {
  return { width: NODE_W, height: node.meta?.isSection ? 44 : NODE_H }
}

export const useGraph = create<GraphState>((set, get) => ({
  docId: null,
  graph: null,
  summaries: [],
  loading: false,
  progress: null,
  taskId: null,
  positions: {},
  selectedNodeIds: [],
  selectedEdgeIds: [],
  edgeKindFilter: [...EDGE_KINDS],
  nodeKindFilter: [...NODE_KINDS],
  searchTerm: '',
  layoutMode: 'layered',
  aggregated: false,
  collapsedIds: [],
  generateRequest: 0,
  focusRequest: null,

  requestGenerate: () => set({ generateRequest: Date.now() }),
  consumeGenerate: () => set({ generateRequest: 0 }),
  requestFocus: (nodeId) => set({ focusRequest: { nodeId, nonce: Date.now() } }),
  consumeFocus: () => set({ focusRequest: null }),

  appendGenerated: (graph) => set({ graph }),

  bind: async (docId) => {
    if (get().docId === docId && get().graph) return
    set({ docId, graph: null, positions: {}, selectedNodeIds: [], selectedEdgeIds: [] })
    await get().reload()
  },

  reload: async () => {
    const docId = get().docId
    if (!docId) return
    set({ loading: true })
    try {
      const summaries = (await api.store.graphList(docId)) as unknown as GraphSummary[]
      set({ summaries })
      const latest = summaries[0]
      if (!latest) {
        set({ graph: null, loading: false })
        return
      }
      const graph = (await api.store.graphGet(latest.id)) as LogicGraph | null
      if (!graph) {
        set({ graph: null, loading: false })
        return
      }
      const positions: Record<string, { x: number; y: number }> = {}
      for (const node of graph.nodes) {
        if (node.x != null && node.y != null) positions[node.id] = { x: node.x, y: node.y }
      }
      set({ graph, positions, loading: false, collapsedIds: graph.nodes.filter((n) => n.collapsed).map((n) => n.id) })
      if (Object.keys(positions).length < graph.nodes.length) await get().runLayout(get().layoutMode)
    } catch (error) {
      set({ loading: false })
      notify(error instanceof Error ? error.message : String(error), 'error')
    }
  },

  generate: async (request) => {
    const taskId = createId('task')
    set({ taskId, progress: { taskId, phase: 'prepare', done: 0, total: 0, detail: '' } })
    const unsubscribe = api.graph.onProgress((progress) => {
      if (progress.taskId !== taskId) return
      set({ progress: progress as GraphProgressView })
    })
    try {
      const graph = (await api.graph.generate({ ...request, taskId })) as LogicGraph | null
      if (graph && graph.nodes.length === 0) {
        // 全部分块失败：空图不入库也不上屏，直接把逐块原因（代理 403 / 校验失败详情）亮给用户
        set({ progress: null })
        notify('关系图生成失败：' + (graph.error ?? '所有分块均未产出有效节点'), 'error', { timeoutMs: 0 })
      } else if (graph) {
        set({ graph, progress: null })
        await get().reload()
        await get().runLayout(get().layoutMode)
        notify('关系图已生成：' + graph.nodes.length + ' 个节点 · ' + graph.edges.length + ' 条连线', 'success')
        if (graph.error) notify('部分分块未产出（' + graph.stats.failedChunks + ' 块），详见日志', 'warning')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('cancelled')) notify('已取消生成', 'info')
      else notify(message, 'error', { timeoutMs: 0 })
      set({ progress: null })
    } finally {
      unsubscribe()
      set({ taskId: null })
    }
  },

  cancel: async () => {
    const taskId = get().taskId
    if (!taskId) return
    await api.graph.cancel(taskId).catch(() => undefined)
    set({ progress: null, taskId: null })
  },

  retryFailed: async () => {
    const { graph, docId } = get()
    if (!graph || !docId) return
    const generation = graph.generation
    await get().generate({
      docId,
      graphId: graph.id,
      agentId: generation.agentId,
      modelId: generation.modelId,
      thinkingEffort: generation.thinkingEffort,
      precision: generation.precision as GraphPrecision
    })
  },

  refine: async (sectionIds) => {
    const { graph, docId } = get()
    if (!graph || !docId) return
    await get().generate({
      docId,
      graphId: graph.id,
      agentId: graph.generation.agentId,
      modelId: graph.generation.modelId,
      thinkingEffort: graph.generation.thinkingEffort,
      precision: 'panorama',
      scope: 'section',
      sectionIds
    })
  },

  runLayout: async (mode) => {
    const graph = get().graph
    if (!graph) return
    const frozen: Record<string, { x: number; y: number }> = {}
    for (const node of graph.nodes) {
      if (node.pinned?.position && node.x != null && node.y != null) frozen[node.id] = { x: node.x, y: node.y }
    }
    set({ layoutMode: mode })
    try {
      const worker = new Worker(new URL('../views/graph/layout.worker.ts', import.meta.url), { type: 'module' })
      const result = await new Promise<{ ok: boolean; positions?: Record<string, { x: number; y: number }>; error?: string }>(
        (resolve) => {
          const timer = setTimeout(() => resolve({ ok: false, error: '布局超时' }), 20000)
          worker.onmessage = (event) => {
            clearTimeout(timer)
            resolve(event.data as { ok: boolean; positions?: Record<string, { x: number; y: number }> })
          }
          worker.postMessage({
            mode,
            nodes: graph.nodes.map((node) => ({ id: node.id, ...nodeSize(node), parentId: node.parentId })),
            edges: graph.edges.map((edge) => ({ id: edge.id, source: edge.from, target: edge.to })),
            frozen
          })
        }
      )
      worker.terminate()
      if (result.ok && result.positions) {
        set({ positions: result.positions })
        await api.graph.applyLayout(graph.id, result.positions).catch(() => undefined)
      } else {
        notify('布局计算失败：' + (result.error ?? '未知错误'), 'warning')
      }
    } catch (error) {
      notify('布局失败：' + (error instanceof Error ? error.message : String(error)), 'warning')
    }
  },

  setPositions: (positions, persist = false) => {
    set({ positions })
    if (persist) {
      const graph = get().graph
      if (graph) void api.graph.applyLayout(graph.id, positions).catch(() => undefined)
    }
  },

  select: (nodeIds, edgeIds) => set({ selectedNodeIds: nodeIds, selectedEdgeIds: edgeIds ?? [] }),
  setEdgeKindFilter: (kinds) => set({ edgeKindFilter: kinds }),
  setNodeKindFilter: (kinds) => set({ nodeKindFilter: kinds }),
  setSearch: (value) => set({ searchTerm: value }),
  toggleAggregate: () => set((state) => ({ aggregated: !state.aggregated })),
  toggleCollapsed: (nodeId) =>
    set((state) => ({
      collapsedIds: state.collapsedIds.includes(nodeId)
        ? state.collapsedIds.filter((id) => id !== nodeId)
        : [...state.collapsedIds, nodeId]
    })),

  renameNode: async (nodeId, title) => {
    const graph = get().graph
    if (!graph) return
    const next: LogicGraph = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === nodeId ? { ...node, title, pinned: { ...(node.pinned ?? {}), title: true } } : node
      )
    }
    set({ graph: next })
    await api.store.graphSave(next)
  },

  changeNodeKind: async (nodeId, kind) => {
    const graph = get().graph
    if (!graph) return
    const next: LogicGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => (node.id === nodeId ? { ...node, kind, pinned: { ...(node.pinned ?? {}), kind: true } } : node))
    }
    set({ graph: next })
    await api.store.graphSave(next)
  },

  deleteNode: async (nodeId) => {
    const graph = get().graph
    if (!graph) return
    const next: LogicGraph = {
      ...graph,
      nodes: graph.nodes.filter((node) => node.id !== nodeId),
      edges: graph.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId)
    }
    set({ graph: next, selectedNodeIds: [] })
    await api.store.graphSave(next)
  },

  addEdge: async (input) => {
    const graph = get().graph
    const check = canLinkNodes(graph, input.from, input.to)
    if (!check.ok) {
      // 重复时不重复造：把已有那条选中，用户能在检查器里直接改它
      if (check.reason === 'duplicate' && graph) {
        const existing = graph.edges.find((edge) => edge.from === input.from && edge.to === input.to)
        if (existing) set({ selectedNodeIds: [], selectedEdgeIds: [existing.id] })
      }
      return { ok: false, reason: check.reason }
    }
    const source = graph?.nodes.find((node) => node.id === input.from)
    const edge = createManualEdge({
      id: createId('e'),
      from: input.from,
      to: input.to,
      kind: input.kind ?? 'references',
      label: input.label ?? '',
      /*
       * 人工连线的"依据"取**起点节点的原文位置**：这样点连线仍然能跳到相关段落，
       * 而不是画完就变成一条点不动的线。起点没有锚点就留空 ——
       * 跳转时会明确提示"该关系无原文依据"（见 GraphCanvas.jumpToAnchor）。
       */
      anchorIds: source?.anchorIds?.slice(0, 1) ?? [],
      evidence: input.evidence ?? ''
    })
    const next: LogicGraph = { ...(graph as LogicGraph), edges: [...(graph as LogicGraph).edges, edge], updatedAt: Date.now() }
    set({ graph: next, selectedNodeIds: [], selectedEdgeIds: [edge.id] })
    await api.store.graphSave(next)
    return { ok: true, id: edge.id }
  },

  setEdgeLabel: async (edgeId, label) => {
    const graph = get().graph
    if (!graph) return
    const next: LogicGraph = {
      ...graph,
      edges: graph.edges.map((edge) => (edge.id === edgeId ? { ...edge, label: label.slice(0, 40) } : edge))
    }
    set({ graph: next })
    await api.store.graphSave(next)
  },

  changeEdgeKind: async (edgeId, kind) => {
    const graph = get().graph
    if (!graph) return
    const next: LogicGraph = {
      ...graph,
      edges: graph.edges.map((edge) => (edge.id === edgeId ? { ...edge, kind } : edge))
    }
    set({ graph: next })
    await api.store.graphSave(next)
  },

  deleteEdge: async (edgeId) => {
    const graph = get().graph
    if (!graph) return
    const removed = graph.edges.find((edge) => edge.id === edgeId)
    const titleOf = (id: string): string => graph.nodes.find((node) => node.id === id)?.title ?? id
    const ignoredEdges = removed
      ? [...(graph.ignoredEdges ?? []), { from: titleOf(removed.from), to: titleOf(removed.to), kind: removed.kind }]
      : graph.ignoredEdges
    const next: LogicGraph = {
      ...graph,
      edges: graph.edges.filter((edge) => edge.id !== edgeId),
      ignoredEdges
    }
    set({ graph: next, selectedEdgeIds: [] })
    await api.store.graphSave(next)
  },

  addInquiryNode: async (input) => {
    const graph = get().graph
    if (!graph) return null
    const node: GraphNode = {
      id: createId('n'),
      kind: 'inquiry',
      title: input.title.slice(0, 28),
      summary: input.summary.slice(0, 120),
      anchorIds: input.anchorIds,
      parentId: null,
      clusterId: null,
      x: null,
      y: null,
      collapsed: false,
      meta: { inquiry: true, createdAt: Date.now() }
    }
    const edges: GraphEdge[] = input.fromNodeId
      ? [
          {
            id: createId('e'),
            from: input.fromNodeId,
            to: node.id,
            kind: 'inquiry',
            label: '提问',
            anchorIds: input.anchorIds,
            weight: 1
          }
        ]
      : []
    const next: LogicGraph = {
      ...graph,
      nodes: [...graph.nodes, node],
      edges: [...graph.edges, ...edges],
      updatedAt: Date.now()
    }
    set({ graph: next })
    await api.store.graphSave(next)
    const tabs = useTabs.getState()
    const tab = tabs.groups.flatMap((group) => group.tabs).find((item) => item.kind === 'graph' && item.docId === graph.docId)
    if (tab) useTabs.getState().updateGraphView(tab.id, { selectedNodeIds: [node.id] })
    return node.id
  },

  importJson: async () => {
    const files = await api.dialog.openFiles()
    if (files.length === 0) return
    try {
      const graph = (await api.graph.importFile(files[0])) as LogicGraph
      set({ graph, docId: graph.docId })
      await get().reload()
      await get().runLayout('layered')
      notify('已导入关系图：' + graph.nodes.length + ' 个节点', 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error', { timeoutMs: 0 })
    }
  },

  exportAs: async (format) => {
    const graph = get().graph
    if (!graph) return
    const extension = format === 'json' ? 'json' : format === 'markdown' ? 'md' : format
    const target = await api.dialog.saveFile({
      title: '导出关系图',
      // 默认文件名与标签页一致："文档名 · 逻辑关系图.png"，一眼知道这是哪篇论文的图
      defaultPath: (graphDisplayName(graph.docId) || 'logic-graph') + '.' + extension,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
    })
    if (!target) return
    try {
      if (format === 'png' || format === 'jpg') {
        /*
         * 图片导出：主进程给 SVG，渲染进程用 canvas 光栅化后写文件（见 lib/graphImage）。
         * JPG 没有 alpha 通道 → 用"当前界面上的画布底色"铺底，导出图和眼前这一屏一致；
         * PNG 不铺底，保持透明（可直接叠到幻灯片/文档上）。
         */
        const image = await exportGraphImage(graph.id, format, target)
        notify('已导出图片：' + target + '（' + image.width + '×' + image.height + '）', 'success', {
          timeoutMs: 0,
          actions: [{ label: '在资源管理器中显示', run: () => void api.fs.reveal(target) }]
        })
      } else {
        await api.graph.exportFile(graph.id, format, target)
        notify('已导出：' + target, 'success', {
          timeoutMs: 0,
          actions: [{ label: '在资源管理器中显示', run: () => void api.fs.reveal(target) }]
        })
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error', { timeoutMs: 0 })
    }
  }
}))

export function graphSettings(): { layout: 'layered' | 'force' | 'radial'; aggregate: boolean } {
  const settings = useSettings.getState().settings
  return { layout: settings.graph.layout, aggregate: settings.graph.aggregate }
}
