/**
 * 文本层偏移表：把"PDF 矢量文本项"变成"写进 DOM 的 data-char-start"。
 *
 * 设计原则（本轮修复的核心）：
 *  1) **偏移由文件矢量几何算出**（pdf.js 文本项的 transform/width），
 *     与缩放、视图模式、缩略图尺寸、渲染分辨率无关；
 *  2) 解析阶段把结果**持久化**到 model.meta.textLayerMapping（按页号索引，不是数组下标），
 *     因此命中数据库缓存的文档**打开即可选**，不存在"等几秒"的空窗期；
 *  3) 持久化数据必须**能自证**：用之前先抽样校验"文档文本在该偏移处是否就是该 span 的内容"，
 *     不通过就整批丢弃，改用当前解析布局重建 —— 绝不猜、也不静默失效；
 *  4) 任何一步失败都要**留下可搜的日志**（含页号与数量），而不是只有一句"缺少偏移表"。
 */
import type { DocumentModel } from '@logicreader/document-model'
import { buildPdfPageLayout, testPdfPageLayout, toVectorItems, type PdfVectorItem } from './pdfVectorText'

/**
 * 文本层映射的存储版本。
 * 注意：**改映射算法（偏移怎么算）也要 +1** —— 只校验文本指纹是抓不到"文本没变、
 * 但偏移算法变了"这种情况的，旧偏移会带着正确的指纹继续被信任
 * （实测踩过：改完空白归属后，库里的旧偏移仍被判为有效，抽查命中率只有 0~50%）。
 * v1 = 按页号索引 + 文本指纹；
 * v2 = 偏移/长度按"空白归属前一项"重算；
 * v3 = 偏移改为**全文绝对偏移**（v2 之前第 2 页起算的是"页内偏移"，整页对不上）；
 * v4 = 偏移表只覆盖"有文字的 span"（此前掺进空串项，下标与 DOM 对不上，整页错位）；
 * v5 = 页首基址改由"各页文本长度累加"得出（此前用块序号推，遇到无块页会整页偏移）；
 * v6 = 文本层改为自建矢量渲染器（基线来自 transform[5]、上升高度来自 content.styles.ascent）
 */
export const TEXT_LAYER_MAPPING_VERSION = 6

export interface PersistedPageMapping {
  /** 与 textDivs 同序同长的全局字符偏移 */
  offsets: number[]
  /** 每项在归一化文本里占的字符数（项内连续空白被折叠、纯空白项为 0） */
  lengths: number[]
}

/** 一页的映射结果：偏移 + 长度 */
export interface PageMapping {
  offsets: number[]
  lengths: number[]
}

export interface PersistedTextLayerMapping {
  version: number
  /** model.text 的 FNV-1a 指纹：与当前模型文本不一致则整批作废 */
  textHash: string
  textLength: number
  /** 页号（1 基）→ 该页偏移表 */
  pages: Record<string, PersistedPageMapping>
}

/** pdf.js 的原始文本项（只取本模块需要的字段） */
export interface PdfRawItem {
  str?: string
  transform: number[]
  width: number
  height: number
  fontName?: string
  hasEOL?: boolean
}

/** 与归一化文本一致的 FNV-1a 指纹（只用于"是不是同一份文本"的自校验） */
export function hashDocumentText(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x1000193
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0
    h2 = Math.imul(h2 + c + i, 2246822519) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

/**
 * 把 pdf.js 的文本项转成"视口坐标系下的矢量项"。
 * 顺序与下标**完全保留**：pdf.js 的 TextLayer 对每个非标记项生成且只生成一个 span，
 * 所以 items[i] ↔ textDivs[i] 是构造性恒等式（渲染后会用文字内容再校验一遍）。
 */
export { toVectorItems }

/** 只保留 str 的占位项（与 toVectorItems 同序同长，用于校验长度与内容） */
export function spanStrings(rawItems: PdfRawItem[]): string[] {
  const out: string[] = []
  for (const item of rawItems) {
    if (typeof item.str !== 'string') continue
    out.push(item.str)
  }
  return out
}

/**
 * 抽样校验：文档文本在给定偏移处是否就是 span 的内容（忽略空白差异）。
 * 派生数据可以缓存，但**必须能自证**；不通过就整批丢弃、改用现算结果。
 */
export function offsetsMatchModelText(
  modelText: string,
  offsets: number[],
  strings: string[],
  lengths?: number[],
  sampleLimit = 16
): { checked: number; matched: number } {
  const squash = (value: string): string => value.replace(/\s+/g, '')
  let checked = 0
  let matched = 0
  for (let i = 0; i < strings.length && checked < sampleLimit; i += 1) {
    const want = squash(strings[i])
    if (want.length < 2) continue
    const from = offsets[i]
    if (!Number.isFinite(from) || from < 0 || from >= modelText.length) continue
    checked += 1
    const length = lengths?.[i] ?? strings[i].length
    const slice = modelText.slice(from, from + length)
    if (slice === strings[i] || squash(slice) === want) matched += 1
  }
  return { checked, matched }
}

/**
 * 从文档模型里取某页的持久化映射（校验版本与文本指纹；不匹配返回 null）。
 * 这条路径让"命中数据库缓存"的文档**打开即可选**，不需要等解析。
 */
export function persistedPageMapping(model: DocumentModel | null, pageNumber: number): PageMapping | null {
  if (!model) return null
  const mapping = (model.meta as { textLayerMapping?: PersistedTextLayerMapping } | undefined)?.textLayerMapping
  if (!mapping || mapping.version !== TEXT_LAYER_MAPPING_VERSION) return null
  if (mapping.textHash !== hashDocumentText(model.text) || mapping.textLength !== model.text.length) return null
  const page = mapping.pages?.[String(pageNumber)]
  if (!page || !Array.isArray(page.offsets) || page.offsets.length === 0) return null
  if (!Array.isArray(page.lengths) || page.lengths.length !== page.offsets.length) return null
  return { offsets: page.offsets, lengths: page.lengths }
}

/** 当前会话内解析得到的布局（旧文档兜底路径） */
export function layoutPageMapping(
  layout: {
    pages: Map<number, { items: { globalStart?: number; offsetInBlock: number; str: string }[] }>
  } | null,
  pageNumber: number
): PageMapping | null {
  const page = layout?.pages.get(pageNumber)
  if (!page || page.items.length === 0) return null
  return {
    offsets: page.items.map((item) => item.globalStart ?? item.offsetInBlock),
    lengths: page.items.map((item) => squashLength(item.str))
  }
}

/** 归一化后的长度（与 mappedLength 同一规则；此处不引入额外依赖） */
function squashLength(raw: string): number {
  return raw.replace(/\s+/g, ' ').trim().length
}

/**
 * 由矢量文本项直接算出某页的映射（不做任何几何拟合）。
 * 返回的 offsets/lengths 与 items 同序同长，可直接按下标写进 textDivs。
 */
export function computePageMapping(
  rawItems: PdfRawItem[],
  pageWidth: number,
  pageHeight: number,
  pageNumber: number,
  /**
   * 本页第一项在**全文**中的偏移。
   * 矢量布局算出来的是"页内偏移"，而写进 DOM 的必须是全局偏移 ——
   * 少了这个 base，除第 1 页外所有页的映射都会整体对不上
   * （实测：第 2 页 "Contents" 被算成偏移 0，而全文 0 处是标题）。
   */
  globalBase = 0
): { mapping: PageMapping; strings: string[]; pageText: string; bad: number } {
  const items = toVectorItems(rawItems, pageHeight)
  const layout = buildPdfPageLayout(pageNumber, pageWidth, pageHeight, items)
  const test = testPdfPageLayout(layout, items)
  return {
    mapping: {
      offsets: layout.itemOffsets.map((offset) => offset + globalBase),
      lengths: layout.itemLengths
    },
    strings: items.map((item) => item.str),
    pageText: layout.pageText,
    bad: test.bad.length
  }
}

/**
 * 本页首项在全文中的偏移（由解析布局给出）。
 * 页面先于解析完成而渲染时会拿不到，此时返回 null，调用方应等待映射就绪而不是用 0 硬算。
 */
export function pageGlobalBase(
  layout: { pages: Map<number, { items: { globalStart?: number }[] }> } | null,
  pageNumber: number
): number | null {
  const page = layout?.pages.get(pageNumber)
  if (!page || page.items.length === 0) return null
  const first = page.items.find((item) => Number.isFinite(item.globalStart))
  return first && Number.isFinite(first.globalStart) ? (first.globalStart as number) : null
}
