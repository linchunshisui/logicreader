import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { basename, type EditorTab } from '@logicreader/shared'
import { EDGE_KINDS, EDGE_STYLE, NODE_KIND_COLOR, type EdgeKind, type GraphEdge, type GraphNode } from '@logicreader/graph-schema'
import { describeLocator } from '@logicreader/document-model'
import { api } from '../../lib/api'
import { useGraph } from '../../state/graph.store'
import { useTabs } from '../../state/tabs.store'
import { useDocuments } from '../../state/documents.store'
import { useUiStore } from '../../state/ui.store'
import { useSettings } from '../../state/settings.store'
import { graphDisplayName } from '../../lib/graphName'
import { buildAggregatedGraph } from '../../lib/graphClusters'
import { locationLabel, revealInReader } from '../../lib/graphJump'
import { canLinkNodes } from '../../state/graphEdits'
import { notify } from '../../state/notifications.store'
import { GraphNodeView } from './GraphNodeView'
import { GraphEdgeView } from './GraphEdgeView'
import { GraphLegend, GraphToolbar, NodeInspector } from './GraphToolbar'
import { GenerationDialog } from './GenerationDialog'
import { QualityReport } from './QualityReport'
import i18n from '../../i18n'

const nodeTypes = { logical: GraphNodeView }
const edgeTypes = { logical: GraphEdgeView }

export function GraphCanvas({ docId }: { docId: string }): JSX.Element {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner docId={docId} />
    </ReactFlowProvider>
  )
}

function GraphCanvasInner({ docId }: { docId: string }): JSX.Element {
  const { t } = useTranslation()
  const graph = useGraph()
  const { settings } = useSettings()
  const documents = useDocuments()
  const tabs = useTabs()
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<Edge>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const { fitView, setCenter } = useReactFlow()
  const containerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)

  const model = documents.models[docId] ?? null
  const docTitle = model?.title ?? basename('')

  // 命令面板 / Ctrl+Shift+G 触发的生成请求
  useEffect(() => {
    if (graph.generateRequest === 0) return
    useGraph.getState().consumeGenerate()
    setDialogOpen(true)
  }, [graph.generateRequest])

  useEffect(() => {
    void graph.bind(docId)
  }, [docId])

  // 记录视口，供会话恢复
  const activeTab = tabs.groups.flatMap((group) => group.tabs).find((tab) => tab.kind === 'graph' && tab.docId === docId)

  /**
   * 两个可折叠浮层的展开状态（质量报告 / 图例）。
   *
   * 存在标签的 view 里 → 跟会话快照一起落盘，用户上次怎么摆的，下次打开还是那样。
   * 默认**都收起**：三个浮层全开时画布中央被压掉一大块（用户报的"三层浮层全开"）。
   */
  const graphTab = activeTab && activeTab.kind === 'graph' ? activeTab : null
  const overlays = graphTab?.view.overlays ?? { quality: false, legend: false }
  const toggleOverlay = (key: 'quality' | 'legend', value: boolean): void => {
    if (!graphTab) return
    useTabs.getState().updateGraphView(graphTab.id, { overlays: { ...overlays, [key]: value } })
  }

  /**
   * 标签标题 = "文档名 · 逻辑关系图"。
   * 会话恢复回来的旧标签（那时还叫"关系图"）、以及运行中切换界面语言，
   * 都在这里对齐一次 —— 标题是用户分辨"这张图属于哪篇论文"的唯一线索。
   */
  useEffect(() => {
    if (!activeTab) return
    const title = graphDisplayName(docId, graph.graph?.docId === docId ? graph.graph?.title : null)
    if (activeTab.title !== title) useTabs.getState().updateTab(activeTab.id, { title } as never)
  }, [activeTab, docId, model?.title, graph.graph?.title, graph.graph?.docId, i18n.language])

  const filteredNodes = useMemo(() => {
    const data = graph.graph
    if (!data) return [] as GraphNode[]
    return data.nodes.filter((node) => {
      if (node.meta?.isSection) return true
      if (!graph.nodeKindFilter.includes(node.kind)) return false
      if (graph.searchTerm.trim().length > 0) {
        const needle = graph.searchTerm.trim().toLowerCase()
        return node.title.toLowerCase().includes(needle) || node.summary.toLowerCase().includes(needle)
      }
      return true
    })
  }, [graph.graph, graph.nodeKindFilter, graph.searchTerm])

  const visibleIds = useMemo(() => new Set(filteredNodes.map((node) => node.id)), [filteredNodes])

  const filteredEdges = useMemo(() => {
    const data = graph.graph
    if (!data) return [] as GraphEdge[]
    return data.edges.filter(
      (edge) => graph.edgeKindFilter.includes(edge.kind) && visibleIds.has(edge.from) && visibleIds.has(edge.to)
    )
  }, [graph.graph, graph.edgeKindFilter, visibleIds])

  /** 图上全部节点（**不过滤**）：聚合视图展开社区时要按 id 取回真实节点。 */
  const nodeById = useMemo(() => new Map((graph.graph?.nodes ?? []).map((node) => [node.id, node])), [graph.graph])

  /**
   * 聚合视图（按社区）。`null` = 按原路径渲染（开关关着 / 没有图）。
   *
   * 刻意做成"**可选的一层表现**"而不是替换：原来的渲染路径一字不改，
   * 于是关掉开关就完全回到旧行为 —— 章节折叠、过滤、搜索、连线标注全都不受影响。
   */
  const aggregatedView = useMemo(() => {
    if (!graph.aggregated || !graph.graph) return null
    return buildAggregatedGraph(filteredNodes, filteredEdges, new Set(graph.expandedClusters))
  }, [graph.aggregated, graph.graph, graph.expandedClusters, filteredNodes, filteredEdges])

  /** 超级节点画在哪：成员位置的质心（它自己没有坐标）。 */
  const clusterCentroid = useCallback(
    (memberIds: readonly string[]): { x: number; y: number } => {
      let x = 0
      let y = 0
      let count = 0
      for (const id of memberIds) {
        const node = nodeById.get(id)
        const point = graph.positions[id] ?? (node && node.x !== null && node.y !== null ? { x: node.x, y: node.y } : null)
        if (!point) continue
        x += point.x
        y += point.y
        count += 1
      }
      return count > 0 ? { x: x / count, y: y / count } : { x: 0, y: 0 }
    },
    [graph.positions, nodeById]
  )

  /** 画布上的超级节点 id 集合：双击它们要下钻，而不是去查原文锚点。 */
  const clusterDisplayIds = useMemo(
    () => new Set(aggregatedView ? aggregatedView.nodes.filter((item) => item.isCluster).map((item) => item.id) : []),
    [aggregatedView]
  )

  // 邻居高亮：选中节点时其余降到 25%（规划书 §5.5.6）
  const neighbourIds = useMemo(() => {
    const set = new Set<string>(graph.selectedNodeIds)
    if (!graph.graph || graph.selectedNodeIds.length === 0) return set
    for (const edge of graph.graph.edges) {
      if (graph.selectedNodeIds.includes(edge.from)) set.add(edge.to)
      if (graph.selectedNodeIds.includes(edge.to)) set.add(edge.from)
    }
    return set
  }, [graph.graph, graph.selectedNodeIds])

  const childCount = useMemo(() => {
    const map = new Map<string, number>()
    for (const node of filteredNodes) {
      if (!node.parentId) continue
      map.set(node.parentId, (map.get(node.parentId) ?? 0) + 1)
    }
    return map
  }, [filteredNodes])

  const anchorLabels = useMemo(() => {
    const map = new Map<string, string>()
    if (!model) return map
    for (const node of filteredNodes) {
      const anchor = node.anchors?.[0]
      if (!anchor) continue
      map.set(node.id, locationLabel(docId, anchor.charStart))
    }
    return map
  }, [filteredNodes, model, docId])

  const detail = zoom < 0.4 ? 'title' : zoom < 0.75 ? 'compact' : 'full'

  useEffect(() => {
    /** 聚合视图：画超级节点 / 展开后的成员，位置取质心或原坐标 */
    if (aggregatedView) {
      setNodes(
        aggregatedView.nodes.map((item) => {
          const logical = item.isCluster ? null : nodeById.get(item.id) ?? null
          const point = item.isCluster
            ? clusterCentroid(item.memberIds)
            : graph.positions[item.id] ?? { x: logical?.x ?? 0, y: logical?.y ?? 0 }
          const graphNode: GraphNode = logical ?? {
            id: item.id,
            kind: item.kind as GraphNode['kind'],
            title: item.title,
            summary: '',
            anchorIds: [],
            parentId: null,
            clusterId: null,
            x: point.x,
            y: point.y,
            collapsed: false
          }
          return {
            id: item.id,
            type: 'logical',
            position: point,
            // 超级节点不给拖：它没有自己的坐标可存，拖完一重算就弹回质心
            draggable: !item.isCluster,
            selectable: true,
            data: {
              node: graphNode,
              dimmed: false,
              highlighted: graph.searchTerm.trim().length > 0,
              detail,
              sourceLabel: '',
              childCount: 0,
              collapsed: false,
              cluster: item.isCluster ? { size: item.size, memberIds: item.memberIds } : undefined
            }
          } satisfies Node
        })
      )
      return
    }

    setNodes(
      filteredNodes.map((node) => {
        const point = graph.positions[node.id] ?? { x: node.x ?? 0, y: node.y ?? 0 }
        return {
          id: node.id,
          type: 'logical',
          position: point,
          draggable: true,
          selectable: true,
          data: {
            node,
            dimmed: graph.selectedNodeIds.length > 0 && !neighbourIds.has(node.id),
            highlighted: graph.searchTerm.trim().length > 0,
            detail,
            sourceLabel: anchorLabels.get(node.id) ?? '',
            childCount: childCount.get(node.id) ?? 0,
            collapsed: graph.collapsedIds.includes(node.id)
          }
        } satisfies Node
      })
    )
  }, [aggregatedView, clusterCentroid, nodeById, filteredNodes, graph.positions, graph.selectedNodeIds, neighbourIds, detail, anchorLabels, childCount, graph.collapsedIds, graph.searchTerm, setNodes])

  useEffect(() => {
    if (aggregatedView) {
      setEdges(
        aggregatedView.edges.map((item) => ({
          id: item.id,
          source: item.from,
          target: item.to,
          type: 'logical',
          markerEnd: { type: 'arrowclosed' as never, color: EDGE_STYLE[item.kinds[0]]?.color ?? '#9a9a9a' },
          data: {
            kind: item.kinds[0],
            /**
             * 折叠后的连线也**必须带标注**（产品要求"每条连线都有具体标注"）。
             * 原标注在折叠后无法一一对应，所以用"这条线代表了几条原关系"来标注。
             */
            label: item.weight > 1 ? i18n.t('graph.clusterEdgeCount', { count: item.weight }) : '',
            showLabel: detail !== 'title',
            dimmed: false
          }
        }))
      )
      return
    }

    setEdges(
      filteredEdges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        type: 'logical',
        markerEnd: { type: 'arrowclosed' as never, color: EDGE_STYLE[edge.kind]?.color ?? '#9a9a9a' },
        data: {
          kind: edge.kind,
          label: edge.label,
          showLabel: detail !== 'title',
          dimmed:
            graph.selectedNodeIds.length > 0 && !graph.selectedNodeIds.includes(edge.from) && !graph.selectedNodeIds.includes(edge.to)
        }
      }))
    )
  }, [aggregatedView, filteredEdges, graph.selectedNodeIds, detail, setEdges])

  const onNodesChange = useCallback(
    (changes: NodeChange<Node>[]) => {
      onNodesChangeBase(changes)
      const moved = changes.filter((change) => change.type === 'position' && change.dragging === false)
      if (moved.length === 0) return
      const next = { ...useGraph.getState().positions }
      const current = useGraph.getState().graph
      if (!current) return
      for (const change of moved) {
        const node = (change as { id: string; position?: { x: number; y: number } }).position
        const id = (change as { id: string }).id
        if (node) next[id] = node
      }
      useGraph.getState().setPositions(next, true)
      const graphState = useGraph.getState().graph
      if (graphState) {
        const updated = {
          ...graphState,
          nodes: graphState.nodes.map((node) =>
            next[node.id] ? { ...node, x: next[node.id].x, y: next[node.id].y, pinned: { ...(node.pinned ?? {}), position: true } } : node
          )
        }
        void api.store.graphSave(updated)
      }
    },
    [onNodesChangeBase]
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      onEdgesChangeBase(changes)
    },
    [onEdgesChangeBase]
  )

  /**
   * 跳转到节点 / 连线对应的原文（规划书 §5.5.7、R-11）。
   *
   * 三个入口共用这一条路径：单击节点、单击连线、检查器里的"跳转"按钮 ——
   * 避免出现"按钮能跳、点节点不跳"这种同一功能两套行为。
   */
  const jumpToAnchor = useCallback(
    async (
      anchorIds: string[],
      kind: 'node' | 'edge',
      context?: { nodeId: string; nodeTitle: string }
    ) => {
      if (anchorIds.length === 0) {
        // 无锚点不入图是硬门槛，但导入的图、提问节点、人工边的锚点可能为空：
        // 这时必须给一句明确的话，而不是点了没反应。
        await api.dialog.message({
          type: 'info',
          message: t(kind === 'node' ? 'graph.nodeNoAnchor' : 'graph.positionPickerEmpty'),
          buttons: [t('common.ok')]
        })
        return
      }
      const fetched = await Promise.all(anchorIds.map((id) => api.store.getAnchor(id)))
      const anchors = fetched.filter(Boolean) as NonNullable<(typeof fetched)[number]>[]
      if (anchors.length === 0) {
        await api.dialog.message({ type: 'info', message: t('graph.anchorMissing'), buttons: [t('common.ok')] })
        return
      }
      // 多个锚点 → 位置选择器（§5.5.7 的 R-12）
      const picked: { charStart: number; charEnd: number } | null =
        anchors.length === 1 ? anchors[0] : await pickLocation(anchors)
      if (!picked) return
      // hold：高亮常驻（用户要求"跳转后高亮维持"）；chain：让阅读器在文段旁显示这个节点的逻辑链
      const opened = await revealInReader(docId, picked.charStart, picked.charEnd, {
        hold: true,
        chain: context ? { nodeId: context.nodeId, title: context.nodeTitle, via: kind } : undefined
      })
      if (!opened) {
        await api.dialog.message({ type: 'info', message: t('graph.jumpFailed'), buttons: [t('common.ok')] })
        return
      }
      const where = locationLabel(docId, picked.charStart)
      useUiStore.getState().setStatusMessage(t('graph.jumpedTo', { where: where || t('graph.somewhere') }))
    },
    [docId, t]
  )

  /** 手工连线：成功后给一句回执；失败按原因说清楚（不许连自己 / 已经连过） */
  const connectNodes = useCallback(
    async (from: string, to: string) => {
      const titleOf = (id: string): string => graph.graph?.nodes.find((node) => node.id === id)?.title ?? id
      const result = await graph.addEdge({ from, to, evidence: t('graph.manualEdgeEvidence') })
      if (result.ok) {
        notify(t('graph.edgeCreated', { from: titleOf(from), to: titleOf(to) }), 'success')
        return
      }
      if (result.reason === 'duplicate') notify(t('graph.edgeDuplicate'), 'info')
      else if (result.reason === 'self') notify(t('graph.edgeSelf'), 'warning')
      else notify(t('graph.edgeFailed'), 'warning')
    },
    [graph, t]
  )

  /**
   * "把某个节点摆到眼前"：逻辑链面板里的「在关系图中查看」发来请求，
   * 画布把它居中并选中 —— 否则切回图里可能什么都看不到（节点可能远在视野之外）。
   */
  useEffect(() => {
    const request = graph.focusRequest
    if (!request) return
    useGraph.getState().consumeFocus()
    const node = graph.graph?.nodes.find((item) => item.id === request.nodeId)
    const point = graph.positions[request.nodeId] ?? (node && node.x != null && node.y != null ? { x: node.x, y: node.y } : null)
    graph.select([request.nodeId], [])
    if (point) void setCenter(point.x + 110, point.y + 32, { zoom: Math.max(0.6, zoom), duration: 400 })
  }, [graph.focusRequest])

  // 图数据到位后自动适应视图（React Flow 的 fitView 只在初始化时生效）
  const fittedRef = useRef<string | null>(null)
  useEffect(() => {
    const id = graph.graph?.id ?? null
    if (!id || nodes.length === 0 || fittedRef.current === id) return
    fittedRef.current = id
    const timer = setTimeout(() => void fitView({ padding: 0.2, duration: 300 }), 220)
    return () => clearTimeout(timer)
  }, [graph.graph?.id, nodes.length, fitView])

  return (
    <div className="lr-graph" ref={containerRef}>
      <GraphToolbar
        onGenerate={() => setDialogOpen(true)}
        onFit={() => void fitView({ padding: 0.2, duration: 300 })}
        zoom={zoom}
      />

      {graph.progress ? (
        <div className="lr-graph-progress">
          <div className="lr-graph-progress__bar">
            <div
              className="lr-graph-progress__fill"
              style={{ width: (graph.progress.total > 0 ? (graph.progress.done / graph.progress.total) * 100 : 8) + '%' }}
            />
          </div>
          <span>
            {graph.progress.phase === 'map'
              ? t('graph.progressMap', { done: graph.progress.done, total: graph.progress.total })
              : graph.progress.phase === 'reduce'
                ? t('graph.progressReduce')
                : graph.progress.phase === 'anchors' || graph.progress.phase === 'persist'
                  ? t('graph.progressLayout')
                  : graph.progress.detail}
            {graph.progress.phase === 'map' && typeof graph.progress.etaMs === 'number' && graph.progress.etaMs > 0
              ? ' · ' + t('graph.progressEta', { minutes: Math.max(1, Math.round(graph.progress.etaMs / 60000)) })
              : ''}
          </span>
          <button className="lr-button lr-button--secondary" onClick={() => void graph.cancel()}>
            {t('graph.cancel')}
          </button>
        </div>
      ) : null}

      {!graph.graph ? (
        <div className="lr-graph-empty">
          <h2>{t('graph.title')}</h2>
          <p>{t('sideBar.graphEmptyHint')}</p>
          <div className="lr-graph-empty__actions">
            <button className="lr-button" onClick={() => setDialogOpen(true)}>
              {t('graph.generate')}
            </button>
            <button className="lr-button lr-button--secondary" onClick={() => void graph.importJson()}>
              {t('graph.importTitle')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <QualityReport open={overlays.quality} onToggle={(value) => toggleOverlay('quality', value)} />
          <div className="lr-graph__canvas">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onMove={(_, viewport) => {
                setZoom(viewport.zoom)
                if (activeTab) {
                  useTabs.getState().updateGraphView(activeTab.id, { viewport })
                }
              }}
              /*
               * 单击只做"选中"：**不跳转**。
               *
               * 跳转会把用户从图上带走（切到阅读器标签），如果单击就跳，浏览/整理图的动作
               * 每一下都会被打断 —— 所以跳转必须是用户显式选择的结果：
               * 选中节点/连线后，用检查器里的「跳转」按钮触发（见 NodeInspector）。
               * 双击与跳转不再冲突（双击只负责展开/折叠）。
               */
              onNodeClick={(event, node) => {
                /*
                 * 超级节点也要能选中：它不是从原文抽出来的、没有对应的逻辑节点，
                 * 但"点了没有任何反馈"是明确的坏体验 —— 选中只依赖 id，不需要逻辑节点。
                 */
                const multi = event.ctrlKey || event.metaKey || event.shiftKey
                const selected = multi ? [...graph.selectedNodeIds, node.id] : [node.id]
                graph.select(selected, [])
                if (activeTab) useTabs.getState().updateGraphView(activeTab.id, { selectedNodeIds: selected })
              }}
              onNodeDoubleClick={(_, node) => {
                /* 聚合视图下双击超级节点 = 下钻 / 收起这一团（拉取原文锚点对它没有意义） */
                if (clusterDisplayIds.has(node.id)) {
                  graph.toggleCluster(node.id)
                  return
                }
                const logical = nodeById.get(node.id)
                if (!logical) return
                /**
                 * 章节 / 有子节点的节点：双击保持"折叠 / 展开" —— 这是画布上唯一的折叠入口，不能被抢走。
                 * 叶子节点：双击 = **打开这段原文**，与右侧小图里的双击同一个动作
                 * （用户要求"全局图里也支持双击选择"；跳到原文之后右侧逻辑链面板就会以这个节点为中心）。
                 */
                if (logical.meta?.isSection || (childCount.get(node.id) ?? 0) > 0) {
                  graph.toggleCollapsed(node.id)
                  return
                }
                void jumpToAnchor(logical.anchorIds ?? [], 'node', { nodeId: logical.id, nodeTitle: logical.title })
              }}
              onEdgeClick={(_, edge) => {
                graph.select([], [edge.id])
              }}
              /*
               * 人工建立联系：从节点右侧的圆点拖到另一个节点上。
               * 合法性判定走纯函数 canLinkNodes（不许连自己、同方向不重复），
               * React Flow 的 isValidConnection 也用同一套规则，
               * 于是"拖的时候不给连"和"松手之后被拒绝"永远不会打架。
               */
              nodesConnectable
              isValidConnection={(connection) =>
                canLinkNodes(graph.graph, String(connection.source), String(connection.target)).ok
              }
              connectionRadius={30}
              connectionLineStyle={{ stroke: 'var(--graph-edge-reference)', strokeWidth: 2 }}
              onConnect={(connection) => {
                if (connection.source && connection.target) void connectNodes(connection.source, connection.target)
              }}
              onPaneClick={() => graph.select([], [])}
              onlyRenderVisibleElements
              minZoom={0.05}
              maxZoom={2.5}
              fitView
              defaultEdgeOptions={{ type: 'logical' }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--vscode-editorIndentGuide-background)" />
              <MiniMap
                pannable
                zoomable
                nodeColor={(node) => {
                  const logical = nodeById.get(node.id)
                  return logical ? NODE_KIND_COLOR[logical.kind] ?? '#8a8a8a' : '#8a8a8a'
                }}
                style={{ background: 'var(--graph-canvas)' }}
              />
              <Controls showInteractive={false} />
            </ReactFlow>
            <GraphLegend open={overlays.legend} onToggle={(value) => toggleOverlay('legend', value)} />
            <NodeInspector
              onJump={(anchorIds, kind, context) => void jumpToAnchor(anchorIds, kind, context)}
              onFocus={(node: GraphNode) => {
                const point = graph.positions[node.id]
                if (point) void setCenter(point.x + 110, point.y + 32, { zoom: Math.max(0.6, zoom), duration: 400 })
              }}
            />
          </div>
        </>
      )}

      <GenerationDialog
        open={dialogOpen}
        docId={docId}
        docTitle={docTitle}
        onClose={() => setDialogOpen(false)}
        onStart={async (request) => {
          setDialogOpen(false)
          await graph.generate(request)
          setTimeout(() => void fitView({ padding: 0.2, duration: 400 }), 260)
        }}
      />
      {/* 聚合视图的说明条：让"现在画的是社区、双击可以下钻"这件事在界面上有据可依 */}
      {aggregatedView ? (
        <div className="lr-graph-aggregate-hint">
          {i18n.t('graph.aggregateHint', { clusters: aggregatedView.clusters.length })}
        </div>
      ) : null}
    </div>
  )
}

async function pickLocation(
  anchors: { id: string; charStart: number; charEnd: number; quote: string; primaryJson: string }[]
): Promise<{ charStart: number; charEnd: number } | null> {
  const items = anchors.map((anchor) => {
    let label = ''
    try {
      const primary = JSON.parse(anchor.primaryJson) as { kind: string; page?: number; line?: number; sheet?: string; range?: string }
      if (primary.kind === 'pdf' && primary.page) label = '第 ' + primary.page + ' 页'
      else if (primary.kind === 'text' && primary.line) label = '第 ' + primary.line + ' 行'
      else if (primary.kind === 'sheet') label = primary.sheet + '!' + (primary.range ?? '')
      else if (primary.kind === 'docx' && primary.page) label = '第 ' + primary.page + ' 段'
    } catch {
      label = ''
    }
    return label + '  "' + anchor.quote.slice(0, 40).replace(/\s+/g, ' ') + '"'
  })
  const answer = await api.dialog.message({
    type: 'question',
    message: i18n.t('graph.positionPickerTitle', { count: anchors.length }),
    detail: items.map((item, index) => index + 1 + '. ' + item).join('\n'),
    buttons: [...items.map((_, index) => '→ ' + (index + 1)), i18n.t('common.cancel')],
    cancelId: items.length
  })
  if (answer < 0 || answer >= anchors.length) return null
  return { charStart: anchors[answer].charStart, charEnd: anchors[answer].charEnd }
}

export { EDGE_KINDS }
