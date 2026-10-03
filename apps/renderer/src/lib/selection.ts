/**
 * 通用「DOM 选区 → 文档字符区间」解析。
 *
 * 所有阅读器（PDF / Markdown / DOCX / 文本）共用这一份实现，原因很简单：
 * 这套逻辑踩过的坑（端点落在换行元素上、在正文之外松手、跨块/跨页选择、
 * 反向拖选）与文档格式无关，各写一遍必然各错一遍。
 *
 * 两条关键判据：
 *  1) **端点回退**：端点可能落在 <br>、空白节点或容器上，此时按方向找最近的
 *     "可定位文本节点"（起点向后、终点向前），而不是整段判空；
 *  2) **以 DOM 里真正被选中的文字为准**：浏览器会把选区终点甩到容器末尾
 *     （在正文之外松手时），因此只有在片段文本 == DOM 选中文字时才使用片段区间，
 *     否则退化为浏览器报告的区间 —— 既不丢选区，也不记录一个远大于可见选区的范围。
 */

export interface SelFragment {
  start: number
  end: number
}

export interface SelectionResolution {
  /** 用户实际选中的文字（取自 DOM，含换行） */
  text: string
  charStart: number
  charEnd: number
  /** 选区在文档文本中的精确片段（按文档顺序；图表标签/多栏混排时不止一段） */
  fragments: SelFragment[]
  /**
   * true  = 片段精确覆盖了选区（可以按片段重建引用文本）
   * false = 端点落在文本层之外，片段是"覆盖选区的最小包围"，仅作定位用
   */
  exact: boolean
}

interface Record_ {
  el: HTMLElement
  from: number
  to: number
}

/** 把一个选区内文本节点的偏移换算成 span 内的字符数 */
function textOffsetWithin(root: HTMLElement, node: Node, offset: number): number {
  if (node === root) {
    let count = 0
    const children = root.childNodes
    for (let i = 0; i < offset && i < children.length; i += 1) count += (children[i].textContent ?? '').length
    return count
  }
  let count = 0
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let current = walker.nextNode()
  while (current) {
    if (current === node) return count + offset
    count += (current.textContent ?? '').length
    current = walker.nextNode()
  }
  return (root.textContent ?? '').length
}

/** 节点所属的"可定位 span"：先看包含关系，再按文档顺序回退到相邻 span */
export function resolveRecord(node: Node, list: Record_[], direction: 'forward' | 'backward'): Record_ | null {
  if (list.length === 0) return null
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  for (const record of list) {
    if (element && record.el.contains(element)) return record
    if (record.el.contains(node)) return record
  }
  const target = element ?? (node.parentElement as Element | null)
  if (!target) return direction === 'forward' ? list[0] : list[list.length - 1]
  if (direction === 'forward') {
    for (const record of list) {
      if (record.el.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) return record
    }
    return list[list.length - 1]
  }
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].el.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_PRECEDING) return list[i]
  }
  return list[0]
}

/**
 * 解析选区。
 * @param container 阅读器的正文容器（判据是"选区是否落在我的正文里"，与鼠标在哪松手无关）
 * @param selector  "可定位 span"的选择器，其元素必须带 data-char-start / data-char-end
 */
export function resolveDomSelection(
  range: Range,
  container: HTMLElement,
  selector: string
): SelectionResolution | null {
  const elements = Array.from(container.querySelectorAll<HTMLElement>(selector))
  const list: Record_[] = []
  for (const element of elements) {
    const from = Number(element.dataset.charStart)
    const to = Number(element.dataset.charEnd ?? from)
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue
    list.push({ el: element, from, to })
  }
  if (list.length === 0) return null

  const domText = range.toString()
  const startNode = range.startContainer
  const endNode = range.endContainer
  if (!container.contains(startNode) && !container.contains(endNode)) return null

  const startRecord = resolveRecord(startNode, list, 'forward')
  const endRecord = resolveRecord(endNode, list, 'backward')
  if (!startRecord || !endRecord) return null

  let startOffset = startRecord.from
  if (startRecord.el.contains(startNode)) startOffset = startRecord.from + textOffsetWithin(startRecord.el, startNode, range.startOffset)
  let endOffset = endRecord.to
  if (endRecord.el.contains(endNode)) endOffset = endRecord.from + textOffsetWithin(endRecord.el, endNode, range.endOffset)

  const forward = startOffset <= endOffset
  const loRecord = forward ? startRecord : endRecord
  const hiRecord = forward ? endRecord : startRecord

  // 文档顺序：以 charStart 排序，保证片段列表与文档顺序一致
  const ordered = [...list].sort((a, b) => (a.from === b.from ? a.to - b.to : a.from - b.from))
  const loIndex = ordered.indexOf(loRecord)
  const hiIndex = ordered.indexOf(hiRecord)
  const fragments: SelFragment[] = []
  if (loIndex >= 0 && hiIndex >= 0) {
    for (let i = Math.min(loIndex, hiIndex); i <= Math.max(loIndex, hiIndex); i += 1) {
      const record = ordered[i]
      let from = record.from
      let to = record.to
      if (record === startRecord) from = Math.max(from, startOffset)
      if (record === endRecord) to = Math.min(to, endOffset)
      if (record === startRecord && record === endRecord) {
        from = Math.max(record.from, Math.min(startOffset, endOffset))
        to = Math.min(record.to, Math.max(startOffset, endOffset))
      }
      if (to > from) fragments.push({ start: from, end: to })
    }
  }
  if (fragments.length === 0) {
    const from = Math.min(startOffset, endOffset)
    const to = Math.max(startOffset, endOffset)
    if (to > from) fragments.push({ start: from, end: to })
  }
  fragments.sort((a, b) => a.start - b.start)

  const charStart = Math.min(...fragments.map((f) => f.start))
  const charEnd = Math.max(...fragments.map((f) => f.end))
  return { text: domText, charStart, charEnd, fragments, exact: true }
}

/** 忽略空白的比对形态 */
function squash(value: string): string {
  return value.replace(/\s+/g, '')
}

/**
 * 用"用户实际选中的文字"去文档文本里定出精确区间。
 *
 * 为什么不能只靠 span 端点：pdf.js / docx-preview 的一个 span 未必等于一个逻辑单元，
 * 端点所在的 span 可能横跨换行或相邻内容，直接取端点会把区间**多算几个字符**
 * （实测：高亮只有 input-，状态栏却记了 8 个字）。
 *
 * 做法：把选中文字折叠空白后，在折叠空白后的文档文本里定位（要求唯一匹配），
 * 再把首尾映射回原始文档下标 —— 与排版、缩放、DOM 结构全都无关。
 */
export function locateSelectedText(
  modelText: string,
  selectedText: string,
  searchFrom = 0
): { charStart: number; charEnd: number; unique: boolean } | null {
  const want = squash(selectedText)
  if (want.length < 2) return null

  // 折叠空白后的文档文本 + 反向映射（折叠下标 → 原文下标）
  let hay = ''
  const back: number[] = []
  for (let i = 0; i < modelText.length; i += 1) {
    const ch = modelText[i]
    if (/\s/.test(ch)) continue
    hay += ch
    back.push(i)
  }
  if (hay.length === 0) return null

  const first = hay.indexOf(want, Math.max(0, Math.min(searchFrom, hay.length)))
  if (first < 0) return null
  const second = hay.indexOf(want, first + 1)
  const from = back[first]
  const to = back[Math.min(hay.length - 1, first + want.length - 1)] + 1
  return { charStart: from, charEnd: to, unique: second < 0 }
}

/**
 * 判定片段区间是否"确实就是用户选中的那段文字"，并给出最终的权威区间。
 *
 * 优先级：
 *  1) **内容对齐**（locateSelectedText）：在文档文本里唯一定位选中文字 —— 最精确，且与排版无关；
 *  2) 片段拼接：端点落在文本层之外时仍能给出"覆盖选区"的区间；
 *  3) 浏览器报告的端点区间：最后的兜底。
 */
export function confirmFragments(
  modelText: string,
  resolution: SelectionResolution
): { charStart: number; charEnd: number; fragments: SelFragment[]; exact: boolean; method: string } {
  const located = locateSelectedText(modelText, resolution.text)
  if (located && located.unique) {
    return {
      charStart: located.charStart,
      charEnd: located.charEnd,
      fragments: [{ start: located.charStart, end: located.charEnd }],
      exact: true,
      method: 'content'
    }
  }

  const want = squash(resolution.text)
  const fromFragments = squash(resolution.fragments.map((f) => modelText.slice(f.start, f.end)).join(''))
  const fragmentsExact = want.length > 0 && fromFragments.startsWith(want)
  if (fragmentsExact) {
    return {
      charStart: resolution.fragments[0].start,
      charEnd: resolution.fragments[resolution.fragments.length - 1].end,
      fragments: resolution.fragments,
      exact: true,
      method: 'fragments'
    }
  }

  return {
    charStart: resolution.charStart,
    charEnd: resolution.charEnd,
    fragments: [{ start: resolution.charStart, end: resolution.charEnd }],
    exact: false,
    method: 'dom-endpoints'
  }
}

/** 选定区间对应的 DOM Range（用于恢复原生选区；跨 span 也能恢复） */
export function rangeForChars(container: HTMLElement, selector: string, charStart: number, charEnd: number): Range | null {
  const elements = Array.from(container.querySelectorAll<HTMLElement>(selector))
  const list: Record_[] = []
  for (const element of elements) {
    const from = Number(element.dataset.charStart)
    const to = Number(element.dataset.charEnd ?? from)
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue
    list.push({ el: element, from, to })
  }
  if (list.length === 0) return null
  const locate = (offset: number, isEnd: boolean): { el: HTMLElement; inSpan: number } | null => {
    for (const record of list) {
      if (offset < record.from) continue
      if (isEnd ? offset <= record.to : offset < record.to) {
        return { el: record.el, inSpan: Math.max(0, Math.min(offset - record.from, (record.el.textContent ?? '').length)) }
      }
    }
    return null
  }
  const from = locate(charStart, false)
  const to = locate(charEnd, true)
  if (!from || !to) return null
  const startNode = from.el.firstChild
  const endNode = to.el.firstChild
  if (!startNode || !endNode) return null
  try {
    const range = document.createRange()
    range.setStart(startNode, Math.min(from.inSpan, startNode.textContent?.length ?? 0))
    range.setEnd(endNode, Math.min(to.inSpan, endNode.textContent?.length ?? 0))
    return range
  } catch {
    return null
  }
}
