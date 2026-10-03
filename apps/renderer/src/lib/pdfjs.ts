/** pdf.js 初始化与文档缓存（渲染进程，Web Worker 内解析）。 */
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

let configured = false

export function ensurePdfWorker(): typeof pdfjsLib {
  if (!configured) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl
    configured = true
  }
  return pdfjsLib
}

export { pdfjsLib }
export type { PDFDocumentProxy }

interface CacheEntry {
  doc: PDFDocumentProxy
  refs: number
}

const cache = new Map<string, CacheEntry>()

export async function loadPdfDocument(docHash: string, load: () => Promise<Uint8Array>): Promise<PDFDocumentProxy> {
  ensurePdfWorker()
  const existing = cache.get(docHash)
  if (existing) {
    existing.refs += 1
    return existing.doc
  }
  const data = await load()
  const task = pdfjsLib.getDocument({
    data,
    disableFontFace: false,
    useSystemFonts: true
  })
  const doc = await task.promise
  cache.set(docHash, { doc, refs: 1 })
  return doc
}

export function releasePdfDocument(docHash: string): void {
  const entry = cache.get(docHash)
  if (!entry) return
  entry.refs -= 1
  if (entry.refs <= 0) {
    cache.delete(docHash)
    const disposable = entry.doc as unknown as { destroy?: () => Promise<void> }
    void disposable.destroy?.()
  }
}

export function isPdfCached(docHash: string): boolean {
  return cache.has(docHash)
}

export interface PdfTextItemLayout {
  /** 文本层 span 对应的原文 */
  str: string
  /** 归一化矩形（相对页面宽高，原点左上） */
  rect: { x: number; y: number; width: number; height: number }
  /** 在块内的字符偏移 */
  offsetInBlock: number
  blockId: string
  /**
   * 该文本项首字符在**归一化全文**中的全局偏移。
   * 直接写进文本层 span 的 data 属性，使"选区 → 原文位置"不再依赖块 id 查找
   * （块 id 会随着重新解析而变化，是此前选区失效的根因之一）。
   */
  globalStart: number
}

export interface PdfPageLayout {
  pageNumber: number
  width: number
  height: number
  items: PdfTextItemLayout[]
}

export interface PdfDocLayout {
  docId: string
  pages: Map<number, PdfPageLayout>
  /** 页面尺寸（未旋转，scale = 1） */
  pageSizes: { width: number; height: number }[]
}

const layoutCache = new Map<string, PdfDocLayout>()

export function putPdfLayout(docId: string, layout: PdfDocLayout): void {
  layoutCache.set(docId, layout)
}

export function getPdfLayout(docId: string): PdfDocLayout | null {
  return layoutCache.get(docId) ?? null
}

export function dropPdfLayout(docId: string): void {
  layoutCache.delete(docId)
}

/** 解析 pdf.js 的 dest 为页码（1 基）。 */
export async function resolveDestPage(doc: PDFDocumentProxy, dest: string | unknown[] | null): Promise<number | null> {
  if (!dest) return null
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest
    if (!Array.isArray(explicit) || explicit.length === 0) return null
    const ref = explicit[0]
    if (ref == null) return null
    if (typeof ref === 'number') return ref + 1
    const index = await doc.getPageIndex(ref as never)
    return index + 1
  } catch {
    return null
  }
}

export type PdfOutlineItem = {
  title: string
  dest: string | unknown[] | null
  items: PdfOutlineItem[]
  page: number | null
  bold?: boolean
  italic?: boolean
}
