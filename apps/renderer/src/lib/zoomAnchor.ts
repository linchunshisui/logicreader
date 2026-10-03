/**
 * 缩放锚点：**跳转高亮的文段 / 用户选中的文段**在缩放前后都留在视口中间，
 * 文段比视口高时对齐到顶部留边 —— 保证"开头一定看得见"。
 *
 * 为什么必须有它：缩放改的是页面与字号的**尺寸**，而滚动位置是 px。
 * 不重新对齐，缩放后原来那一段就漂出视口（PDF 从关系图跳转后最明显：
 * 放大 1.5 倍就能把落点推出半屏，用户以为"跳转丢了"）。
 *
 * 谁在用：PDF / Markdown / DOCX / 纯文本四个带缩放的阅读器（表格没有缩放，不接）。
 *
 * 锚点优先级：**跳转高亮 > 用户选区**。跳转高亮代表用户刚显式要求"看这一段"，
 * 而 store 里的选区可能是跳转之前留下的旧选择 —— 先看高亮才不会在跳转后缩放时跑偏。
 */
import { useLayoutEffect, useRef, type RefObject } from 'react'
import type { DocumentModel } from '@logicreader/document-model'
import { useUiStore } from '../state/ui.store'

export interface AnchorRange {
  charStart: number
  charEnd: number
}

/**
 * 让 rect 落到视口里的目标 `scrollTop`（纯函数，可单测）。
 *
 * 规则：能整段装下就居中；装不下（文段比视口还高）就**把开头对齐到顶部留边** ——
 * 后者是"开头可视"的保证：宁可看不到文段结尾，也不能让开头滑到视口外。
 */
export function centerScrollTop(
  scrollTop: number,
  rect: { top: number; height: number },
  host: { top: number; height: number },
  margin = 12
): number {
  const usable = Math.max(0, host.height - margin * 2)
  const height = Math.max(0, Math.min(rect.height, usable))
  const desiredTop = Math.max(margin, (host.height - height) / 2)
  return Math.max(0, scrollTop + (rect.top - host.top) - desiredTop)
}

/**
 * 锚点文段所在的元素：先按"起点字符偏移"精确取，退化到"起点所在的块"。
 * 各阅读器的可定位元素都带 `data-char-start` / `data-block-id`（见 lib/readerSelection）。
 */
export function anchorElementFor(
  container: ParentNode,
  model: DocumentModel,
  charStart: number
): HTMLElement | null {
  const exact = container.querySelector<HTMLElement>('[data-char-start="' + charStart + '"]')
  if (exact) return exact
  const block = model.blocks.find((item) => item.charStart <= charStart && item.charEnd >= charStart)
  return block ? container.querySelector<HTMLElement>('[data-block-id="' + block.id + '"]') : null
}

export interface ZoomAnchorOptions {
  /** 滚动容器（`.lr-scroll` / `.lr-pdf-scroll`） */
  containerRef: RefObject<HTMLElement | null>
  docId: string
  /** 布局量：缩放倍率（PDF 再带上旋转）。**值变了才重新对齐**，所以挂载时不滚 */
  layoutKey: string
  /** 量出"锚点开头"的矩形；拿不到返回 null（会重试） */
  resolveRect: (anchor: AnchorRange) => DOMRect | null
  /** 新布局是否已经就绪；省略 = 一直就绪。PDF 的文本层是异步重建的，靠它等一下 */
  ready?: (anchor: AnchorRange) => boolean
}

export function useZoomAnchor(options: ZoomAnchorOptions): void {
  const request = useUiStore((state) => state.revealRequest)
  const selection = useUiStore((state) => state.selection)
  const anchor: AnchorRange | null =
    request && request.docId === options.docId
      ? { charStart: request.charStart, charEnd: request.charEnd }
      : selection && selection.docId === options.docId
        ? { charStart: selection.charStart, charEnd: selection.charEnd }
        : null
  const anchorStart = anchor?.charStart ?? null
  const anchorEnd = anchor?.charEnd ?? null

  /** 回调放 ref：父组件每次渲染都会换新的函数对象，放进依赖会反复触发对齐 */
  const optionsRef = useRef(options)
  optionsRef.current = options
  const previousLayout = useRef(options.layoutKey)

  useLayoutEffect(() => {
    const current = optionsRef.current
    if (previousLayout.current === current.layoutKey) return
    previousLayout.current = current.layoutKey
    if (anchorStart === null || anchorEnd === null) return
    const target: AnchorRange = { charStart: anchorStart, charEnd: anchorEnd }
    let cancelled = false
    let attempt = 0

    /** 拿不到矩形（新布局还没重建完）就按 60ms 重试，最多约 2.4 秒 */
    const retry = (): void => {
      attempt += 1
      if (attempt <= 40) window.setTimeout(align, 60)
    }

    const align = (): void => {
      if (cancelled) return
      const live = optionsRef.current
      const container = live.containerRef.current
      if (!container) return
      if (live.ready && !live.ready(target)) return retry()
      const rect = live.resolveRect(target)
      if (!rect) return retry()
      const max = Math.max(0, container.scrollHeight - container.clientHeight)
      const next = centerScrollTop(container.scrollTop, rect, container.getBoundingClientRect())
      container.scrollTop = Math.min(max, next)
    }

    align()
    return () => {
      cancelled = true
    }
  }, [options.layoutKey, anchorStart, anchorEnd])
}
