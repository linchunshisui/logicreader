import { useTranslation } from 'react-i18next'
import { useGraph } from '../../state/graph.store'

/**
 * 质量报告。
 *
 * 展开状态由调用方持有（存在关系图标签的 view 里，见 GraphViewState.overlays）：
 * 默认**收起**成一行摘要 —— 它和迷你地图、图例同时展开时，画布中央就没地方看图了。
 */
export function QualityReport({
  open,
  onToggle
}: {
  open: boolean
  onToggle: (open: boolean) => void
}): JSX.Element | null {
  const { t } = useTranslation()
  const graph = useGraph()
  const data = graph.graph
  if (!data) return null
  const stats = data.stats

  const rows: { label: string; value: string; action?: JSX.Element }[] = [
    { label: t('graph.metricNodes'), value: stats.nodeCount + ' / ' + stats.edgeCount },
    {
      label: t('graph.metricAnchorCoverage'),
      value: Math.round((stats.anchorCoverage ?? 0) * 100) + '%'
    },
    {
      label: t('graph.metricFailedChunks'),
      value: String(stats.failedChunks ?? 0),
      action:
        (stats.failedChunks ?? 0) > 0 ? (
          <button className="lr-chip" onClick={() => void graph.retryFailed()}>
            {t('graph.actionRetryFailed')}
          </button>
        ) : undefined
    },
    { label: t('graph.metricIsolated'), value: String(stats.isolatedNodes ?? 0) },
    {
      label: t('graph.metricEvidence'),
      value: String(stats.avgEvidenceLength ?? 0),
      action:
        (stats.avgEvidenceLength ?? 0) > 0 && (stats.avgEvidenceLength ?? 0) < 12 ? (
          <span className="lr-setting__hint">{t('graph.evidenceWeak')}</span>
        ) : undefined
    },
    { label: t('graph.metricMerged'), value: String(stats.mergedEntities ?? 0) }
  ]

  return (
    <div className="lr-quality" data-open={open}>
      <button className="lr-quality__toggle" onClick={() => onToggle(!open)}>
        {open ? '▾' : '▸'} {t('graph.qualityReport')}
        <span className="lr-quality__summary">
          {stats.nodeCount} · {stats.edgeCount} · {Math.round((stats.anchorCoverage ?? 0) * 100)}%
        </span>
      </button>
      {open ? (
        <div className="lr-quality__body">
          {rows.map((row) => (
            <div key={row.label} className="lr-quality__row">
              <span className="lr-setting__hint">{row.label}</span>
              <span className="lr-quality__value">{row.value}</span>
              {row.action}
            </div>
          ))}
          <div className="lr-quality__actions">
            <button className="lr-chip" onClick={() => void graph.refine(sectionIdsOf(graph))}>
              {t('graph.actionUpgrade')}
            </button>
            <button className="lr-chip" onClick={() => graph.toggleAggregate()}>
              {t('graph.actionDowngrade')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function sectionIdsOf(graph: ReturnType<typeof useGraph.getState>): string[] {
  const data = graph.graph
  if (!data) return []
  const sections = data.nodes.filter((node) => node.meta?.isSection)
  return sections.slice(0, 3).map((node) => String(node.meta?.sectionId ?? node.id))
}
