/**
 * 表格数据提取（lib/sheetCache.workbookToSheets）的自洽性测试：
 * 解析路径与"缓存命中后的补载路径"共用这一个纯函数，
 * 两边数据必须同源（架构约定：坐标与内容同源）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as XLSX from 'xlsx'
import { workbookToSheets } from '../apps/renderer/src/lib/sheetCache'

const fixture = resolve(__dirname, 'fixtures/finance.xlsx')

function readFixture(): XLSX.WorkBook {
  return XLSX.read(readFileSync(fixture), { type: 'buffer', cellFormula: true, cellDates: true })
}

describe('表格数据提取', () => {
  it('每个工作表产出一条 SheetData，名字与顺序一致', () => {
    const workbook = readFixture()
    const sheets = workbookToSheets(workbook)
    expect(sheets.map((s) => s.name)).toEqual(workbook.SheetNames)
  })

  it('行列数与内容区间一致（含上限截断），rows/formulas 与 rowCount 对齐', () => {
    const workbook = readFixture()
    const sheets = workbookToSheets(workbook)
    for (const sheet of sheets) {
      const range = XLSX.utils.decode_range(workbook.Sheets[sheet.name]['!ref'] ?? 'A1')
      expect(sheet.rowCount).toBe(Math.min(range.e.r - range.s.r + 1, 20000))
      expect(sheet.columnCount).toBe(Math.min(range.e.c - range.s.c + 1, 256))
      expect(sheet.startRow).toBe(range.s.r)
      expect(sheet.startColumn).toBe(range.s.c)
      expect(sheet.rows).toHaveLength(sheet.rowCount)
      expect(sheet.formulas).toHaveLength(sheet.rowCount)
      for (const row of sheet.rows) expect(row).toHaveLength(sheet.columnCount)
    }
  })

  it('空单元格为空串、公式单元格带 = 前缀', () => {
    const workbook = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([
      ['名称', '数量'],
      ['苹果', 3]
    ])
    sheet['B3'] = { t: 'n', v: 3, f: 'SUM(B2:B2)' } as XLSX.CellObject
    sheet['!ref'] = 'A1:B3'
    XLSX.utils.book_append_sheet(workbook, sheet, '测试')
    const [data] = workbookToSheets(workbook)
    expect(data.rows[0]).toEqual(['名称', '数量'])
    expect(data.formulas[2][1]).toBe('=SUM(B2:B2)')
    expect(data.formulas[0][0]).toBeNull()
  })
})
