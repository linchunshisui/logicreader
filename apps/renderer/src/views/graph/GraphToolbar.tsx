import { useTranslation } from 'react-i18next'
import { EDGE_KINDS, NODE_KINDS, EDGE_STYLE, NODE_KIND_COLOR, edgeLabel, nodeLabel } from '@logicreader/graph-schema'
import type { EdgeKind, NodeKind } from '@logicreader/graph-schema'
import { useGraph } from '../../state/graph.store'
import { useEffect, useState } from 'react'
import i18n from '../../i18n'

export function GraphToolbar({
  onGenerate,
  onFit,
  zoom
}: {
  onGenerate: () => void
  onFit: () => void
  zoom: number
}): JSX.Element {
  const { t } = useTranslation()
  const graph = useGraph()
  const [showFilter, setShowFilter] = useState(false)
  const generation = graph.graph?.generation

  const toggleEdgeKind = (kind: EdgeKind): void => {
    const next = graph.edgeKindFilter.includes(kind)
      ? graph.edgeKindFilter.filter((item) => item !== kind)
      : [...graph.edgeKindFilter, kind]
    graph.setEdgeKindFilter(next)
  }

  const toggleNodeKind = (kind: NodeKind): void => {
    const next = graph.nodeKindFilter.includes(kind)
      ? graph.nodeKindFilter.filter((item) => item !== kind)
      : [...graph.nodeKindFilter, kind]
    graph.setNodeKindFilter(next)
  }

  return (
    <div className="lr-graph__toolbar">
      <button className="lr-icon-button" title={t('graph.regenerate')} onClick={onGenerate}>
        ⟳
      </button>
      {generation ? (
        <span className="lr-graph__generation" title={t('graph.regenerateSame')}>
          🤖 {generation.agentName || generation.agentId} · {generation.modelId ?? '-'} ·{' '}
          {generation.thinkingEffort ? t('graph.effort') + '：' + generation.thinkingEffort : '-'}
        </span>
      ) : null}
      <div className="lr-reader__toolbar-divider" />
      <select value={graph.layoutMode} onChange={(event) => void graph.runLayout(event.target.value as 'layered')} title={t('graph.layout')}>
        <option value="layered">{t('graph.layoutLayered')}</option>
        <option value="force">{t('graph.layoutForce')}</option>
        <option value="radial">{t('graph.layoutRadial')}</option>
      </select>
      <button className="lr-icon-button" data-active={graph.aggregated} title={t('graph.aggregate')} onClick={() => graph.toggleAggregate()}>
        ⬤
      </button>
      <button className="lr-icon-button" data-active={showFilter} title={t('graph.filter')} onClick={() => setShowFilter((value) => !value)}>
        ⌗
      </button>
      <input
        className="lr-graph__search"
        value={graph.searchTerm}
        placeholder={t('graph.searchPlaceholder')}
        onChange={(event) => graph.setSearch(event.target.value)}
      />
      <div className="lr-reader__toolbar-spacer" />
      <span className="lr-reader__toolbar-meta">{Math.round(zoom * 100)}%</span>
      <button className="lr-icon-button" title={t('graph.fitView')} onClick={onFit}>
        ⤢
      </button>
      <select
        className="lr-graph__export"
        value=""
        onChange={(event) => {
          const value = event.target.value as 'json' | 'markdown' | 'svg' | 'png' | 'jpg' | ''
          if (value) void graph.exportAs(value)
        }}
        title={t('common.export')}
      >
        <option value="">⤓ {t('common.export')}</option>
        <option value="json">{t('graph.exportJson')}</option>
        <option value="markdown">{t('graph.exportMarkdown')}</option>
        <option value="svg">{t('graph.exportSvg')}</option>
        <option value="png">{t('graph.exportPng')}</option>
        <option value="jpg">{t('graph.exportJpg')}</option>
      </select>
      <button className="lr-icon-button" title={t('graph.importTitle')} onClick={() => void graph.importJson()}>
        ⤒
      </button>
      {showFilter ? (
        <div className="lr-graph__filter-panel">
          <div className="lr-graph__filter-group">
            <div className="lr-graph__filter-title">{t('graph.nodeKinds')}</div>
            {NODE_KINDS.map((kind) => (
              <label key={kind} className="lr-graph__filter-item">
                <input type="checkbox" checked={graph.nodeKindFilter.includes(kind)} onChange={() => toggleNodeKind(kind)} />
                <span className="lr-graph__swatch" style={{ background: NODE_KIND_COLOR[kind] }} />
                {nodeLabel(kind, i18n.language)}
              </label>
            ))}
          </div>
          <div className="lr-graph__filter-group">
            <div className="lr-graph__filter-title">{t('graph.edgeKinds')}</div>
            {EDGE_KINDS.map((kind) => (
              <label key={kind} className="lr-graph__filter-item">
                <input type="checkbox" checked={graph.edgeKindFilter.includes(kind)} onChange={() => toggleEdgeKind(kind)} />
                <span className="lr-graph__swatch" style={{ background: EDGE_STYLE[kind].color }} />
                {edgeLabel(kind, i18n.language)}
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function GraphLegend(): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(true)
  return (
    <div className="lr-graph__legend" data-open={open}>
      <button className="lr-graph__legend-toggle" onClick={() => setOpen((value) => !value)}>
        {open ? '▾' : '▸'} {t('graph.legend')}
      </button>
      {open ? (
        <div className="lr-graph__legend-body">
          {EDGE_KINDS.map((kind) => (
            <div key={kind} className="lr-graph__legend-row">
              <span className="lr-graph__legend-line" style={{ background: EDGE_STYLE[kind].color }} />
              {edgeLabel(kind, i18n.language)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * 图上的选中项检查器。
 *
 * **跳转只在这里触发**（节点与连线都是）：画布上的单击只负责选中，
 * 否则每点一下就切到阅读器，浏览图的动作会被反复打断。
 */
export function NodeInspector({
  onJump,
  onFocus
}: {
  /** context = 这次跳转的"来源节点"：阅读器会据此在文段旁显示它的局部逻辑链 */
  onJump: (
    anchorIds: string[],
    kind: 'node' | 'edge',
    context?: { nodeId: string; nodeTitle: string }
  ) => void
  onFocus: (node: import('@logicreader/graph-schema').GraphNode) => void
}): JSX.Element | null {
  const { t } = useTranslation()
  const graph = useGraph()
  const [renaming, setRenaming] = useState(false)
  const [value, setValue] = useState('')
  const [asking, setAsking] = useState(false)
  const [question, setQuestion] = useState('')
  const [askBusy, setAskBusy] = useState(false)
  /** 手工连线的关系说明（选中别的线时同步过来） */
  const [edgeLabelValue, setEdgeLabelValue] = useState('')
  const nodes = (graph.graph?.nodes ?? []).filter((node) => graph.selectedNodeIds.includes(node.id))
  const node = nodes[0]
  const edge = (graph.graph?.edges ?? []).find((item) => graph.selectedEdgeIds.includes(item.id))
  const edgeId = edge?.id ?? null
  useEffect(() => {
    setEdgeLabelValue(edge?.label ?? '')
  }, [edgeId])

  if (!node && !edge) return null

  if (edge && !node) {
    return (
      <div className="lr-graph__inspector">
        <div className="lr-graph__inspector-title">
          {edgeLabel(edge.kind, i18n.language)}
          {edge.meta?.manual ? <span className="lr-setting__hint">{t('graph.manualEdge')}</span> : null}
        </div>
        <div className="lr-graph__inspector-row">
          <span className="lr-setting__hint">{t('graph.edgeLabel')}</span>
          <input
            value={edgeLabelValue}
            placeholder={t('graph.edgeLabelPlaceholder')}
            onChange={(event) => setEdgeLabelValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void graph.setEdgeLabel(edge.id, edgeLabelValue)
              if (event.key === 'Escape') setEdgeLabelValue(edge.label ?? '')
            }}
            onBlur={() => {
              if (edgeLabelValue !== (edge.label ?? '')) void graph.setEdgeLabel(edge.id, edgeLabelValue)
            }}
          />
        </div>
        <div className="lr-graph__inspector-row">
          <span className="lr-setting__hint">{t('graph.edgeEvidence')}</span>
          <span>{String(edge.meta?.evidence ?? '-').slice(0, 120)}</span>
        </div>
        <div className="lr-graph__inspector-actions">
          <select value={edge.kind} onChange={(event) => void graph.changeEdgeKind(edge.id, event.target.value as EdgeKind)}>
            {EDGE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {edgeLabel(kind, i18n.language)}
              </option>
            ))}
          </select>
          <button
            className="lr-button"
            data-action="jump"
            onClick={() => {
              // 连线没有"单个节点"，用它的起点作为逻辑链的入口（面板里会注明来自连线）
              const from = (graph.graph?.nodes ?? []).find((item) => item.id === edge.from)
              onJump(edge.anchorIds, 'edge', from ? { nodeId: from.id, nodeTitle: from.title } : undefined)
            }}
          >
            {t('graph.jumpTo')} ({edge.anchorIds.length})
          </button>
          <button className="lr-button lr-button--secondary" onClick={() => void graph.deleteEdge(edge.id)}>
            {t('graph.ignoreEdge')}
          </button>
        </div>
      </div>
    )
  }

  if (!node) return null

  const submitAsk = async (): Promise<void> => {
    const text = question.trim()
    if (text.length === 0) return
    setAskBusy(true)
    try {
      const { askFromNode } = await import('../../state/askFlow')
      await askFromNode(node.id, text)
      setQuestion('')
      setAsking(false)
    } finally {
      setAskBusy(false)
    }
  }

  return (
    <div className="lr-graph__inspector">
      {renaming ? (
        <div className="lr-graph__inspector-actions">
          <input value={value} onChange={(event) => setValue(event.target.value)} autoFocus />
          <button
            className="lr-button"
            onClick={() => {
              void graph.renameNode(node.id, value.slice(0, 40))
              setRenaming(false)
            }}
          >
            {t('common.save')}
          </button>
          <button className="lr-button lr-button--secondary" onClick={() => setRenaming(false)}>
            {t('common.cancel')}
          </button>
        </div>
      ) : (
        <div className="lr-graph__inspector-title" onDoubleClick={() => {
          setValue(node.title)
          setRenaming(true)
        }}>
          <span className="lr-graph__swatch" style={{ background: NODE_KIND_COLOR[node.kind] }} />
          {node.title}
        </div>
      )}
      {node.summary ? <div className="lr-graph__inspector-row">{node.summary}</div> : null}
      <div className="lr-graph__inspector-row">
        <span className="lr-setting__hint">{t('graph.nodeType')}</span>
        <select value={node.kind} onChange={(event) => void graph.changeNodeKind(node.id, event.target.value as NodeKind)}>
          {NODE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {nodeLabel(kind, i18n.language)}
            </option>
          ))}
        </select>
      </div>
      {node.anchors?.[0] ? (
        <div className="lr-graph__inspector-quote">“{node.anchors[0].quote.slice(0, 140)}”</div>
      ) : null}
      {asking ? (
        <div className="lr-graph__inspector-ask">
          <textarea
            autoFocus
            rows={2}
            value={question}
            placeholder={t('agent.inputPlaceholder')}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submitAsk()
              }
              if (event.key === 'Escape') setAsking(false)
            }}
          />
          <div className="lr-graph__inspector-actions">
            <button className="lr-button" disabled={askBusy || question.trim().length === 0} onClick={() => void submitAsk()}>
              {askBusy ? t('agent.thinking') + '…' : t('agent.send')}
            </button>
            <button className="lr-button lr-button--secondary" onClick={() => setAsking(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : null}
      <div className="lr-graph__inspector-actions">
        <button
          className="lr-button"
          data-action="jump"
          onClick={() => onJump(node.anchorIds, 'node', { nodeId: node.id, nodeTitle: node.title })}
        >
          {t('graph.jumpTo')} ({node.anchorIds.length})
        </button>
        <button className="lr-button lr-button--secondary" onClick={() => onFocus(node)}>
          {t('graph.fitView')}
        </button>
        <button className="lr-button lr-button--secondary" onClick={() => setRenaming(true)}>
          {t('graph.rename')}
        </button>
        <button className="lr-button lr-button--secondary" onClick={() => setAsking((current) => !current)}>
          {t('graph.askNode')}
        </button>
        <button className="lr-button lr-button--secondary" onClick={() => void graph.deleteNode(node.id)}>
          {t('graph.deleteNode')}
        </button>
      </div>
    </div>
  )
}
