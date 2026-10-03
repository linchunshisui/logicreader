import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { EDGE_STYLE, NODE_KIND_COLOR, nodeLabel } from '@logicreader/graph-schema'
import type { GraphNode } from '@logicreader/graph-schema'
import i18n from '../../i18n'

export interface GraphNodeData extends Record<string, unknown> {
  node: GraphNode
  dimmed: boolean
  highlighted: boolean
  detail: 'full' | 'compact' | 'title'
  sourceLabel: string
  childCount: number
  collapsed: boolean
}

function GraphNodeViewInner({ data, selected }: NodeProps): JSX.Element {
  const info = data as unknown as GraphNodeData
  const node = info.node
  const color = NODE_KIND_COLOR[node.kind] ?? '#8a8a8a'
  const isSection = Boolean(node.meta?.isSection)
  return (
    <div
      className="lr-gnode"
      data-selected={selected}
      data-dimmed={info.dimmed}
      data-highlighted={info.highlighted}
      data-section={isSection}
      style={{ opacity: info.dimmed ? 0.25 : 1 }}
    >
      <Handle type="target" position={Position.Left} className="lr-gnode__handle" title={i18n.t('graph.connectHint')} />
      <span className="lr-gnode__bar" style={{ background: color }} />
      <div className="lr-gnode__body">
        <div className="lr-gnode__title" title={node.title}>
          {node.title}
        </div>
        {info.detail !== 'title' && node.summary ? <div className="lr-gnode__summary">{node.summary}</div> : null}
        {info.detail === 'full' ? (
          <div className="lr-gnode__meta">
            <span className="lr-gnode__kind">{nodeLabel(node.kind, i18n.language)}</span>
            {info.sourceLabel ? <span className="lr-gnode__source">{info.sourceLabel}</span> : null}
            {info.childCount > 0 ? <span className="lr-gnode__children">▣ {info.childCount}</span> : null}
          </div>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} className="lr-gnode__handle" title={i18n.t('graph.connectHint')} />
    </div>
  )
}

export const GraphNodeView = memo(GraphNodeViewInner)
void EDGE_STYLE
