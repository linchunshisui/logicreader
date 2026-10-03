/** 块序列工具：偏移表、目录树、按偏移反查。 */
import type { Block, DocumentModel, Locator, OutlineNode } from './types'
import { createId } from '@logicreader/shared'

/** 用 '\n' 连接所有块文本，回填 charStart/charEnd，返回归一化全文。 */
export function linkBlocks(blocks: Block[], separator = '\n'): { blocks: Block[]; text: string } {
  let cursor = 0
  const out: Block[] = []
  const parts: string[] = []
  blocks.forEach((b, index) => {
    if (index > 0) {
      parts.push(separator)
      cursor += separator.length
    }
    const text = b.text ?? ''
    const start = cursor
    cursor += text.length
    parts.push(text)
    out.push({ ...b, seq: index, charStart: start, charEnd: cursor })
  })
  return { blocks: out, text: parts.join('') }
}

/** 由 heading 块构建层级目录树。 */
export function buildOutlineFromBlocks(blocks: Block[]): OutlineNode[] {
  const roots: OutlineNode[] = []
  const stack: OutlineNode[] = []
  for (const b of blocks) {
    if (b.kind !== 'heading') continue
    const level = b.level ?? 1
    const node: OutlineNode = {
      id: b.id || createId('outline'),
      title: b.text,
      level,
      blockId: b.id,
      charStart: b.charStart,
      locator: b.locator,
      children: []
    }
    while (stack.length > 0 && (stack[stack.length - 1].level ?? 1) >= level) stack.pop()
    if (stack.length === 0) roots.push(node)
    else stack[stack.length - 1].children.push(node)
    stack.push(node)
  }
  return roots
}

/** 展平目录树。 */
export function flattenOutline(nodes: OutlineNode[]): OutlineNode[] {
  const out: OutlineNode[] = []
  const walk = (list: OutlineNode[]): void => {
    for (const n of list) {
      out.push(n)
      walk(n.children)
    }
  }
  walk(nodes)
  return out
}

/** 找到包含指定字符偏移的块下标（二分）。 */
export function blockIndexAtChar(blocks: Block[], offset: number): number {
  let lo = 0
  let hi = blocks.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const b = blocks[mid]
    if (offset < b.charStart) hi = mid - 1
    else if (offset > b.charEnd) lo = mid + 1
    else {
      ans = mid
      break
    }
  }
  if (ans >= 0) return ans
  // 落在块之间的分隔符上：取前一个块
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].charStart <= offset) return i
  }
  return 0
}

/** 覆盖 [charStart, charEnd) 的块下标区间。 */
export function blockRangeForChars(blocks: Block[], charStart: number, charEnd: number): [number, number] {
  const start = blockIndexAtChar(blocks, charStart)
  const end = blockIndexAtChar(blocks, Math.max(charStart, charEnd - 1))
  return [Math.min(start, end), Math.max(start, end)]
}

/**
 * 把"指向某个字符区间"的定位范围收拾成人能看懂的一段。
 *
 * 起因：关系图抽出来的锚点区间常常**从半个单词开始/结束**（"redu|ced"），
 * 高亮出来就是"圈了半个词"，看的人不知道它到底指哪一段。
 *
 * 规则：
 *  1. **不让边界落在词中间** —— 只在**拉丁词**（字母/数字/下划线）内部时向外补到词边界；
 *     中文没有词间空格，按同一规则扩会一路吃掉整段，所以对中文不动边界。
 *  2. **不吃两头的空白** —— 高亮一片空白同样没有信息量。
 *
 * 这是"显示层"的收拾：**不改锚点本身**（区间语义不变、引用文本仍以 `quote` 为准），
 * 只让高亮看起来是一次有意的选择。区间塌缩（start ≥ end）时取所在的那个词，
 * 不会返回一个空高亮 —— 空高亮等于没跳。
 */
export function expandRevealRange(
  text: string,
  charStart: number,
  charEnd: number
): { charStart: number; charEnd: number } {
  const length = text.length
  let start = Math.max(0, Math.min(charStart, length))
  let end = Math.max(start, Math.min(charEnd, length))
  const isWord = (ch: string | undefined): boolean => ch !== undefined && /[0-9A-Za-z_]/.test(ch)
  while (start > 0 && isWord(text[start]) && isWord(text[start - 1])) start -= 1
  while (end < length && isWord(text[end - 1]) && isWord(text[end])) end += 1
  while (start < end && /\s/.test(text[start])) start += 1
  while (end > start && /\s/.test(text[end - 1])) end -= 1
  return { charStart: start, charEnd: end }
}

export function locatorKey(locator: Locator): string {
  return JSON.stringify(locator)
}

/** 人类可读的位置描述，用于状态栏、位置选择器与提示词位置头。 */
export function describeLocator(locator: Locator, options: { pageCount?: number | null; locale?: string } = {}): string {
  const zh = (options.locale ?? 'zh-CN').startsWith('zh')
  switch (locator.kind) {
    case 'pdf':
      return zh ? `第 ${locator.page} 页` : `Page ${locator.page}`
    case 'slide':
      return zh ? `第 ${locator.slide} 张幻灯片` : `Slide ${locator.slide}`
    case 'text':
      return zh ? `第 ${locator.line} 行` : `Line ${locator.line}`
    case 'docx':
      return zh ? `第 ${locator.paraIndex + 1} 段` : `Paragraph ${locator.paraIndex + 1}`
    case 'sheet':
      return `${locator.sheet}!${locator.range}`
    default:
      return ''
  }
}

/** 该字符偏移所在页码（PDF / 幻灯片），无法判断时返回 null。 */
export function pageForChar(blocks: Block[], offset: number): number | null {
  const idx = blockIndexAtChar(blocks, offset)
  for (let i = idx; i >= 0; i -= 1) {
    const loc = blocks[i].locator
    if (loc.kind === 'pdf') return loc.page
    if (loc.kind === 'slide') return loc.slide
  }
  return null
}

/** 该字符偏移所在的最近标题路径，如 ['3 方法', '3.2 注意力机制']。 */
export function headingPathFor(blocks: Block[], outline: OutlineNode[], offset: number): string[] {
  const flat = flattenOutline(outline).filter((n) => n.charStart <= offset)
  if (flat.length === 0) return []
  const path: string[] = []
  let level = 0
  for (const n of flat) {
    if (n.level > level) {
      path.push(n.title)
      level = n.level
    } else {
      while (path.length >= n.level) path.pop()
      path.push(n.title)
      level = n.level
    }
  }
  return path
}

/** 为文档模型补齐派生字段（偏移表、目录、页数）。 */
export function finalizeDocumentModel(model: DocumentModel): DocumentModel {
  const { blocks, text } = linkBlocks(model.blocks)
  const outline = model.outline.length > 0 ? model.outline : buildOutlineFromBlocks(blocks)
  let pageCount = model.pageCount
  if (pageCount == null) {
    let maxPage = 0
    for (const b of blocks) {
      if (b.locator.kind === 'pdf') maxPage = Math.max(maxPage, b.locator.page)
      if (b.locator.kind === 'slide') maxPage = Math.max(maxPage, b.locator.slide)
    }
    pageCount = maxPage > 0 ? maxPage : null
  }
  return { ...model, blocks, text, outline, pageCount }
}
