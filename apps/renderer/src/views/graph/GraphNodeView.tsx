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
  /**
   * 聚合视图下的超级节点：带上成员数与成员 id。
   * 有它 = 这个点代表一整团社区（不是原文里抽出来的某个概念），外观与交互都要区别对待。
   */
  cluster?: { size: number; memberIds: string[] }
}

function GraphNodeViewInner({ data, selected }: NodeProps): JSX.Element {
  const info = data as unknown as GraphNodeData
  const node = info.node
  const cluster = info.cluster
  const color = NODE_KIND_COLOR[node.kind] ?? '#8a8a8a'
  const isSection = Boolean(node.meta?.isSection)
  return (
    <div
      className="lr-gnode"
      data-selected={selected}
      data-dimmed={info.dimmed}
      data-highlighted={info.highlighted}
      data-section={isSection}
      data-cluster={Boolean(cluster)}
      style={{ opacity: info.dimmed ? 0.25 : 1 }}
    >
      <Handle type="target" position={Position.Left} className="lr-gnode__handle" title={i18n.t('graph.connectHint')} />
      <span className="lr-gnode__bar" style={{ background: color }} />
      <div className="lr-gnode__body">
        <div className="lr-gnode__title" title={node.title}>
          {node.title}
        </div>
        {/* 超级节点不显示摘要（它是"这一团的代表概念"的摘要，容易被误读成整团的摘要） */}
        {!cluster && info.detail !== 'title' && node.summary ? (
          <div className="lr-gnode__summary">{node.summary}</div>
        ) : null}
        {info.detail === 'full' ? (
          <div className="lr-gnode__meta">
            {cluster ? (
              <>
                <span className="lr-gnode__kind">{i18n.t('graph.clusterSize', { count: cluster.size })}</span>
                <span className="lr-gnode__children">{i18n.t('graph.clusterDrill')}</span>
              </>
            ) : (
              <>
                <span className="lr-gnode__kind">{nodeLabel(node.kind, i18n.language)}</span>
                {info.sourceLabel ? <span className="lr-gnode__source">{info.sourceLabel}</span> : null}
                {info.childCount > 0 ? <span className="lr-gnode__children">▣ {info.childCount}</span> : null}
              </>
            )}
          </div>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} className="lr-gnode__handle" title={i18n.t('graph.connectHint')} />
    </div>
  )
}

export const GraphNodeView = memo(GraphNodeViewInner)
void EDGE_STYLE
