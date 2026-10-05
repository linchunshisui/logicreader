import { memo } from 'react'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { EDGE_STYLE, edgeLabel, edgeStrokeWidth, type EdgeKind } from '@logicreader/graph-schema'
import i18n from '../../i18n'

export interface GraphEdgeData extends Record<string, unknown> {
  kind: EdgeKind
  label: string
  dimmed: boolean
  showLabel: boolean
  /** 原文对这一关系的断言强度 1..10（抽取时给出）；只用来调线宽，不参与过滤 */
  strength?: number
}

/**
 * 强度 → 线宽倍率的规则住在词表里（`edgeStrokeWidth`），界面与导出 SVG 共用同一条 ——
 * 这里不再自己算，避免两处漂移。
 */
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
  const baseWidth = edgeStrokeWidth(kind, data?.strength)
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        style={{
          stroke: style?.color ?? '#9a9a9a',
          strokeWidth: props.selected ? baseWidth + 1.1 : baseWidth,
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
