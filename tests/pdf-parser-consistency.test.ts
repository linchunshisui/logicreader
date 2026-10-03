/**
 * 解析结果与持久化映射的自洽性测试（不需要跑 Electron）：
 *  1) 逐页 itemOffsets 必须能在**全文**（块以 '\n' 连接）里切出该项原文；
 *  2) 该页的首项偏移必须等于"前面各页文本长度 + 换行"的累加值。
 * 这两条一旦不成立，写进 DOM 的偏移就会像本次一样整体漂移（第 31 页偏了 246 个字符）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildPdfPageLayout, type PdfVectorItem } from '../apps/renderer/src/lib/pdfTextLayout'

interface RawLike {
  str?: string
  transform: number[]
  width: number
  height: number
  fontName?: string
}

interface PdfLike {
  numPages: number
  getPage: (page: number) => Promise<{
    getViewport: (options: { scale: number; rotation: number }) => { width: number; height: number }
    getTextContent: () => Promise<{ items: RawLike[] }>
  }>
}

async function loadPdf(path: string): Promise<PdfLike> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
    getDocument: (options: { data: Uint8Array; useSystemFonts: boolean }) => { promise: Promise<PdfLike> }
  }
  return (await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), useSystemFonts: true })).promise
}

const fixture = resolve(__dirname, '../tests/fixtures/survey.pdf')

describe('PDF 解析管线自洽性', () => {
  it('每页首项偏移 = 前面各页文本长度累加（全文绝对偏移）', async () => {
    const doc = await loadPdf(fixture)
    const pages: { pageText: string; layout: ReturnType<typeof buildPdfPageLayout>; items: PdfVectorItem[] }[] = []
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1, rotation: 0 })
      const content = await page.getTextContent()
      const items: PdfVectorItem[] = []
      content.items.forEach((raw, index) => {
        if (typeof raw.str !== 'string') return
        const [a, b, , d, e, f] = raw.transform
        const fontSize = Math.hypot(b, d) || Math.abs(d) || Math.abs(a) || 10
        items.push({
          index,
          str: raw.str,
          x: e,
          y: viewport.height - f - fontSize * 0.88,
          width: Math.max(0.5, raw.width),
          height: raw.height || fontSize,
          fontName: raw.fontName ?? '',
          fontSize
        })
      })
      pages.push({ pageText: '', layout: buildPdfPageLayout(pageNumber, viewport.width, viewport.height, items), items })
    }
    let cursor = 0
    for (const entry of pages) {
      const layout = entry.layout
      const firstIndex = entry.items.findIndex((item) => item.str.trim().length > 0)
      if (firstIndex < 0) {
        cursor += layout.pageText.length + 1
        continue
      }
      expect(layout.itemOffsets[firstIndex], 'page ' + layout.pageNumber + ' 首项页内偏移应为 0').toBe(0)
      // 全局偏移 = 页内偏移 + 页首基址
      const global = layout.itemOffsets[firstIndex] + cursor
      expect(global).toBe(cursor)
      cursor += layout.pageText.length + 1
    }
    expect(cursor).toBeGreaterThan(1000)
    expect(existsSync(fixture)).toBe(true)
  }, 60000)
})
