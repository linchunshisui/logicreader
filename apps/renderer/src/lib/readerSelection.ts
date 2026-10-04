/**
 * 「可定位元素」对齐与阅读器通用选区处理。
 *
 * 背景：PDF 之外还有 Word / Markdown / 纯文本三种阅读器，它们的 DOM 与文档模型
 * 之间同样需要"这段文字在全文里的第几个字符"的映射。三处各写一套必然各错一套，
 * 所以统一到这里：
 *
 *  1) alignElementsToText：把渲染出来的元素按"文档顺序 + 内容定位"对齐到 model.text。
 *     判据是**内容**（忽略空白后逐字相同），不是 DOM 结构，所以换排版、换缩放都不受影响；
 *     找不到就跳过并在日志里报数量，绝不猜一个偏移量填进去。
 *  2) useReaderSelection：把 DOM 选区解析成文档字符区间并写进 uiStore，
 *     监听挂在 document 上（鼠标常在正文之外松开），带 selectionchange 兜底与幂等保护。
 */
import { useEffect, type RefObject } from 'react'
import type { DocumentModel } from '@logicreader/document-model'
import { useUiStore } from '../state/ui.store'
import { confirmFragments, locateSelectedText, resolveDomSelection } from './selection'

export interface AlignResult {
  /** 成功建立映射的元素数 */
  aligned: number
  /** 有文字但没能对齐的元素数（>0 时应当报日志） */
  failed: number
}

/** 元素文本的比对形态：折叠空白 + 去首尾 */
function squash(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * 选区的视口联合矩形（跨行选区取"包住所有片段"的那一个）。
 * 取不到（全部片段宽高为 0 之类）时返回 null，工具条退回底部定位。
 */
export function selectionRectOf(range: Range): { x: number; y: number; width: number; height: number } | null {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0)
  if (rects.length === 0) return null
  let left = Number.MAX_SAFE_INTEGER
  let top = Number.MAX_SAFE_INTEGER
  let right = 0
  let bottom = 0
  for (const rect of rects) {
    left = Math.min(left, rect.left)
    top = Math.min(top, rect.top)
    right = Math.max(right, rect.right)
    bottom = Math.max(bottom, rect.bottom)
  }
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * 把渲染出的元素对齐到文档模型的字符偏移，并写入 data-char-start / data-char-end。
 *
 * @param elements 必须是**文档顺序**的元素列表（通常是 querySelectorAll 的结果）
 * @param options.withinBlockOnly 只对齐"落在同一个块内"的元素（内容更精确，用于 DOCX 段落）
 */
export function alignElementsToText(
  model: DocumentModel,
  elements: HTMLElement[],
  options: { minLength?: number } = {}
): AlignResult {
  const minLength = options.minLength ?? 2
  const haystack = squash(model.text)
  /** haystack 下标 → model.text 下标 */
  const back = new Array<number>(haystack.length)
  {
    let cursor = 0
    let pending = -1
    for (let i = 0; i < model.text.length; i += 1) {
      const ch = model.text[i]
      if (/\s/.test(ch)) {
        if (pending < 0) pending = i
        continue
      }
      if (pending >= 0 && cursor > 0) {
        back[cursor] = pending
        cursor += 1
      }
      pending = -1
      back[cursor] = i
      cursor += 1
    }
  }

  let aligned = 0
  let failed = 0
  let searchFrom = 0
  for (const element of elements) {
    const raw = element.textContent ?? ''
    const needle = squash(raw)
    if (needle.length < minLength) continue
    let index = haystack.indexOf(needle, searchFrom)
    if (index < 0) index = haystack.indexOf(needle.slice(0, 40))
    if (index < 0 || index >= back.length) {
      failed += 1
      continue
    }
    const from = back[index]
    const lastHay = Math.min(haystack.length - 1, index + needle.length - 1)
    const to = (back[lastHay] ?? model.text.length - 1) + 1
    element.dataset.charStart = String(from)
    element.dataset.charEnd = String(Math.max(from + 1, to))
    /**
     * 同时记下"该元素在折叠空白后的全文里"的位置：
     * 选区终点定位时用它作为搜索起点，避免同一句话在文档里出现多次时定位到第一处。
     */
    element.dataset.hayIndex = String(index)
    aligned += 1
    searchFrom = index + 1
  }
  return { aligned, failed }
}

export interface ReaderSelectionOptions {
  /** 正文容器（判据是"选区是否落在我的正文里"，与鼠标在哪松手无关） */
  containerRef: RefObject<HTMLElement | null>
  /** 可定位元素的选择器，元素必须带 data-char-start / data-char-end */
  selector: string
  model: DocumentModel
  tabId: string
  /** 位置描述（如"第 3 页"/"第 5 段"/>） */
  label: (charStart: number, charEnd: number) => string
  /** 选区片段无法自证时也接受（PDF 之外没有 rects，默认允许） */
  enabled?: boolean
}

/**
 * 阅读器通用选区处理。
 * 关键点（每一条都对应一次真实故障）：
 *  - 监听挂 document：拖到侧栏/面板/窗口边缘松手时 mouseup 不会到达正文容器；
 *  - selectionchange 兜底 + 150ms 去抖：在窗口之外松手时 mouseup 根本不来；
 *  - 幂等：与已存选区相同时直接返回，避免"恢复选区 → selectionchange → 再写状态"的循环。
 */
export function useReaderSelection(options: ReaderSelectionOptions): void {
  const { containerRef, selector, model, tabId, label, enabled = true } = options
  const setSelection = useUiStore((state) => state.setSelection)

  useEffect(() => {
    if (!enabled) return

    const apply = (target: Node | null): void => {
      const container = containerRef.current
      if (!container) return
      const native = window.getSelection()
      if (!native || native.rangeCount === 0 || native.isCollapsed) {
        // 点在正文内 = 主动取消；点在工具条/侧栏则保留已有选区
        if (target && container.contains(target)) setSelection(null)
        return
      }
      const range = native.getRangeAt(0)
      const resolution = resolveDomSelection(range, container, selector)
      if (!resolution) return
      if (resolution.text.trim().length === 0) return
      /**
       * 搜索起点：取自起止元素上的 data-hay-index（"该元素在忽略空白的全文里"的位置）。
       * 这样"同一句话在文档里出现多次"时不会定位到第一处。
       */
      const startElement =
        range.startContainer instanceof HTMLElement ? range.startContainer : range.startContainer.parentElement
      const record = startElement?.closest<HTMLElement>('[data-hay-index]')
      const from = Number(record?.dataset.hayIndex ?? 0)
      const located = locateSelectedText(model.text, resolution.text, Number.isFinite(from) ? from : 0)
      const confirmed = located?.unique
        ? {
            charStart: located.charStart,
            charEnd: located.charEnd,
            fragments: [{ start: located.charStart, end: located.charEnd }],
            exact: true,
            method: 'content'
          }
        : confirmFragments(model.text, resolution)
      const existing = useUiStore.getState().selection
      if (
        existing &&
        existing.docId === model.docId &&
        existing.charStart === confirmed.charStart &&
        existing.charEnd === confirmed.charEnd
      ) {
        return
      }
      setSelection({
        docId: model.docId,
        tabId,
        text: resolution.text,
        charStart: confirmed.charStart,
        charEnd: confirmed.charEnd,
        anchorId: null,
        locationLabel: label(confirmed.charStart, confirmed.charEnd),
        // 选区的视口位置（联合矩形）：浮动工具条据此把按钮摆在选区旁边，而不是趴在视口底部
        rect: selectionRectOf(range)
      })
    }

    const onMouseUp = (event: MouseEvent): void => apply(event.target as Node | null)
    let timer: number | null = null
    const onSelectionChange = (): void => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        apply(null)
      }, 150)
    }
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('selectionchange', onSelectionChange)
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [containerRef, selector, model, tabId, label, enabled, setSelection])
}
