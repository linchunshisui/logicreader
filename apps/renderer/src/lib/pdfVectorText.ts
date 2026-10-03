/**
 * 矢量文本层（自建，替代 pdf.js 的 TextLayer）
 * ============================================================================
 * 为什么推翻重写：
 *   pdf.js 的 TextLayer 把 span 定位交给"CSS 变量 --scale-factor + 字体 ascent 估算"，
 *   一旦祖先元素没有正确提供这些变量（或字体度量与内嵌字体不一致），
 *   span 就会整体偏移 —— 实测用户截图里标题/摘要的隐藏文本比画面低了约 100px，
 *   于是"选哪一段都定位到别的文字"。这条链路是黑盒，无法自证，只能重写。
 *
 * 新做法（全部来自 PDF 的矢量数据，不依赖任何 DOM/CSS 约定）：
 *   1) 用 page.getViewport({scale:1,rotation:0}) 建立一个**与缩放无关**的页面坐标系；
 *   2) 每个文本项的基线 (transform[4], transform[5]) 与字号 hypot(c,d) 直接来自内容流；
 *   3) 上升高度用 content.styles[font].ascent（真实字体度量），没有才退回 0.88 估算；
 *   4) 渲染时把"基线点"用 viewport.convertToViewportPoint 变换到当前视口（自动含旋转），
 *      再把 span 放在"基线 - ascent"处，横向用 scaleX 把宽度精确校正到矢量宽度；
 *   5) **字符偏移与坐标同源**：同一份布局既产出 itemOffsets/itemLengths，也产出几何，
 *      因此"选中的文字"和"记录的字符区间"不可能再对不上。
 *
 * 不变量（有单测）：
 *   pageText.slice(itemOffsets[i], itemOffsets[i] + itemLengths[i]) ≈ items[i].str（忽略空白折叠）
 */
import type { Rect } from '@logicreader/document-model'

export interface PdfVectorItem {
  /** 在 page.getTextContent().items 中的原始下标 */
  index: number
  str: string
  /** 视口坐标（scale=1, rotation=0）：左边界 */
  x: number
  /** 视口坐标：行顶（= 基线 - ascent），仅用于分组与矩形 */
  y: number
  /** 基线 y（视口坐标） */
  baseline: number
  width: number
  height: number
  fontName: string
  fontSize: number
  /** 字体的上升比例（来自 content.styles） */
  ascent: number
}

export interface PdfVectorLine {
  items: PdfVectorItem[]
  x0: number
  x1: number
  y: number
  baseline: number
  fontSize: number
  fontName: string
}

export interface PdfVectorParagraph {
  lines: PdfVectorLine[]
  text: string
  rects: Rect[]
  fontSize: number
}

export interface PdfPageLayout {
  pageNumber: number
  width: number
  height: number
  blocks: PdfVectorParagraph[]
  pageText: string
  /** 与"有文字的项"同序同长：全局字符偏移 */
  itemOffsets: number[]
  /** 与 itemOffsets 配套：该项在归一化文本里占的字符数 */
  itemLengths: number[]
  /** 原始下标 → 偏移表下标 */
  localIndex: Map<number, number>
}

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/
const isCjk = (ch: string): boolean => ch.length > 0 && CJK.test(ch)
const isSpace = (ch: string): boolean => ch !== undefined && /\s/.test(ch)

/** 忽略空白后比较两段文字是否等价 */
function squash(value: string): string {
  return value.replace(/\s+/g, '')
}

/** 折叠连续空白并去掉结尾空白，同时给出"原始下标 → 归一化下标"的映射 */
function normalizeWhitespace(raw: string): { text: string; map: number[] } {
  let out = ''
  const map = new Array<number>(raw.length)
  let i = 0
  while (i < raw.length) {
    if (isSpace(raw[i])) {
      let j = i
      while (j < raw.length && isSpace(raw[j])) j += 1
      if (j >= raw.length) {
        for (let k = i; k < j; k += 1) map[k] = out.length
        break
      }
      if (out.length > 0) {
        map[i] = out.length
        out += ' '
      } else {
        map[i] = 0
      }
      for (let k = i + 1; k < j; k += 1) map[k] = out.length
      i = j
      continue
    }
    map[i] = out.length
    out += raw[i]
    i += 1
  }
  return { text: out, map }
}

/** 两项之间是否需要补一个空格（依据矢量间距，而不是字符猜测） */
function needsSpaceBetween(prev: PdfVectorItem, next: PdfVectorItem): boolean {
  const prevChar = prev.str.slice(-1)
  const nextChar = next.str.charAt(0)
  if (isCjk(prevChar) || isCjk(nextChar)) return false
  if (/\s$/.test(prev.str) || /^\s/.test(next.str)) return false
  return next.x - (prev.x + prev.width) > prev.fontSize * 0.18
}

function rawJoin(items: PdfVectorItem[]): { raw: string; starts: number[] } {
  let raw = ''
  const starts: number[] = []
  for (let i = 0; i < items.length; i += 1) {
    if (i > 0 && needsSpaceBetween(items[i - 1], items[i])) raw += ' '
    starts.push(raw.length)
    raw += items[i].str
  }
  return { raw, starts }
}

/** 一行文本（含空白折叠与首尾去空白） */
export function joinLineItems(items: PdfVectorItem[]): string {
  return normalizeWhitespace(rawJoin(items).raw).text.trim()
}

/** 该项在归一化文本里占的字符数（纯空白项为 0） */
export function mappedLength(raw: string): number {
  return raw.replace(/\s+/g, ' ').trim().length
}

/** 行分组：视口坐标自上而下（y 递增），行内自左向右 */
export function groupVectorLines(items: PdfVectorItem[]): PdfVectorLine[] {
  const sorted = [...items].sort((a, b) => (Math.abs(a.baseline - b.baseline) > 1.5 ? a.baseline - b.baseline : a.x - b.x))
  const lines: PdfVectorLine[] = []
  let current: PdfVectorItem[] = []
  let currentY = Number.NaN
  const flush = (): void => {
    if (current.length === 0) return
    const ordered = [...current].sort((a, b) => a.x - b.x)
    lines.push({
      items: ordered,
      x0: Math.min(...ordered.map((item) => item.x)),
      x1: Math.max(...ordered.map((item) => item.x + item.width)),
      y: ordered[0].y,
      baseline: ordered[0].baseline,
      fontSize: Math.max(...ordered.map((item) => item.fontSize)),
      fontName: ordered[0].fontName
    })
    current = []
  }
  for (const item of sorted) {
    if (Number.isNaN(currentY)) {
      currentY = item.baseline
      current = [item]
      continue
    }
    if (Math.abs(item.baseline - currentY) <= Math.max(2, item.fontSize * 0.45)) {
      current.push(item)
      currentY = (currentY * (current.length - 1) + item.baseline) / current.length
    } else {
      flush()
      currentY = item.baseline
      current = [item]
    }
  }
  flush()
  return lines
}

/** 段落切分：纯几何判据（大间距 / 换栏 / 标题字号 / 项目符号 / 结句 / 缩进） */
export function splitVectorParagraphs(lines: PdfVectorLine[]): PdfVectorLine[][] {
  const paragraphs: PdfVectorLine[][] = []
  let current: PdfVectorLine[] = []
  let medianFont = 0
  if (lines.length > 0) {
    const sizes = lines.map((line) => line.fontSize).sort((a, b) => a - b)
    medianFont = sizes[Math.floor(sizes.length / 2)]
  }
  const push = (): void => {
    if (current.length > 0) paragraphs.push(current)
    current = []
  }
  lines.forEach((line, index) => {
    if (index === 0) {
      current = [line]
      return
    }
    const prev = lines[index - 1]
    const gap = line.baseline - prev.baseline
    const lineHeight = Math.max(prev.fontSize, line.fontSize)
    const isHeading = line.fontSize > medianFont * 1.12 || /bold|black|heavy/i.test(line.fontName)
    const prevEndsSentence = /[。！？.!?:：；;]$/.test(joinLineItems(prev.items))
    const indent = line.x0 - prev.x0
    const newColumn = line.x0 < prev.x0 - lineHeight * 2 && gap > lineHeight * 0.5
    const bullet = /^[•·▪◦\-*–—]|^\d+[.)、]|^[（(]\d+[）)]/.test(joinLineItems(line.items))
    const bigGap = gap > lineHeight * 1.7
    if (bigGap || newColumn || isHeading || bullet || (prevEndsSentence && gap > lineHeight * 0.9) || indent > lineHeight * 0.8) {
      push()
    }
    current.push(line)
  })
  push()
  return paragraphs
}

/** 行的归一化矩形（原点左上，0..1；供高亮/标注使用） */
export function lineRect(line: PdfVectorLine, pageWidth: number, pageHeight: number): Rect {
  return {
    x: line.x0 / pageWidth,
    width: Math.max(0.001, (line.x1 - line.x0) / pageWidth),
    y: line.y / pageHeight,
    height: Math.max(0.001, (line.fontSize * 1.25) / pageHeight)
  }
}

/** 判断"块文本中从 from 开始的这一小段"是否就是该项原文 */
function matchesItem(blockLine: string, from: number, itemText: string): boolean {
  if (itemText.length === 0) return true
  if (blockLine.startsWith(itemText, from)) return true
  const want = squash(itemText)
  if (want.length === 0) return true
  const got = squash(blockLine.slice(from, from + itemText.length))
  return got === want || (want.startsWith(got) && got.length > 0)
}

/** 由 pdf.js 的文本项构造"视口坐标（scale=1, rotation=0）"下的矢量项 */
export function toVectorItems(
  rawItems: { str?: string; transform: number[]; width: number; height: number; fontName?: string }[],
  pageHeight: number,
  styles: Record<string, { ascent?: number }> = {}
): PdfVectorItem[] {
  const out: PdfVectorItem[] = []
  rawItems.forEach((item, index) => {
    if (typeof item.str !== 'string') return
    const [a, b, c, d, e, f] = item.transform
    const fontSize = Math.hypot(c, d) || Math.abs(d) || Math.abs(a) || 10
    const styleAscent = styles[item.fontName ?? '']?.ascent
    const ascent = Number.isFinite(styleAscent) && (styleAscent as number) > 0 ? (styleAscent as number) : 0.88
    const baseline = pageHeight - f
    out.push({
      index,
      str: item.str,
      x: e,
      y: baseline - fontSize * ascent,
      baseline,
      width: Math.max(0.5, item.width),
      height: item.height || fontSize,
      fontName: item.fontName ?? '',
      fontSize,
      ascent
    })
  })
  return out
}

/**
 * 计算整页布局：块文本 + 每项字符偏移 + 每项几何。
 * @param items 已按 scale=1/rotation=0 转换好的矢量项
 */
export function buildPdfPageLayout(
  pageNumber: number,
  pageWidth: number,
  pageHeight: number,
  items: PdfVectorItem[]
): PdfPageLayout {
  const content = items.filter((item) => item.str.trim().length > 0)
  const localIndex = new Map<number, number>()
  content.forEach((item, index) => localIndex.set(item.index, index))
  const itemOffsets = new Array<number>(content.length).fill(0)
  const itemLengths = new Array<number>(content.length).fill(0)
  const blocks: PdfVectorParagraph[] = []
  if (content.length === 0) {
    return { pageNumber, width: pageWidth, height: pageHeight, blocks, pageText: '', itemOffsets, itemLengths, localIndex }
  }

  const paragraphs = splitVectorParagraphs(groupVectorLines(content))
  let pageCursor = 0
  const place = (rawIndex: number, offset: number, length: number): void => {
    const index = localIndex.get(rawIndex)
    if (index === undefined) return
    itemOffsets[index] = offset
    itemLengths[index] = length
  }

  for (const lines of paragraphs) {
    const texts = lines.map((line) => joinLineItems(line.items)).filter((value) => value.length > 0)
    const text = texts.join('\n')
    if (text.trim().length === 0) continue
    const blockStart = pageCursor
    let lineOffset = blockStart
    for (const line of lines) {
      const lineText = joinLineItems(line.items)
      if (lineText.length === 0) {
        lineOffset += 1
        continue
      }
      const raw = rawJoin(line.items)
      const cleaned = normalizeWhitespace(raw.raw)
      let itemStart = 0
      let lenientStart: number | null = null
      for (let k = 0; k < line.items.length; k += 1) {
        const item = line.items[k]
        const rawStart = Math.min(itemStart, raw.raw.length)
        const mappedTo = cleaned.map[Math.min(rawStart, Math.max(0, cleaned.map.length - 1))]
        const start = Math.max(0, Math.min(cleaned.text.length, mappedTo ?? cleaned.text.length))
        const lenient = lenientStart
        const useLenient = lenient !== null && !matchesItem(lineText, start, item.str)
        const placed = useLenient ? Math.min(lineText.length, lenient as number) : start
        place(item.index, lineOffset + placed, mappedLength(item.str))
        let next = raw.starts[k + 1] ?? rawStart + item.str.length
        if (next <= rawStart) next = rawStart + item.str.length
        lenientStart = Math.min(cleaned.text.length, placed + mappedLength(item.str))
        while (next < raw.raw.length && isSpace(raw.raw[next])) next += 1
        itemStart = next
      }
      lineOffset += lineText.length + 1
    }
    pageCursor = blockStart + text.length + 1
    blocks.push({
      lines,
      text,
      rects: lines.map((line) => lineRect(line, pageWidth, pageHeight)),
      fontSize: Math.max(...lines.map((line) => line.fontSize))
    })
  }

  const pageText = blocks.map((block) => block.text).join('\n')
  return { pageNumber, width: pageWidth, height: pageHeight, blocks, pageText, itemOffsets, itemLengths, localIndex }
}

/** 自校验：偏移表必须能让每个非空项切出自己的原文（忽略空白折叠） */
export function testPdfPageLayout(
  layout: PdfPageLayout,
  items: PdfVectorItem[]
): { checked: number; bad: { index: number; want: string; got: string }[] } {
  const bad: { index: number; want: string; got: string }[] = []
  const content = items.filter((item) => item.str.trim().length > 0)
  let checked = 0
  for (let i = 0; i < content.length && i < layout.itemOffsets.length; i += 1) {
    const text = content[i].str
    const from = layout.itemOffsets[i]
    const length = layout.itemLengths[i] ?? text.length
    const got = layout.pageText.slice(from, from + length)
    checked += 1
    if (got === text || squash(got) === squash(text)) continue
    if (bad.length < 8) bad.push({ index: i, want: text.slice(0, 40), got: got.slice(0, 40) })
    else bad.push({ index: i, want: '', got: '' })
  }
  return { checked, bad }
}

/**
 * 把一个矢量文本项换算成"渲染时该用的 CSS 数值"。
 *
 * 关键点：所有返回值都相对**当前视口**（由 pdf.js 的 viewport 提供），
 * 而字符偏移来自同一份布局 —— 因此"看到的"和"记录的"永远同源。
 */
export interface TextLayerItemStyle {
  /** 相对页面左上角的像素位置（当前缩放） */
  left: number
  top: number
  /** 字号（当前缩放像素） */
  fontSize: number
  /** 目标宽度（当前缩放像素），记录用于横向校正 */
  targetWidth: number
  /** 旋转角（弧度） */
  angle: number
}

/** 位置保留 3 位小数（亚像素精度），避免浮点尾数写进 DOM */
function px(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * 把一个矢量文本项换算成渲染用的 CSS 数值。
 *
 * 用**像素**而不是百分比：文本层容器的尺寸由我们自己在 `PdfPageView` 里按视口显式设定，
 * 百分比要依赖浏览器对"绝对定位元素百分比高度"的解析 —— 这一环出问题时**不报错、只是偏**，
 * 且极难排查（本项目实测踩过）。像素值不经过任何间接层，算出来是多少就写在多少。
 */
export function itemCssStyle(
  item: PdfVectorItem,
  scale: number,
  angle = 0
): TextLayerItemStyle {
  return {
    left: px(item.x * scale),
    top: px(item.y * scale),
    fontSize: Math.max(0.5, px(item.fontSize * scale)),
    targetWidth: Math.max(0.5, px(item.width * scale)),
    angle
  }
}
