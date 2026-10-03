/**
 * PDF 文本层：**直接使用 pdf.js 官方 TextLayer**
 * ============================================================================
 * 结论先行（本轮调研 + 隔离实测）：
 *
 *   主流 PDF 阅读器（Firefox 内置查看器、pdf.js viewer、Chrome/Edge 的 PDFium、
 *   Zotero、PDF.js Express）用的都是同一套思路：
 *     **canvas 画画面 + 一层透明 HTML 文本层负责选中与无障碍**。
 *   而"透明文本层怎么放"这件事，pdf.js 的 `TextLayer` 已经是久经考验的实现，
 *   它在隔离环境里逐项位置精确（实测：span 的 左/上 与矢量值差值 0.00）。
 *
 *   本项目此前自研过两版文本层，都出现"整页偏移、且不报错"。教训是：
 *   **位置这件事，能复用成熟实现就不要自己写**。所以这里回到官方实现，
 *   并且把它运行所需的环境**完整复刻**（这正是之前失败的地方）：
 *
 *     ① 容器必须有 `.textLayer` 类（pdf.js 的样式表按类生效）；
 *     ② 容器上要设 `--scale-factor` 与 `--total-scale-factor`（它用它们算字号）；
 *     ③ 容器宽高必须等于**当前视口尺寸**；
 *     ④ `new TextLayer({ textContentSource, container, viewport })` 后 `await render()`；
 *     ⑤ 不要自己再写 left/top/font-size —— 官方会写，覆盖只会让它错位。
 *
 * 我们只做一件官方不做的事：把"每段文字对应全文第几个字符"写进 span 的 dataset。
 */
import { pdfjsLib } from './pdfjs'
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist'

export interface OfficialTextLayerResult {
  /** 与"有文字的项"同序同长的 span */
  spans: HTMLElement[]
  /** 每项原文（用于自证） */
  strings: string[]
  /** pdf.js 自己生成的完整 span 列表（含空串项，长度=文本项数） */
  allDivs: HTMLElement[]
}

/**
 * 渲染官方文本层。
 *
 * @param container 必须是 `.textLayer` 容器，且宽高已设为当前视口尺寸
 * @param content   `page.getTextContent()` 的结果（原样传入，不要自己转换）
 */
export async function renderOfficialTextLayer(options: {
  page: PDFPageProxy
  content: { items: unknown[] }
  container: HTMLElement
  viewport: PageViewport
}): Promise<OfficialTextLayerResult> {
  const { content, container, viewport } = options
  // 关键：完整复刻 pdf.js viewer 的运行环境
  container.classList.add('textLayer')
  container.style.setProperty('--scale-factor', String(viewport.scale))
  container.style.setProperty('--total-scale-factor', String(viewport.scale))
  container.style.setProperty('--user-unit', '1')
  const layer = new pdfjsLib.TextLayer({
    textContentSource: content as never,
    container,
    viewport
  })
  await layer.render()

  const allDivs = layer.textDivs as unknown as HTMLElement[]
  const allStrings = layer.textContentItemsStr
  const spans: HTMLElement[] = []
  const strings: string[] = []
  for (let i = 0; i < allDivs.length; i += 1) {
    const text = allStrings[i] ?? ''
    if (text.trim().length === 0) continue
    spans.push(allDivs[i])
    strings.push(text)
  }
  return { spans, strings, allDivs }
}

/** 把字符偏移写进 span（只有抽样自证通过才会调用） */
export function attachOffsets(
  spans: HTMLElement[],
  mapping: { offsets: number[]; lengths: number[] }
): number {
  let assigned = 0
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i]
    const offset = mapping.offsets[i]
    const length = mapping.lengths[i]
    if (!span || !Number.isFinite(offset)) continue
    span.dataset.charStart = String(offset)
    span.dataset.charEnd = String(offset + (Number.isFinite(length) ? length : 0))
    assigned += 1
  }
  return assigned
}

/** 抽样自证：文档文本在给定偏移处是否就是该项原文（忽略空白折叠） */
export function mappingMatchesModel(
  strings: string[],
  mapping: { offsets: number[]; lengths: number[] },
  modelText: string,
  sampleLimit = 24
): { checked: number; matched: number } {
  const squash = (value: string): string => value.replace(/\s+/g, '')
  let checked = 0
  let matched = 0
  for (let i = 0; i < strings.length && checked < sampleLimit; i += 1) {
    const want = squash(strings[i])
    if (want.length < 2) continue
    const from = mapping.offsets[i]
    if (!Number.isFinite(from) || from < 0 || from >= modelText.length) continue
    checked += 1
    const length = Number.isFinite(mapping.lengths[i]) ? mapping.lengths[i] : strings[i].length
    if (squash(modelText.slice(from, from + length)) === want) matched += 1
  }
  return { checked, matched }
}
