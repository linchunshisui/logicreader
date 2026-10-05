/**
 * 表格解析（规划书 FR-1.6）：SheetJS 原生表格视图。
 * 每个块对应工作表的一行，便于锚点定位到单元格区域（Sheet1!A5:E5）。
 * 单元格提取逻辑在 lib/sheetCache.workbookToSheets（与缓存命中后的补载路径共用同一份实现）。
 */
import * as XLSX from '@e965/xlsx'
import { createId } from '@logicreader/shared'
import { finalizeDocumentModel, type Block, type DocumentModel } from '@logicreader/document-model'
import { api } from '../lib/api'
import { putSheets, workbookToSheets } from '../lib/sheetCache'
import type { ParseContext } from './types'

function columnName(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

export async function parseSheetDocument(ctx: ParseContext): Promise<DocumentModel> {
  const bytes = await api.fs.readBinary(ctx.filePath)
  const workbook = XLSX.read(bytes, { type: 'array', cellFormula: true, cellDates: true })
  const sheets = workbookToSheets(workbook)
  const blocks: Block[] = []
  let sheetIndex = 0

  for (const data of sheets) {
    for (let r = 0; r < data.rows.length; r += 1) {
      const text = data.rows[r].join('\t').replace(/\t+$/, '')
      if (text.trim().length === 0) continue
      blocks.push({
        id: createId('blk'),
        docId: ctx.docId,
        seq: 0,
        kind: 'cell',
        text,
        charStart: 0,
        charEnd: 0,
        locator: {
          kind: 'sheet',
          sheet: data.name,
          range:
            columnName(data.startColumn) +
            (data.startRow + r + 1) +
            ':' +
            columnName(data.startColumn + data.columnCount - 1) +
            (data.startRow + r + 1)
        },
        meta: { rowIndex: r, sheetIndex, sheetName: data.name }
      })
    }
    sheetIndex += 1
  }

  putSheets(ctx.docId, workbook, sheets)

  const model = finalizeDocumentModel({
    docId: ctx.docId,
    docHash: ctx.docHash,
    format: ctx.format,
    title: ctx.title,
    filePath: ctx.filePath,
    blocks,
    text: '',
    outline: sheets.map((sheet, index) => ({
      id: createId('outline'),
      title: sheet.name,
      level: 1,
      blockId: blocks.find((b) => b.meta?.sheetIndex === index)?.id ?? '',
      charStart: blocks.find((b) => b.meta?.sheetIndex === index)?.charStart ?? 0,
      children: []
    })),
    pageCount: null,
    meta: { sheetNames: workbook.SheetNames }
  })
  return model
}
