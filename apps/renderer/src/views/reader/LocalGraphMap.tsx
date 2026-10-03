/**
 * 阅读器右侧的「关系图小窗」：跳转落到原文后，在文段旁边给出图上上下文。
 *
 * 两种视图（面板里的分段开关切换）：
 *  - **整个图谱**（默认）：与**全局关系图同一张图** —— 坐标直接取全局画布那份
 *    （`graph.positions`，布局 Worker 算好并落库），节点尺寸也一致（220×64），
 *    所以看到的就是同一张图的同一套排布，只是窗口更小；窗口支持**滚轮缩放 / 拖动平移 /
 *    ＋− 与「适应」「定位当前节点」**，缩放到哪里都能看清（见 lib/graphViewport.ts）。
 *  - **只看相邻**：字更大的一度关系（左=指向它、右=由它指向），看清"这一段直接跟谁有关"。
 *
 * 两种视图**点哪儿都跳到哪儿**：图里点一个节点，走的是与下方清单同一段跳转逻辑
 * （`GraphChainPanel.jumpToPeer`），跳过去之后面板就以新节点为中心重画 —— 于是可以一路追下去。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { useTranslation } from 'react-i18next'
import { EDGE_KINDS, EDGE_STYLE, NODE_KIND_COLOR, edgeLabel, nodeLabel } from '@logicreader/graph-schema'
import type { GraphEdge, GraphNode } from '@logicreader/graph-schema'
import {
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
  centerOn,
  fitViewport,
  focusViewport,
  graphBounds,
  toScreen,
  zoomAt,
  type Viewport
} from '../../lib/graphViewport'
import { layoutLocalMap } from '../../lib/localMap'

interface Props {
  centerId: string
  nodes: readonly GraphNode[]
  edges: readonly GraphEdge[]
  /** 全局画布那份坐标（关系图 store 的 positions）；缺项时退回节点自带的 x/y */
  positions: Record<string, { x: number; y: number }>
  busy: boolean
  /** 单击：只在右侧把信息切到这个节点（不移动论文） */
  onInspect: (node: GraphNode) => void
  /** 双击（或回车）：跳到这个节点的原文 */
  onJump: (node: GraphNode) => void
}

/** 「只看相邻」每侧最多画几个（面板窄，剩下的在下方清单里，一条不少） */
const MAX_PER_SIDE = 4
/** 整个图谱窗口的固定高度（宽随面板） */
const AREA_HEIGHT = 300

type ViewMode = 'whole' | 'neighbors'

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

export function LocalGraphMap({ centerId, nodes, edges, positions, busy, onInspect, onJump }: Props): JSX.Element | null {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const [mode, setMode] = useState<ViewMode>('whole')
  const areaRef = useRef<HTMLDivElement | null>(null)
  const draggedRef = useRef(false)
  const [size, setSize] = useState({ width: 0, height: AREA_HEIGHT })
  const [viewport, setViewport] = useState<Viewport | null>(null)

  /* ---------------------------------------------------------------- 世界坐标 */
  /** 与全局画布完全同源：positions 优先，节点自带的 x/y 兜底（与 GraphCanvas 一致） */
  const world = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>()
    for (const node of nodes) {
      map.set(node.id, positions[node.id] ?? { x: node.x ?? 0, y: node.y ?? 0 })
    }
    return map
  }, [nodes, positions])
  const bounds = useMemo(() => graphBounds([...world.values()]), [world])

  const neighbors = useMemo(
    () => layoutLocalMap(centerId, nodes, edges, { maxPerSide: MAX_PER_SIDE }),
    [centerId, nodes, edges]
  )

  /* ---------------------------------------------------------------- 视口 */
  useEffect(() => {
    const element = areaRef.current
    if (!element) return
    const apply = (): void => setSize({ width: element.clientWidth, height: element.clientHeight })
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(element)
    return () => observer.disconnect()
    // 依赖 mode：切到"只看相邻"时这个窗口会被卸载，切回来是一个**新**元素，必须重新挂观察
  }, [mode])

  /** 图换了 / 窗口尺寸变了 → 重新"适应"（用户手动缩放不会被覆盖：依赖只有 bounds 与尺寸） */
  useEffect(() => {
    if (!bounds || size.width === 0) return
    setViewport(fitViewport(bounds, size.width, size.height))
  }, [bounds, size.width, size.height])

  const focusPoint = useMemo(() => {
    const point = world.get(centerId)
    if (!point) return null
    return { x: point.x + GRAPH_NODE_WIDTH / 2, y: point.y + GRAPH_NODE_HEIGHT / 2 }
  }, [world, centerId])

  /**
   * 焦点跑到窗口外了（比如顺着逻辑链跳到很远的一段）才把它拉回视野中间。
   *
   * **只对"中心节点变了"这件事做一次**（`handledFocusRef` 记住处理过哪个节点）：
   * 否则用户一拖动、焦点离开窗口，effect 就会把视图拽回去 —— 那正是"锁定在某个节点上"的来源。
   * 用户手动拖动 / 缩放之后，视图归用户管，直到下一次真的换了中心节点。
   */
  const handledFocusRef = useRef<string | null>(null)
  useEffect(() => {
    if (!viewport || !focusPoint || size.width === 0) return
    if (handledFocusRef.current === centerId) return
    handledFocusRef.current = centerId
    const screen = toScreen(viewport, focusPoint)
    const inside = screen.x > 0 && screen.x < size.width && screen.y > 0 && screen.y < size.height
    if (inside) return
    setViewport((current) => (current ? centerOn(current, focusPoint.x, focusPoint.y, size.width, size.height) : current))
  }, [centerId, focusPoint, viewport, size.width, size.height])

  const zoomBy = useCallback(
    (factor: number): void => {
      setViewport((current) => (current ? zoomAt(current, factor, size.width / 2, size.height / 2) : current))
    },
    [size.width, size.height]
  )

  const fitNow = useCallback((): void => {
    if (bounds && size.width > 0) setViewport(fitViewport(bounds, size.width, size.height))
  }, [bounds, size.width, size.height])

  /** 定位当前节点：居中 **并且至少放大到看得清字**（已经更大就只居中） */
  const locateNow = useCallback((): void => {
    if (!focusPoint || size.width === 0) return
    setViewport((current) =>
      current ? focusViewport(current, focusPoint.x, focusPoint.y, size.width, size.height) : current
    )
  }, [focusPoint, size.width, size.height])

  /* 滚轮缩放：React 的 onWheel 是被动监听，preventDefault 不生效，所以这里挂原生监听 */
  useEffect(() => {
    const element = areaRef.current
    if (!element || mode !== 'whole') return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
      setViewport((current) =>
        current ? zoomAt(current, factor, event.clientX - rect.left, event.clientY - rect.top) : current
      )
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [mode])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (mode !== 'whole' || !viewport) return
    draggedRef.current = false
    /*
     * **不要**在这里给容器 setPointerCapture：指针一旦被容器捕获，浏览器会把 click / dblclick
     * 一并重定向给捕获元素，卡片上的单击/双击全都收不到（真机上就是"双击无效"，而合成事件的冒烟
     * 因为捕获失败被 catch 吞掉，反而测不出来）。
     * 改成拖动期间挂 window 监听：效果一样，但不改变事件目标。
     */
    const start = { x: event.clientX, y: event.clientY, tx: viewport.tx, ty: viewport.ty }
    const onMove = (move: PointerEvent): void => {
      const dx = move.clientX - start.x
      const dy = move.clientY - start.y
      if (!draggedRef.current && Math.abs(dx) + Math.abs(dy) < 3) return
      draggedRef.current = true
      setViewport((current) => (current ? { ...current, tx: start.tx + dx, ty: start.ty + dy } : current))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  if (!bounds && !neighbors) return null

  const hiddenNeighbors = neighbors ? neighbors.hidden.in + neighbors.hidden.out : 0
  const zoomPercent = Math.round((viewport?.k ?? 1) * 100)

  const modeButton = (
    <span className="lr-localmap__modes">
      <button
        type="button"
        className="lr-localmap__mode"
        data-mode="whole"
        aria-pressed={mode === 'whole'}
        data-active={mode === 'whole'}
        onClick={() => setMode('whole')}
      >
        {t('graph.localMapWhole')}
      </button>
      <button
        type="button"
        className="lr-localmap__mode"
        data-mode="neighbors"
        aria-pressed={mode === 'neighbors'}
        data-active={mode === 'neighbors'}
        onClick={() => setMode('neighbors')}
      >
        {t('graph.localMapNeighbors')}
      </button>
    </span>
  )

  /** 卡片：两种视图共用（参数不同）——点击跳转、可聚焦、可回车 */
  const renderCard = (input: {
    node: GraphNode
    x: number
    y: number
    width: number
    height: number
    focus: boolean
    kindLine?: string
    kindColor?: string
  }): JSX.Element => {
    const color = NODE_KIND_COLOR[input.node.kind] ?? '#8a8a8a'
    /**
     * 桌面上的老规矩：**单击 = 选来看（就地切换右侧信息）**，**双击 = 打开（跳到那段原文）**。
     * 这样两种手势不打架 —— 单击的副作用只是换面板内容，双击的两次 click 只是把同一份信息刷两遍。
     */
    const inspect = (): void => {
      if (input.focus || draggedRef.current) return
      onInspect(input.node)
    }
    const open = (): void => {
      if (busy || draggedRef.current) return
      onJump(input.node)
    }
    return (
      <g
        key={input.node.id}
        className={'lr-localmap__card ' + (input.focus ? 'lr-localmap__card--center' : 'lr-localmap__card--peer')}
        data-center-node={input.focus ? input.node.id : undefined}
        data-peer-node={input.focus ? undefined : input.node.id}
        style={{ ['--lm-color']: color } as CSSProperties}
        /*
         * 双击在**所有**卡片上都有效，包括中心卡片：
         * 单击会把被点的节点变成中心（面板换内容），于是"双击打开"的第一次 click 就换过一次中心了 ——
         * 如果中心卡片不接双击，双击永远打不开（实测踩到）。单击则只对非中心卡片有意义。
         */
        onDoubleClick={open}
        {...(input.focus
          ? {}
          : {
              role: 'button',
              tabIndex: 0,
              'aria-label': input.node.title,
              onClick: inspect,
              onKeyDown: (event: React.KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  open()
                }
              }
            })}
      >
        <title>{input.node.title + ' · ' + nodeLabel(input.node.kind, locale)}</title>
        <rect className="lr-localmap__box" x={input.x} y={input.y} width={input.width} height={input.height} rx={input.kindLine ? 5 : 8} />
        <rect className="lr-localmap__bar" x={input.x} y={input.y + 6} width={3} height={input.height - 12} rx={1.5} />
        {input.kindLine ? (
          <foreignObject x={input.x} y={input.y} width={input.width} height={input.height}>
            <div className="lr-localmap__inner">
              <span className="lr-localmap__kind" style={{ color: input.kindColor }}>
                {input.kindLine}
              </span>
              <span className="lr-localmap__label" title={input.node.title}>
                {input.node.title}
              </span>
            </div>
          </foreignObject>
        ) : (
          <>
            <text className="lr-localmap__label lr-localmap__label--strong" x={input.x + 12} y={input.y + 26}>
              {truncate(input.node.title, Math.max(4, Math.round((input.width - 30) / 13)))}
            </text>
            <text className="lr-localmap__kind" x={input.x + 12} y={input.y + 47}>
              {nodeLabel(input.node.kind, locale)}
            </text>
          </>
        )}
      </g>
    )
  }

  return (
    <div className={'lr-localmap lr-localmap--' + mode}>
      <div className="lr-localmap__head">
        <span className="lr-localmap__head-title">{t('graph.localMapTitle')}</span>
        {modeButton}
      </div>

      {mode === 'whole' ? (
        <>
          <div className="lr-localmap__tools">
            <button
              type="button"
              className="lr-localmap__tool"
              data-tool="out"
              title={t('graph.localMapZoomOut')}
              onClick={() => zoomBy(1 / 1.25)}
            >
              −
            </button>
            <button
              type="button"
              className="lr-localmap__tool"
              data-tool="in"
              title={t('graph.localMapZoomIn')}
              onClick={() => zoomBy(1.25)}
            >
              ＋
            </button>
            <button type="button" className="lr-localmap__tool" data-tool="fit" onClick={fitNow}>
              {t('graph.localMapFit')}
            </button>
            <button type="button" className="lr-localmap__tool" data-tool="locate" onClick={locateNow}>
              {t('graph.localMapLocate')}
            </button>
            <span className="lr-localmap__zoom" data-zoom={zoomPercent}>
              {zoomPercent}%
            </span>
          </div>
          <div
            className="lr-localmap__area"
            ref={areaRef}
            data-zoom={zoomPercent}
            onPointerDown={onPointerDown}
          >
            <svg
              className="lr-localmap__svg"
              width={size.width}
              height={size.height}
              viewBox={'0 0 ' + size.width + ' ' + size.height}
              role="group"
              aria-label={t('graph.localMapTitle')}
            >
              <defs>
                {EDGE_KINDS.map((kind) => (
                  <marker
                    key={kind}
                    id={'lm-arrow-' + kind}
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 8 4 L 0 8 z" fill={EDGE_STYLE[kind].color} />
                  </marker>
                ))}
              </defs>
              <g transform={'translate(' + (viewport?.tx ?? 0) + ',' + (viewport?.ty ?? 0) + ') scale(' + (viewport?.k ?? 1) + ')'}>
                {/* 连线：与全局画布一致（右出左进的三次贝塞尔），描边宽度不随缩放变细 */}
                {edges.map((edge) => {
                  const from = world.get(edge.from)
                  const to = world.get(edge.to)
                  if (!from || !to) return null
                  const x1 = from.x + GRAPH_NODE_WIDTH
                  const y1 = from.y + GRAPH_NODE_HEIGHT / 2
                  const x2 = to.x
                  const y2 = to.y + GRAPH_NODE_HEIGHT / 2
                  const c = Math.max(24, Math.abs(x2 - x1) / 2)
                  const style = EDGE_STYLE[edge.kind]
                  return (
                    <path
                      key={edge.id}
                      className="lr-localmap__link"
                      d={'M ' + x1 + ' ' + y1 + ' C ' + (x1 + c) + ' ' + y1 + ', ' + (x2 - c) + ' ' + y2 + ', ' + x2 + ' ' + y2}
                      vectorEffect="non-scaling-stroke"
                      stroke={style?.color ?? '#8a8a8a'}
                      strokeDasharray={style?.dash ?? undefined}
                      markerEnd={'url(#lm-arrow-' + edge.kind + ')'}
                    />
                  )
                })}
                {nodes.map((node) => {
                  const point = world.get(node.id) ?? { x: 0, y: 0 }
                  return renderCard({
                    node,
                    x: point.x,
                    y: point.y,
                    width: GRAPH_NODE_WIDTH,
                    height: GRAPH_NODE_HEIGHT,
                    focus: node.id === centerId
                  })
                })}
              </g>
            </svg>
          </div>
          <div className="lr-localmap__sub">
            <span>{t('graph.localMapCount', { nodes: nodes.length, edges: edges.length })}</span>
            <span className="lr-localmap__head-hint">{t('graph.localMapHint')}</span>
          </div>
        </>
      ) : (
        <>
          {neighbors ? (
            <div className="lr-localmap__viewport">
              <svg
                className="lr-localmap__svg"
                viewBox={'0 0 ' + neighbors.width + ' ' + neighbors.height}
                preserveAspectRatio="xMidYMid meet"
                width="100%"
                role="group"
                aria-label={t('graph.localMapTitle')}
              >
                <defs>
                  {EDGE_KINDS.map((kind) => (
                    <marker
                      key={kind}
                      id={'lm-narrow-' + kind}
                      viewBox="0 0 8 8"
                      refX="7"
                      refY="4"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 0 L 8 4 L 0 8 z" fill={EDGE_STYLE[kind].color} />
                    </marker>
                  ))}
                </defs>
                {neighbors.links.map((link) => {
                  const style = EDGE_STYLE[link.edge.kind]
                  return (
                    <path
                      key={link.edge.id + '-' + link.direction}
                      className="lr-localmap__link"
                      d={link.d}
                      stroke={style?.color ?? '#8a8a8a'}
                      strokeDasharray={style?.dash ?? undefined}
                      markerEnd={'url(#lm-narrow-' + link.edge.kind + ')'}
                    />
                  )
                })}
                {renderCard({
                  node: neighbors.centerNode,
                  x: neighbors.center.x,
                  y: neighbors.center.y,
                  width: neighbors.center.width,
                  height: neighbors.center.height,
                  focus: true
                })}
                {neighbors.peers.map((peer) =>
                  renderCard({
                    node: peer.node,
                    x: peer.x,
                    y: peer.y,
                    width: peer.width,
                    height: peer.height,
                    focus: false,
                    kindLine:
                      (peer.direction === 'out' ? '→ ' : '← ') +
                      edgeLabel(peer.edge.kind, locale) +
                      (peer.multi > 1 ? ' ×' + peer.multi : ''),
                    kindColor: EDGE_STYLE[peer.edge.kind]?.color
                  })
                )}
              </svg>
            </div>
          ) : null}
          <div className="lr-localmap__sub">
            <span>
              {t('graph.localMapCount', { nodes: (neighbors?.peers.length ?? 0) + 1, edges: neighbors?.links.length ?? 0 })}
              {hiddenNeighbors > 0 ? ' · ' + t('graph.localMapMore', { count: hiddenNeighbors }) : ''}
            </span>
            <span className="lr-localmap__head-hint">{t('graph.localMapHint')}</span>
          </div>
        </>
      )}
    </div>
  )
}
