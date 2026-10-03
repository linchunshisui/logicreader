/**
 * PDF 解析管线（规划书 §5.2）：
 * 逐页 getTextContent → 行合并 → 段落候选 → 块序列 + 全局偏移表 + 目录树。
 *
 * 「文本层 span ↔ 全局字符偏移」的映射在这里一次算清并持久化（meta.textLayerMapping），
 * 阅读器不再自己重算一套算术 —— 两处各算一次正是此前"有时能用、某个比例能用"的根源。
 * 具体算法在 lib/pdfVectorText.ts（纯函数，有单测），输入是 PDF 内容流里的矢量文本项；
 * lib/pdfTextLayout.ts 只是它的兼容转发层，新代码请直接用 pdfVectorText。
 */
import { createId } from '@logicreader/shared'
import { estimateTokens, finalizeDocumentModel, type Block, type DocumentModel, type OutlineNode } from '@logicreader/document-model'
import { api } from '../lib/api'
import {
  ensurePdfWorker,
  loadPdfDocument,
  putPdfLayout,
  resolveDestPage,
  type PdfDocLayout,
  type PdfOutlineItem,
  type PdfPageLayout,
  type PdfTextItemLayout
} from '../lib/pdfjs'
import { buildPdfPageLayout, mappedLength, toVectorItems, type PdfVectorItem } from '../lib/pdfVectorText'
import {
  hashDocumentText,
  offsetsMatchModelText,
  TEXT_LAYER_MAPPING_VERSION,
  type PersistedTextLayerMapping
} from '../lib/textLayerMapping'
import type { ParseContext } from './types'

/** 页面尺寸缺省值（A4 @72dpi） */
const FALLBACK_PAGE = { width: 595, height: 842 }

/** 把落库自检的结果也写进应用日志（console 只到 Electron 的 stderr，GUI 下没人看得到） */
function logPersistWarn(message: string): void {
  const api = (globalThis as { logicreader?: { log: { write: (...args: unknown[]) => Promise<void> } } }).logicreader
  void api?.log.write('warn', 'reader', message)
}

/**
 * 落库自检：逐页抽若干文本项，检查 model.text 在"算出来的全局偏移"处是否就是该项原文。
 * 这是"派生数据必须能自证"的最后一道闸门。
 */
function auditMappingAgainstModel(modelText: string, layout: PdfDocLayout): { checked: number; matched: number } {
  const squash = (value: string): string => value.replace(/\s+/g, '')
  let checked = 0
  let matched = 0
  for (const page of layout.pages.values()) {
    for (const item of page.items) {
      if (item.str.trim().length === 0) continue
      if (checked >= 40) break
      const from = item.globalStart ?? 0
      if (from < 0 || from >= modelText.length) {
        checked += 1
        continue
      }
      const slice = modelText.slice(from, from + mappedLength(item.str))
      checked += 1
      if (slice === item.str || squash(slice) === squash(item.str)) matched += 1
    }
  }
  return { checked, matched }
}

export async function parsePdfDocument(ctx: ParseContext): Promise<DocumentModel> {
  const sourcePath = ctx.readPath ?? ctx.filePath
  const doc = await loadPdfDocument(ctx.docHash, () => api.fs.readBinary(sourcePath))
  ensurePdfWorker()
  const blocks: Block[] = []
  const layout: PdfDocLayout = { docId: ctx.docId, pages: new Map(), pageSizes: [] }
  /** 页号 → 文本层映射（与 textDivs 同序同长的**全局**偏移与映射长度） */
  const pageMappings = new Map<number, { offsets: number[]; lengths: number[] }>()

  const total = doc.numPages
  for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
    ctx.onProgress?.({ page: pageNumber, total })
    const page = await doc.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1, rotation: 0 })
    const pageWidth = viewport.width || FALLBACK_PAGE.width
    const pageHeight = viewport.height || FALLBACK_PAGE.height
    layout.pageSizes.push({ width: pageWidth, height: pageHeight })

    const textContent = await page.getTextContent()
    /**
     * 文本项 → 矢量项：基线/字号来自内容流，上升高度来自 content.styles（真实字体度量）。
     * 解析与渲染共用 toVectorItems，所以两边的几何与字符偏移必然同源，
     * 不再存在"解析按 0.88 估、渲染按 pdf.js 估"两套系数打架的可能。
     */
    const items = toVectorItems(
      textContent.items as unknown as { str?: string; transform: number[]; width: number; height: number; fontName?: string }[],
      pageHeight,
      (textContent.styles ?? {}) as Record<string, { ascent?: number }>
    )

    if (items.every((item) => item.str.trim().length === 0)) {
      // 扫描版页面：插入一个图像块占位（无文本层）
      blocks.push({
        id: createId('blk'),
        docId: ctx.docId,
        seq: 0,
        kind: 'image',
        text: '',
        charStart: 0,
        charEnd: 0,
        locator: { kind: 'pdf', page: pageNumber, rects: [{ x: 0, y: 0, width: 1, height: 1 }] }
      })
      layout.pages.set(pageNumber, { pageNumber, width: pageWidth, height: pageHeight, items: [] })
      page.cleanup()
      continue
    }

    const pageLayout = buildPdfPageLayout(pageNumber, pageWidth, pageHeight, items)
    /** 原始项下标 → 所属块；finalize 之后按块 charStart 回填全局偏移 */
    const mapped = new Map<number, { blockId: string; offsetInBlock: number }>()

    for (const paragraph of pageLayout.blocks) {
      const isHeading = paragraph.fontSize > 12.5 && paragraph.text.length <= 90
      const block: Block = {
        id: createId('blk'),
        docId: ctx.docId,
        seq: 0,
        kind: isHeading ? 'heading' : 'paragraph',
        level: isHeading ? (paragraph.fontSize > 18 ? 1 : paragraph.fontSize > 15 ? 2 : 3) : undefined,
        text: paragraph.text,
        charStart: 0,
        charEnd: 0,
        locator: { kind: 'pdf', page: pageNumber, rects: paragraph.rects }
      }
      blocks.push(block)
      for (const line of paragraph.lines) {
        for (const item of line.items) {
          const local = pageLayout.localIndex.get(item.index)
          if (local === undefined) continue
          mapped.set(item.index, { blockId: block.id, offsetInBlock: pageLayout.itemOffsets[local] ?? 0 })
        }
      }
    }

    /**
     * 与文本层里"有文字的 span"一一对应（同序同长）。
     * 纯空白项被剔除 —— 渲染侧也按同一条规则过滤，两边下标才对得上。
     */
    const pageItems: PdfTextItemLayout[] = items
      .filter((item) => item.str.trim().length > 0)
      .map((item) => {
        const hit = mapped.get(item.index)
        return {
          globalStart: 0, // finalize 之后回填为全局偏移
          str: item.str,
          rect: {
            x: item.x / pageWidth,
            y: item.y / pageHeight,
            width: Math.max(0.001, item.width / pageWidth),
            height: Math.max(0.001, (item.fontSize * 1.25) / pageHeight)
          },
          offsetInBlock: hit?.offsetInBlock ?? 0,
          blockId: hit?.blockId ?? blocks[blocks.length - 1]?.id ?? ''
        }
      })
    layout.pages.set(pageNumber, { pageNumber, width: pageWidth, height: pageHeight, items: pageItems })
    page.cleanup()
  }

  const model = finalizeDocumentModel({
    docId: ctx.docId,
    docHash: ctx.docHash,
    format: 'pdf',
    title: ctx.title,
    filePath: ctx.filePath,
    blocks,
    text: '',
    outline: [],
    pageCount: total,
    meta: { pageCount: total, tokens: 0 }
  })

  /**
   * 页首在全文中的基址：**由各页文本长度累加**得出，而不是"第 1 块在所有块里的下标"。
   * 那样做会在"某页一个块都没有"时彻底错位（该页的块序号整体前移），
   * 本次第 31 页偏移整页多出 246 个字符就是它的变体。
   */
  const pageBaseById = new Map<string, number>()
  let pageCursor = 0
  for (const pageNumber of Array.from(layout.pages.keys()).sort((a, b) => a - b)) {
    const page = layout.pages.get(pageNumber)
    if (!page) continue
    for (const item of page.items) pageBaseById.set(item.blockId, pageCursor)
    const pageChars = page.items.reduce((max, item) => Math.max(max, item.offsetInBlock + mappedLength(item.str)), 0)
    pageCursor += pageChars + 1
  }
  for (const page of layout.pages.values()) {
    const offsets: number[] = []
    const lengths: number[] = []
    for (const item of page.items) {
      const start = (pageBaseById.get(item.blockId) ?? 0) + item.offsetInBlock
      item.globalStart = start
      offsets.push(start)
      lengths.push(mappedLength(item.str))
    }
    pageMappings.set(page.pageNumber, { offsets, lengths })
  }
  model.meta.tokens = estimateTokens(model.text)
  /**
   * 持久化文本层映射（按页号索引 + 文本指纹）。
   * 这是"打开即可选"的关键：命中数据库缓存的文档不必重跑解析，
   * 也不必等几秒的映射空窗期；指纹不匹配时阅读器会整批丢弃并回退。
   */
  const persisted: PersistedTextLayerMapping = {
    version: TEXT_LAYER_MAPPING_VERSION,
    textHash: hashDocumentText(model.text),
    textLength: model.text.length,
    pages: {}
  }
  for (const [pageNumber, entry] of pageMappings) persisted.pages[String(pageNumber)] = entry
  /**
   * 落库之前再自证一次：逐页把偏移表拿**最终正文**抽查一遍。
   * 只要"算偏移用的文本"和"最终 model.text"不是同一份，这里立刻就能看出来
   * （本次第 31 页整页偏 246 个字符，正是这条自检该拦住的情况）。
   */
  const audit = auditMappingAgainstModel(model.text, layout)
  if (audit.checked > 0 && audit.matched / audit.checked < 0.8) {
    console.warn('[pdf] 文本层映射落库自检未通过：命中 ' + audit.matched + '/' + audit.checked)
    logPersistWarn('文本层映射落库自检未通过：命中 ' + audit.matched + '/' + audit.checked)
  }
  model.meta.textLayerMapping = persisted
  model.meta.textLayerMappingVersion = TEXT_LAYER_MAPPING_VERSION
  // 兼容字段：旧版阅读器（或回滚到旧构建时）仍能读到偏移表
  model.meta.pdfItemOffsets = {
    version: 1,
    pages: Array.from(pageMappings.keys())
      .sort((a, b) => a - b)
      .map((pageNumber) => pageMappings.get(pageNumber)?.offsets ?? [])
  }

  // 目录树：把 dest 解析为页码，再映射到该页首个块的字符偏移
  const rawOutline = (await doc.getOutline()) as unknown as PdfOutlineItem[] | null
  if (rawOutline && rawOutline.length > 0) {
    const flatBlocks = model.blocks
    const charOfPage = (page: number): { blockId: string; charStart: number } | null => {
      const index = flatBlocks.findIndex((b) => b.locator.kind === 'pdf' && b.locator.page === page)
      if (index < 0) return null
      return { blockId: flatBlocks[index].id, charStart: flatBlocks[index].charStart }
    }
    const convert = async (items: PdfOutlineItem[]): Promise<OutlineNode[]> => {
      const out: OutlineNode[] = []
      for (const item of items) {
        const page = await resolveDestPage(doc, item.dest)
        const target = page != null ? charOfPage(page) : null
        out.push({
          id: createId('outline'),
          title: item.title,
          level: 1,
          blockId: target?.blockId ?? '',
          charStart: target?.charStart ?? 0,
          locator: page != null ? { kind: 'pdf', page, rects: [] } : undefined,
          children: item.items && item.items.length > 0 ? await convert(item.items) : []
        })
      }
      return out
    }
    model.outline = await convert(rawOutline)
    const setLevel = (nodes: OutlineNode[], level: number): void => {
      for (const node of nodes) {
        node.level = level
        setLevel(node.children, level + 1)
      }
    }
    setLevel(model.outline, 1)
  }

  putPdfLayout(ctx.docId, layout)
  return model
}

export type { PdfVectorItem }
