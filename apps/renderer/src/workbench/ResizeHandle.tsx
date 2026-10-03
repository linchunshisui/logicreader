import { useCallback, useEffect, useRef, useState } from 'react'

interface Props {
  direction: 'vertical' | 'horizontal'
  /**
   * 拖拽中：`(size) => void`，**传的是从起始点算出的绝对目标尺寸**，不是增量。
   *
   * 为什么不用增量：以前是 `setState(width + delta)` 再回读 `offsetWidth` 累积，
   * 每帧都要"读布局 → 写样式 → 等重排"，读到的还是**上一帧**的值，
   * 于是窗口总慢半拍地追赶鼠标（用户感受就是"一点一点延伸出来"）。
   * 现在起手时记下 `起始坐标 + 起始尺寸`，移动时直接算 `最终尺寸 = 起始尺寸 ± (当前坐标 - 起始坐标)`：
   * 只认鼠标当前在哪，中间丢帧也不会漂移，窗口**直接贴住鼠标**。
   */
  onResize: (size: number) => void
  /** 拖拽结束：把最终尺寸一次性提交进状态（此时才允许重渲染 + 落盘） */
  onResizeEnd?: () => void
  /** 被拖动的面板：拖动时它的尺寸跟着鼠标走 */
  target: () => HTMLElement | null
  /** 尺寸上下限 */
  min: number
  max: number
  /** 双击复位 */
  onDoubleClick?: () => void
  /** 'start' 表示被拖动的面板在分割条之后（例如右侧辅助栏） */
  anchor?: 'start' | 'end'
}

export function ResizeHandle({
  direction,
  onResize,
  onResizeEnd,
  target,
  min,
  max,
  onDoubleClick,
  anchor = 'start'
}: Props): JSX.Element {
  const [dragging, setDragging] = useState(false)
  /** 起手时的指针坐标与面板尺寸：整个拖拽过程都用它算绝对值 */
  const origin = useRef({ pointer: 0, size: 0 })
  const lastSize = useRef(0)
  const frame = useRef(0)
  const latest = useRef(0)

  const measure = (element: HTMLElement): number =>
    direction === 'vertical' ? element.offsetWidth : element.offsetHeight

  const apply = useCallback((size: number) => {
    latest.current = size
    if (frame.current !== 0) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      onResize(latest.current)
    })
  }, [onResize])

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const element = target()
      if (!element) return
      event.preventDefault()
      ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
      origin.current = {
        pointer: direction === 'vertical' ? event.clientX : event.clientY,
        size: measure(element)
      }
      latest.current = origin.current.size
      setDragging(true)
    },
    [direction, target]
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return
      const current = direction === 'vertical' ? event.clientX : event.clientY
      // anchor === 'end'：面板在分割条右边/下边，指针左移/上移是"变大"
      const growth = anchor === 'end' ? origin.current.pointer - current : current - origin.current.pointer
      apply(Math.min(max, Math.max(min, Math.round(origin.current.size + growth))))
    },
    [dragging, direction, anchor, min, max, apply]
  )

  const stop = useCallback(() => {
    if (frame.current !== 0) {
      cancelAnimationFrame(frame.current)
      frame.current = 0
      onResize(latest.current)
    }
    lastSize.current = latest.current
    setDragging(false)
    onResizeEnd?.()
  }, [onResize, onResizeEnd])

  useEffect(() => {
    if (!dragging) return
    const root = document.documentElement
    root.style.setProperty('--lr-resizer-active', 'var(--vscode-focusBorder)')
    const prev = document.body.style.cursor
    document.body.style.cursor = direction === 'vertical' ? 'col-resize' : 'row-resize'
    return () => {
      root.style.removeProperty('--lr-resizer-active')
      document.body.style.cursor = prev
    }
  }, [dragging, direction])

  return (
    <div
      className={'lr-resizer lr-resizer--' + direction}
      data-dragging={dragging}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={onDoubleClick}
      role="separator"
      aria-orientation={direction === 'vertical' ? 'vertical' : 'horizontal'}
    />
  )
}
