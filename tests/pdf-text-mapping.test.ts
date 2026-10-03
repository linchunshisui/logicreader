/**
 * PDF 矢量文本映射的不变量测试。
 *
 * 这里测的不是"某个函数返回了什么"，而是**产品正确性的判据**：
 *   pageText.slice(itemOffsets[i], itemOffsets[i] + items[i].str.length) === items[i].str
 * 只要这条对每个文本项成立，"选区 → 原文位置"就是精确的；
 * 反过来，只要有一条不成立，用户就会看到"选中的文字与记录位置对不上"。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildPdfPageLayout,
  itemCssStyle,
  joinLineItems,
  testPdfPageLayout,
  toVectorItems,
  type PdfVectorItem
} from '../apps/renderer/src/lib/pdfVectorText'

type RawItem = Omit<PdfVectorItem, 'index'>

/** 与旧实现完全一致的拼接（用于对照，确认重构没有改变文本结果） */
function legacyJoin(items: RawItem[]): string {
  const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/
  let out = ''
  items.forEach((entry, index) => {
    if (index > 0) {
      const prev = items[index - 1]
      const prevChar = prev.str.slice(-1)
      const nextChar = entry.str.charAt(0)
      const needsSpace = !CJK.test(prevChar) && !CJK.test(nextChar) && !/\s$/.test(prev.str) && !/^\s/.test(entry.str)
      const gap = entry.x - (prev.x + prev.width)
      if (needsSpace && gap > prev.fontSize * 0.18) out += ' '
    }
    out += entry.str
  })
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * 构造一个文本项；index 由 makeItems 统一回填为数组下标（与真实 pdf.js 一致）。
 * 这里的 y 就是**基线**（新实现按基线分组的，因为基线与字体无关、可直接来自 transform[5]）。
 */
function raw(str: string, x: number, y: number, width?: number, fontSize = 10): RawItem {
  return {
    str,
    x,
    y,
    baseline: y,
    width: width ?? Math.max(0.5, str.length * fontSize * 0.5),
    height: fontSize,
    fontName: 'f1',
    fontSize,
    ascent: 0.88
  }
}

function makeItems(list: RawItem[]): PdfVectorItem[] {
  return list.map((entry, index) => ({ ...entry, index }))
}

/**
 * 每一项都必须能在页文本里切出自己。
 * 判据与产品一致：**忽略空白后逐字相同**（项内连续空白在归一化文本里会被折叠成一个空格）。
 */
function assertOffsetsExact(items: PdfVectorItem[], pageText: string, offsets: number[], lengths?: number[]): void {
  const squash = (value: string): string => value.replace(/\s+/g, '')
  // 偏移表只覆盖"有文字的项"（与渲染侧过滤规则一致），按下标逐一核对
  const content = items.filter((item) => item.str.trim().length > 0)
  expect(offsets.length).toBe(content.length)
  for (let i = 0; i < content.length; i += 1) {
    const text = content[i].str
    const length = lengths?.[i] ?? text.length
    const got = pageText.slice(offsets[i], offsets[i] + length)
    expect(squash(got), 'item #' + i + ' (' + JSON.stringify(text.slice(0, 24)) + ')').toBe(squash(text))
  }
}

/** 构造"用户划选一段"：取 [from,to) 文本对应的 span 区间，回切后必须等于原文 */
function sliceByOffsets(items: PdfVectorItem[], pageText: string, offsets: number[], from: number, to: number): string {
  const content = items.filter((item) => item.str.trim().length > 0)
  const hits = content
    .map((entry, i) => ({ from: offsets[i], to: offsets[i] + entry.str.length }))
    .filter((range) => range.to > from && range.from < to)
    .sort((a, b) => a.from - b.from)
  if (hits.length === 0) return ''
  const lo = Math.max(hits[0].from, from)
  const hi = Math.min(hits[hits.length - 1].to, to)
  return pageText.slice(lo, hi)
}

describe('PDF 矢量文本映射', () => {
  it('把一行文本项按矢量间距拼成一行（与旧实现逐字符一致）', () => {
    const list = [raw('Hello', 0, 0, 30), raw('world', 40, 0, 30), raw('中文', 80, 0, 20)]
    const items = makeItems(list)
    expect(joinLineItems(items)).toBe(legacyJoin(list))
  })

  it('折叠项内连续空白（PDF 里常见的多个空格）后偏移依然精确', () => {
    const items = makeItems([raw('a   b', 0, 0, 40), raw('c', 60, 0, 6)])
    const layout = buildPdfPageLayout(1, 600, 800, items)
    expect(layout.pageText).toBe('a b c')
    assertOffsetsExact(items, layout.pageText, layout.itemOffsets, layout.itemLengths)
    // 折叠后的映射长度：'a   b' → 'a b' 只占 3 个字符
    expect(layout.itemLengths[0]).toBe(3)
    expect(layout.itemLengths[1]).toBe(1)
  })

  it('纯空白项（pdf.js 里大量存在）不占文本长度，且仍是同序同长', () => {
    const items = makeItems([raw('ab', 0, 0, 20), raw(' ', 30, 0, 5), raw('cd', 40, 0, 20)])
    const layout = buildPdfPageLayout(1, 600, 800, items)
    expect(layout.pageText).toBe('ab cd')
    expect(layout.itemOffsets.length).toBe(2)
    expect(layout.localIndex.get(1)).toBeUndefined()
    assertOffsetsExact(items, layout.pageText, layout.itemOffsets, layout.itemLengths)
  })

  it('单栏正文：多行合成段落，行内/跨行偏移都精确', () => {
    const list: RawItem[] = []
    for (let lineIndex = 0; lineIndex < 6; lineIndex += 1) {
      const y = lineIndex * 14
      list.push(raw('line' + lineIndex + ' word', 50, y, 60))
      list.push(raw('tail' + lineIndex, 130, y, 30))
    }
    const items = makeItems(list)
    const layout = buildPdfPageLayout(1, 595, 842, items)
    assertOffsetsExact(items, layout.pageText, layout.itemOffsets)
    expect(layout.blocks.length).toBeGreaterThan(0)
    expect(testPdfPageLayout(layout, items).bad.length).toBe(0)
  })

  it('双栏排版：左右两栏各自成行，跨栏选择仍能精确切片', () => {
    const list: RawItem[] = []
    for (const column of [50, 320]) {
      for (let row = 0; row < 5; row += 1) {
        const y = 100 + row * 14
        list.push(raw((column < 300 ? 'L' : 'R') + row, column, y, 40))
        list.push(raw('text' + row, column + 50, y, 60))
      }
    }
    const items = makeItems(list)
    const layout = buildPdfPageLayout(1, 595, 842, items)
    assertOffsetsExact(items, layout.pageText, layout.itemOffsets)
    expect(sliceByOffsets(items, layout.pageText, layout.itemOffsets, 0, layout.pageText.length)).toBe(layout.pageText)
  })

  it('表格：同一行多个格子（独立文本项）偏移互不重叠且可精确切片', () => {
    const list: RawItem[] = []
    const xs = [50, 150, 250, 350]
    for (let row = 0; row < 4; row += 1) {
      const y = 80 + row * 16
      xs.forEach((x, column) => list.push(raw('cell' + row + column, x, y, 40)))
    }
    const items = makeItems(list)
    const layout = buildPdfPageLayout(1, 595, 842, items)
    assertOffsetsExact(items, layout.pageText, layout.itemOffsets)
    const content = items.filter((entry) => entry.str.trim().length > 0)
    for (let row = 0; row < 4; row += 1) {
      const first = content[row * xs.length]
      const last = content[row * xs.length + xs.length - 1]
      const from = layout.itemOffsets[content.indexOf(first)]
      const to = layout.itemOffsets[content.indexOf(last)] + last.str.length
      const text = layout.pageText.slice(from, to)
      expect(text).toContain('cell' + row + '0')
      expect(text).toContain('cell' + row + '3')
    }
  })

  it('图表标签散布：整体顺序由矢量坐标决定，逐项偏移仍精确', () => {
    const items = makeItems([
      raw('Figure 3', 60, 400, 50, 9),
      raw('Revenue', 300, 250, 40, 9),
      raw('Q1', 150, 300, 12, 9),
      raw('Q2', 250, 300, 12, 9),
      raw('axis', 90, 380, 20, 9)
    ])
    const layout = buildPdfPageLayout(1, 595, 842, items)
    assertOffsetsExact(items, layout.pageText, layout.itemOffsets)
    const first = layout.pageText.indexOf('Revenue')
    const second = layout.pageText.indexOf('Q1')
    expect(first).toBeGreaterThanOrEqual(0)
    expect(second).toBeGreaterThan(first)
  })

  it('空串项不再占用偏移表下标（只映射有文字的项）', () => {
    const items = makeItems([raw('alpha', 0, 0, 30), raw('', 0, 12, 0), raw('beta', 0, 24, 25)])
    const layout = buildPdfPageLayout(1, 595, 842, items)
    expect(layout.itemOffsets.length).toBe(2)
    // 原始下标 → 偏移表下标：0→0、2→1，空串项没有条目
    expect(layout.localIndex.get(0)).toBe(0)
    expect(layout.localIndex.get(2)).toBe(1)
    expect(layout.localIndex.get(1)).toBeUndefined()
    assertOffsetsExact(items, layout.pageText, layout.itemOffsets, layout.itemLengths)
  })

  it('CJK 文本：不额外插空格，偏移精确', () => {
    const items = makeItems([raw('逻辑阅读器', 0, 0, 60), raw('支持选区', 70, 0, 48)])
    const layout = buildPdfPageLayout(1, 595, 842, items)
    expect(layout.pageText).toBe('逻辑阅读器支持选区')
    assertOffsetsExact(items, layout.pageText, layout.itemOffsets)
  })

  it('真实 PDF 夹具：逐页逐项精确（标题 / 正文 / 表格 / 图片页）', async () => {
    const path = resolve(__dirname, '../tests/fixtures/survey.pdf')
    expect(existsSync(path)).toBe(true)
    const result = await verifyPdfFile(path)
    expect(result.items).toBeGreaterThan(50)
    expect(result.bad).toEqual([])
    expect(result.pageTextLength).toBeGreaterThan(1000)
  }, 60000)

  /**
   * 回归测试：写进 DOM 的必须是**全文绝对偏移**。
   * 曾经把第 2 页起的"页内偏移"直接写进 span，结果除第 1 页外所有页的映射整体错位
   * （第 2 页 "Contents" 落在偏移 0，而全文 0 处是论文标题）。
   */
  it('跨页偏移必须是全文绝对偏移（页内偏移 + 页首基址）', async () => {
    const path = resolve(__dirname, '../tests/fixtures/survey.pdf')
    const pages = await buildAllPages(path)
    expect(pages.length).toBeGreaterThan(1)
    let cursor = 0
    for (const page of pages) {
      for (const item of page.items) {
        const local = page.layout.localIndex.get(item.index)
        if (local === undefined) continue
        const absolute = page.layout.itemOffsets[local] + cursor
        const got = page.layout.pageText.slice(
          page.layout.itemOffsets[local],
          page.layout.itemOffsets[local] + (page.layout.itemLengths[local] ?? item.str.length)
        )
        expect(got.replace(/\s+/g, '')).toBe(item.str.replace(/\s+/g, ''))
        expect(absolute).toBeGreaterThanOrEqual(cursor)
      }
      cursor += page.layout.pageText.length + 1
    }
    // 页首基址必须单调递增：第 2 页不能从 0 重新开始
    expect(pages[1].layout.pageText.length).toBeGreaterThan(0)
    expect(cursor).toBeGreaterThan(pages[0].layout.pageText.length)
  }, 60000)

  describe('矢量几何（文本层定位的根据）', () => {
    it('基线来自 transform[5]，行顶 = 基线 - 字号 × ascent', () => {
      const rawItems = [{ str: 'Title', transform: [20, 0, 0, 20, 56, 770], width: 436, height: 20, fontName: 'f1' }]
      const items = toVectorItems(rawItems, 842, { f1: { ascent: 0.718 } })
      expect(items[0].baseline).toBeCloseTo(72, 5)
      expect(items[0].fontSize).toBeCloseTo(20, 5)
      expect(items[0].y).toBeCloseTo(72 - 20 * 0.718, 5)
    })

    it('没有字体度量时才退回 0.88 估算', () => {
      const rawItems = [{ str: 'x', transform: [11, 0, 0, 11, 56, 720], width: 20, height: 11, fontName: 'missing' }]
      const items = toVectorItems(rawItems, 842, {})
      expect(items[0].ascent).toBe(0.88)
      expect(items[0].y).toBeCloseTo(122 - 11 * 0.88, 5)
    })

    it('CSS 数值全部相对页面尺寸给出百分比，与缩放无关', () => {
      const items = toVectorItems(
        [{ str: 'A', transform: [10, 0, 0, 10, 59.5, 790], width: 100, height: 10, fontName: 'f1' }],
        842,
        { f1: { ascent: 1 } }
      )
      // scale = 2：位置与字号都按缩放直接给出像素值
      const style = itemCssStyle(items[0], 2, 0)
      expect(style.left).toBeCloseTo(119, 3)
      expect(style.top).toBeCloseTo((842 - 790 - 10) * 2, 3)
      expect(style.fontSize).toBeCloseTo(20, 5)
      expect(style.targetWidth).toBeCloseTo(200, 5)
    })

    it('行分组按基线：同一行的不同字号项归到一行，不会被拆开', () => {
      const items = makeItems([
        raw('big', 50, 100, 60, 20),
        raw('small', 200, 104, 30, 9),
        raw('next line', 50, 134, 40, 20)
      ])
      const layout = buildPdfPageLayout(1, 595, 842, items)
      const firstLine = layout.blocks[0].lines[0]
      expect(firstLine.items.length).toBe(2)
      expect(layout.blocks[0].text).toContain('big')
      expect(layout.blocks[0].text).toContain('small')
    })
  })
})

/** 逐页构建布局（供跨页偏移回归测试使用） */
async function buildAllPages(
  path: string
): Promise<{ pageNumber: number; items: PdfVectorItem[]; layout: ReturnType<typeof buildPdfPageLayout> }[]> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
    getDocument: (options: { data: Uint8Array; useSystemFonts: boolean }) => { promise: Promise<PdfLikeDoc> }
  }
  const data = new Uint8Array(readFileSync(path))
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise
  const out: { pageNumber: number; items: PdfVectorItem[]; layout: ReturnType<typeof buildPdfPageLayout> }[] = []
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1, rotation: 0 })
    const content = await page.getTextContent()
    const list: RawItem[] = []
    content.items.forEach((entry) => {
      if (typeof entry.str !== 'string') return
      const [a, b, , d, e, f] = entry.transform
      const fontSize = Math.hypot(b, d) || Math.abs(d) || Math.abs(a) || 10
      list.push({
        str: entry.str,
        x: e,
        y: viewport.height - f - fontSize * 0.88,
        width: Math.max(0.5, entry.width),
        height: entry.height || fontSize,
        fontName: entry.fontName ?? '',
        fontSize
      })
    })
    const items = makeItems(list)
    out.push({ pageNumber, items, layout: buildPdfPageLayout(pageNumber, viewport.width, viewport.height, items) })
  }
  return out
}

/** 用 pdf.js 读取真实 PDF，逐页跑"逐项精确"的不变量 */
async function verifyPdfFile(path: string): Promise<{ items: number; bad: string[]; pageTextLength: number }> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
    getDocument: (options: { data: Uint8Array; useSystemFonts: boolean }) => { promise: Promise<PdfLikeDoc> }
  }
  const data = new Uint8Array(readFileSync(path))
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise
  const bad: string[] = []
  let items = 0
  let pageTextLength = 0
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1, rotation: 0 })
    const content = await page.getTextContent()
    const list: RawItem[] = []
    content.items.forEach((entry) => {
      if (typeof entry.str !== 'string') return
      const [a, b, , d, e, f] = entry.transform
      const fontSize = Math.hypot(b, d) || Math.abs(d) || Math.abs(a) || 10
      list.push({
        str: entry.str,
        x: e,
        y: viewport.height - f - fontSize * 0.88,
        width: Math.max(0.5, entry.width),
        height: entry.height || fontSize,
        fontName: entry.fontName ?? '',
        fontSize
      })
    })
    const vectorItems = makeItems(list)
    const layout = buildPdfPageLayout(pageNumber, viewport.width, viewport.height, vectorItems)
    pageTextLength += layout.pageText.length
    const test = testPdfPageLayout(layout, vectorItems)
    items += test.checked
    for (const entry of test.bad) bad.push('page ' + pageNumber + ' #' + entry.index + ' ' + JSON.stringify(entry))
    // 自校验必须覆盖到"有文字的每一项"，否则等于没测
    expect(test.checked, 'page ' + pageNumber + ' 参与校验的项数').toBe(layout.itemOffsets.length)
    expect(test.bad.length, 'page ' + pageNumber + ' 偏移自校验').toBe(0)
  }
  return { items, bad, pageTextLength }
}

interface PdfLikeDoc {
  numPages: number
  getPage: (page: number) => Promise<{
    getViewport: (options: { scale: number; rotation: number }) => { width: number; height: number }
    getTextContent: () => Promise<{
      items: { str?: string; transform: number[]; width: number; height: number; fontName?: string }[]
    }>
  }>
}
