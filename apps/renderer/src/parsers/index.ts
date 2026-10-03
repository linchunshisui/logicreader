import type { DocumentFormat } from '@logicreader/shared'
import type { DocumentModel } from '@logicreader/document-model'
import { parseTextDocument } from './text'
import { parsePdfDocument } from './pdf'
import { parseMarkdownDocument } from './markdown'
import { parseDocxDocument } from './docx'
import { parseSheetDocument } from './sheet'
import type { DocumentParser, ParseContext } from './types'

const registry: Partial<Record<DocumentFormat, DocumentParser>> = {
  text: parseTextDocument,
  pdf: parsePdfDocument,
  markdown: parseMarkdownDocument,
  docx: parseDocxDocument,
  sheet: parseSheetDocument
  // doc / slide 走 LibreOffice → PDF 管线（M6）
}

export function registerParser(format: DocumentFormat, parser: DocumentParser): void {
  registry[format] = parser
}

export function hasParser(format: DocumentFormat): boolean {
  return Boolean(registry[format])
}

/**
 * 解析器版本号。
 * 只要"块的顺序 / 切分规则 / 文本归一化"发生变化就 +1：
 * 缓存文档会据此重新解析，避免"数据库里是旧解析结果、内存里是新映射"的错位。
 * v2：修正 PDF 行序（此前每页自上而下的顺序被写反，导致选区位置与原文不符）
 * v3：修正 PDF 行矩形（此前垂直镜像，导致高亮/标注画到页面另一侧）
 * v4：PDF 文本层映射改为"矢量几何算出 + 持久化自校验"（按页号索引，带文本指纹），
 *     旧缓存必须重解析一次才能拿到新格式的映射表
 * v5：修正映射偏移的坐标系（全文绝对偏移，此前第 2 页起用的是页内偏移）、
 *     偏移表只覆盖有文字的文本项（此前掺入空串项导致与 DOM 下标错位）
 * v6 / v7：文本层映射改为**按构造下标一一对应**（`span[i] ≡ items[i]`，不再做几何最近邻拟合），
 *     并随文本层渲染方式调整（改回官方 pdf.js TextLayer）而失效重算
 */
export const PARSER_VERSION = 7

export async function parseDocument(ctx: ParseContext): Promise<DocumentModel> {
  const parser = registry[ctx.format] ?? parseTextDocument
  return parser(ctx)
}

export type { ParseContext, DocumentParser }
