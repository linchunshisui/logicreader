/**
 * 兼容层：旧的 lib/pdfTextLayout 已由 lib/pdfVectorText 取代（推翻重写）。
 * 这里只做转出 + 一个 toVectorItems 适配器，保证既有调用点不炸；
 * 新代码请直接 import from './pdfVectorText'。
 */
export {
  buildPdfPageLayout,
  groupVectorLines,
  itemCssStyle,
  joinLineItems,
  lineRect,
  mappedLength,
  splitVectorParagraphs,
  testPdfPageLayout
} from './pdfVectorText'
export type { PdfPageLayout, PdfVectorItem, PdfVectorLine, PdfVectorParagraph, TextLayerItemStyle } from './pdfVectorText'

import { toVectorItems as toVectorItemsWithStyles, type PdfVectorItem } from './pdfVectorText'

/**
 * 旧签名适配：不传字体样式表时按 0.88 估算上升高度。
 * 新代码请用 pdfVectorText.toVectorItems(items, pageHeight, styles) 以拿到真实字体度量。
 */
export function toVectorItems(
  rawItems: { str?: string; transform: number[]; width: number; height: number; fontName?: string }[],
  pageHeight: number
): PdfVectorItem[] {
  return toVectorItemsWithStyles(rawItems, pageHeight, {})
}
