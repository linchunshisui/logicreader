import { memo } from 'react'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { EDGE_STYLE, edgeLabel, type EdgeKind } from '@logicreader/graph-schema'
import i18n from '../../i18n'

export interface GraphEdgeData extends Record<string, unknown> {
  kind: EdgeKind
  label: string
  dimmed: boolean
  showLabel: boolean
}

function GraphEdgeViewInner(props: EdgeProps): JSX.Element {
  const data = props.data as unknown as GraphEdgeData | undefined
  const kind = (data?.kind ?? 'references') as EdgeKind
  const style = EDGE_STYLE[kind]
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition
  })
  const text = data?.label && data.label.length > 0 ? data.label : edgeLabel(kind, i18n.language)
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        style={{
          stroke: style?.color ?? '#9a9a9a',
          strokeWidth: props.selected ? 2.6 : style?.width ?? 1.5,
          strokeDasharray: style?.dash ?? undefined,
          opacity: data?.dimmed ? 0.2 : 1
        }}
        markerEnd={props.markerEnd}
      />
      {data?.showLabel !== false && !data?.dimmed ? (
        <EdgeLabelRenderer>
          <div
            className="lr-gedge-label"
            style={{ transform: 'translate(-50%, -50%) translate(' + labelX + 'px,' + labelY + 'px)' }}
          >
            {text}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

export const GraphEdgeView = memo(GraphEdgeViewInner)
