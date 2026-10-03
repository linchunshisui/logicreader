/**
 * 阅读器里的"跳转高亮"三个阅读器共用（Markdown / DOCX / 纯文本 / 表格），
 * 免得各写一遍 class 与定时器 —— 也免得三条路径的行为慢慢漂开。
 *
 * 两种高亮：
 *  · `lr-flash`  —— 1.6 秒闪一下（目录、查找、标注列表这类"路过看一眼"的入口）；
 *  · `lr-reveal` —— **常驻**，直到下一次跳转或调用方清空跳转上下文
 *    （关系图跳转用它：用户要求"跳转后高亮维持"）。
 *
 * 无论哪种，都会把实际用的区间写进 `data-reveal-range`：
 * 这样"高亮到底落在哪一段"可以直接被断言，不用去读像素。
 */
import { useEffect, type RefObject } from 'react'
import { useUiStore } from '../state/ui.store'

export interface RevealMarkOptions {
  hold?: boolean
  durationMs?: number
}

/** 清掉容器里所有常驻高亮（换一次跳转、或结束跳转上下文时调用） */
export function clearRevealMarks(container: ParentNode | null | undefined): void {
  if (!container) return
  for (const element of Array.from(container.querySelectorAll<HTMLElement>('.lr-reveal'))) {
    element.classList.remove('lr-reveal')
    element.removeAttribute('data-reveal-range')
  }
}

export function markRange(
  container: ParentNode | null | undefined,
  element: HTMLElement,
  range: { charStart: number; charEnd: number },
  options: RevealMarkOptions = {}
): void {
  clearRevealMarks(container)
  element.dataset.revealRange = range.charStart + '-' + range.charEnd
  if (options.hold) {
    element.classList.add('lr-reveal')
    return
  }
  element.classList.add('lr-flash')
  window.setTimeout(() => element.classList.remove('lr-flash'), options.durationMs ?? 1600)
}

/**
 * 跳转上下文结束时（逻辑链面板被关掉 → `revealRequest` 置空）清掉常驻高亮。
 *
 * PDF 阅读器不在这里处理：它的高亮是页面上的矩形覆盖层，由自己 `setFlashTarget(null)` 清
 * （矩形本身还要求跟着缩放/旋转走，见 PdfPageView 的 `flashRects`）。
 */
export function useClearRevealOnReset(containerRef: RefObject<HTMLElement | null>): void {
  const request = useUiStore((state) => state.revealRequest)
  useEffect(() => {
    if (request) return
    clearRevealMarks(containerRef.current)
  }, [request, containerRef])
}
