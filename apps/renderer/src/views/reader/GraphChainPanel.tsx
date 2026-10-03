/**
 * 跳转之后，在文段**旁边**显示与跳转节点相关的**局部逻辑链**。
 *
 * 为什么需要它：从关系图跳到原文时，光有一段高亮回答不了两个问题 ——
 * "这段说的是什么关系""它在论证里处在什么位置"。把该节点的一度关系
 * （谁指向它 / 它指向谁）摆在旁边，跳转才从"定位"变成"读懂"。
 *
 * 数据来源是**内存里的关系图**（跳转就是从那张图发起的，图还在 store 里）；
 * 只显示与被跳转节点有关的部分，不重复整张图。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { edgeLabel, nodeLabel, NODE_KIND_COLOR } from '@logicreader/graph-schema'
import type { GraphEdge, GraphNode } from '@logicreader/graph-schema'
import { api } from '../../lib/api'
import i18n from '../../i18n'
import { openGraphTab } from '../../commands'
import { revealInReader } from '../../lib/graphJump'
import { useGraph } from '../../state/graph.store'
import { useUiStore } from '../../state/ui.store'
import { LocalGraphMap } from './LocalGraphMap'

const MAX_ROWS = 5

export function GraphChainPanel({ docId }: { docId: string }): JSX.Element | null {
  const { t } = useTranslation()
  const request = useUiStore((state) => state.revealRequest)
  const graph = useGraph((state) => state.graph)
  const positions = useGraph((state) => state.positions)
  const [busy, setBusy] = useState(false)
  /**
   * "仅查看"的节点：在小图里**单击**另一个节点时，右侧信息就地切到它（摘要 / 依据 / 关系清单 / 小图中心），
   * 但**不移动论文** —— 要移动就双击那个节点，或点这里出现的「跳转」。
   * 每次真正跳转（新的定位请求）都会把它清掉：跳转结果永远优先。
   */
  const [previewId, setPreviewId] = useState<string | null>(null)
  const nonce = request?.nonce ?? 0
  useEffect(() => {
    setPreviewId(null)
  }, [nonce])

  const chain = request?.chain
  if (!chain || !request || request.docId !== docId || !graph || graph.docId !== docId) return null
  const activeId = previewId && graph.nodes.some((item) => item.id === previewId) ? previewId : chain.nodeId
  const node = graph.nodes.find((item) => item.id === activeId)
  if (!node) return null
  const previewing = activeId !== chain.nodeId

  const outgoing = graph.edges.filter((edge) => edge.from === node.id).slice(0, MAX_ROWS)
  const incoming = graph.edges.filter((edge) => edge.to === node.id).slice(0, MAX_ROWS)
  const nodeById = new Map(graph.nodes.map((item) => [item.id, item]))

  /** 跳到对端节点对应的原文（与图中跳转走同一条路径，链可以一路追下去） */
  const jumpToPeer = async (peer: GraphNode): Promise<void> => {
    const inline = peer.anchors?.[0]
    const anchorId = peer.anchorIds?.[0]
    const record = inline ? null : anchorId ? await api.store.getAnchor(anchorId) : null
    const range = inline
      ? { charStart: inline.charStart, charEnd: inline.charEnd }
      : record
        ? { charStart: record.charStart, charEnd: record.charEnd }
        : null
    if (!range) return
    setBusy(true)
    try {
      await revealInReader(docId, range.charStart, range.charEnd, {
        hold: true,
        chain: { nodeId: peer.id, title: peer.title, via: 'node' }
      })
    } finally {
      setBusy(false)
    }
  }

  const renderRow = (edge: GraphEdge, peer: GraphNode | undefined, direction: 'in' | 'out'): JSX.Element | null => {
    if (!peer) return null
    return (
      <button
        key={edge.id}
        className="lr-chain__row"
        disabled={busy}
        onClick={() => void jumpToPeer(peer)}
        title={peer.title}
      >
        <span className="lr-chain__swatch" style={{ background: NODE_KIND_COLOR[peer.kind] ?? '#8a8a8a' }} />
        <span className="lr-chain__edge">
          {direction === 'out' ? '→' : '←'} {edgeLabel(edge.kind, i18n.language)}
        </span>
        <span className="lr-chain__peer">{peer.title}</span>
      </button>
    )
  }

  return (
    <aside className="lr-chain" data-reveal-node={node.id}>
      <div className="lr-chain__header">
        <span className="lr-chain__swatch" style={{ background: NODE_KIND_COLOR[node.kind] ?? '#8a8a8a' }} />
        <span className="lr-chain__title" title={node.title}>
          {node.title}
        </span>
        <button
          className="lr-icon-button"
          title={t('common.close')}
          onClick={() => useUiStore.getState().clearReveal()}
        >
          ✕
        </button>
      </div>
      <div className="lr-chain__body">
        {/*
         * 局部放大图：把"这段在论证里处在什么位置"画出来。
         * 图里每个对端节点都可点，点了走与下面清单**同一段跳转逻辑**，跳过去后面板以新节点为中心重画。
         */}
        <LocalGraphMap
          centerId={node.id}
          nodes={graph.nodes}
          edges={graph.edges}
          positions={positions}
          busy={busy}
          onInspect={(peer) => setPreviewId(peer.id)}
          onJump={(peer) => void jumpToPeer(peer)}
        />
        <div className="lr-chain__meta">
          <span className="lr-chain__badge">{nodeLabel(node.kind, i18n.language)}</span>
          {chain.via === 'edge' ? <span className="lr-chain__badge">{t('graph.fromEdge')}</span> : null}
          {previewing ? (
            <>
              <span className="lr-chain__badge" data-preview="true">
                {t('graph.localMapPreview')}
              </span>
              <button className="lr-chain__link" data-action="jump-current" onClick={() => void jumpToPeer(node)}>
                {t('graph.jumpTo')}
              </button>
            </>
          ) : null}
        </div>
        {node.summary ? <div className="lr-chain__summary">{node.summary}</div> : null}
        {node.anchors?.[0]?.quote ? (
          <div className="lr-chain__quote">“{node.anchors[0].quote.slice(0, 120)}”</div>
        ) : null}

        {incoming.length > 0 ? <div className="lr-chain__group">{t('graph.chainIncoming')}</div> : null}
        {incoming.map((edge) => renderRow(edge, nodeById.get(edge.from), 'in'))}

        {outgoing.length > 0 ? <div className="lr-chain__group">{t('graph.chainOutgoing')}</div> : null}
        {outgoing.map((edge) => renderRow(edge, nodeById.get(edge.to), 'out'))}

        {incoming.length === 0 && outgoing.length === 0 ? (
          <div className="lr-chain__empty">{t('graph.chainEmpty')}</div>
        ) : null}
      </div>
      <div className="lr-chain__footer">
        <button
          className="lr-button lr-button--secondary"
          data-action="show-in-graph"
          onClick={() => {
            openGraphTab(docId)
            useGraph.getState().requestFocus(node.id)
          }}
        >
          {t('graph.showInGraph')}
        </button>
      </div>
    </aside>
  )
}
