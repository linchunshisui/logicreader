/**
 * 表格数据缓存：解析后保存在渲染进程内存里，供表格视图渲染。
 *
 * 命中数据库缓存打开文档时不会重新解析（documents.store 直接用库里的块重建模型），
 * 这条路径上内存缓存是空的 —— 视图用 ensureSheets 按需从原文件补载。
 */
import * as XLSX from 'xlsx'
import type { WorkBook } from 'xlsx'
import { api } from './api'

export interface SheetData {
  name: string
  rows: string[][]
  formulas: (string | null)[][]
  ref: string
  rowCount: number
  columnCount: number
  /** 内容区间在工作表里的起始行/列（0 基），locator 区间换算要用 */
  startRow: number
  startColumn: number
}

const MAX_ROWS = 20000
const MAX_COLUMNS = 256

const cache = new Map<string, { workbook: WorkBook; sheets: SheetData[] }>()
const inflight = new Map<string, Promise<SheetData[]>>()

/**
 * WorkBook → SheetData[] 的唯一实现（解析路径与补载路径共用，保证两边看到的数据同源）。
 * 纯函数，可脱离 Electron 环境单测。
 */
export function workbookToSheets(workbook: WorkBook): SheetData[] {
  const sheets: SheetData[] = []
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]
    const ref = sheet['!ref'] ?? 'A1'
    const range = XLSX.utils.decode_range(ref)
    const rowCount = Math.min(range.e.r - range.s.r + 1, MAX_ROWS)
    const columnCount = Math.min(range.e.c - range.s.c + 1, MAX_COLUMNS)
    const rows: string[][] = []
    const formulas: (string | null)[][] = []

    for (let r = 0; r < rowCount; r += 1) {
      const rowValues: string[] = []
      const rowFormulas: (string | null)[] = []
      for (let c = 0; c < columnCount; c += 1) {
        const address = XLSX.utils.encode_cell({ r: range.s.r + r, c: range.s.c + c })
        const cell = sheet[address] as (XLSX.CellObject & { f?: string }) | undefined
        if (!cell) {
          rowValues.push('')
          rowFormulas.push(null)
          continue
        }
        const value = cell.w ?? (cell.v == null ? '' : String(cell.v))
        rowValues.push(value)
        rowFormulas.push(cell.f ? '=' + cell.f : null)
      }
      rows.push(rowValues)
      formulas.push(rowFormulas)
    }

    sheets.push({ name, rows, formulas, ref, rowCount, columnCount, startRow: range.s.r, startColumn: range.s.c })
  }
  return sheets
}

export function putSheets(docId: string, workbook: WorkBook, sheets: SheetData[]): void {
  cache.set(docId, { workbook, sheets })
}

export function getSheets(docId: string): SheetData[] | null {
  return cache.get(docId)?.sheets ?? null
}

/**
 * 缓存命中路径的补载：内存里没有就从原文件读回表格数据。
 * 同一文档的并发调用共享同一个 Promise（打开多个标签不会重复解析）。
 */
export function ensureSheets(docId: string, filePath: string): Promise<SheetData[]> {
  const hit = cache.get(docId)
  if (hit) return Promise.resolve(hit.sheets)
  const running = inflight.get(docId)
  if (running) return running
  const task = (async () => {
    const bytes = await api.fs.readBinary(filePath)
    const workbook = XLSX.read(bytes, { type: 'array', cellFormula: true, cellDates: true })
    const sheets = workbookToSheets(workbook)
    cache.set(docId, { workbook, sheets })
    return sheets
  })()
  inflight.set(docId, task)
  task.finally(() => inflight.delete(docId)).catch(() => undefined)
  return task
}

export function dropSheets(docId: string): void {
  cache.delete(docId)
}
