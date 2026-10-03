import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReaderTab } from '@logicreader/shared'
import type { DocumentModel } from '@logicreader/document-model'
import { api } from '../../../lib/api'
import { ensureSheets, getSheets, type SheetData } from '../../../lib/sheetCache'
import { useUiStore } from '../../../state/ui.store'
import { useSettings } from '../../../state/settings.store'
import { registerReaderController } from '../../../state/readerBridge'
import { useRevealRequest } from '../../../lib/revealRequest'
import { markRange, useClearRevealOnReset } from '../../../lib/revealMark'

interface Props {
  tab: ReaderTab
  model: DocumentModel
}

const MAX_RENDER_ROWS = 2000
const EMPTY_ROW: (string | null)[] = []

/** 从 locator 的单元格区间（"A5:E5"）取 0 基行号；取不到返回 -1 */
function rowFromRange(range: string | undefined): number {
  const match = /[A-Za-z]+(\d+)/.exec(range ?? '')
  return match ? Number(match[1]) - 1 : -1
}

interface SheetCellProps {
  row: number
  column: number
  value: string
  active: boolean
  onSelect: (row: number, column: number) => void
}

/**
 * 单元格与行都做 memo：点击一个单元格只重渲染受影响的行，
 * 而不是整张表（上限 2000 行 × 256 列，全量重渲染会明显卡顿）。
 */
const SheetCell = memo(function SheetCell({ row, column, value, active, onSelect }: SheetCellProps) {
  const trimmed = value.trim()
  const isNumber = trimmed.length > 0 && /^-?[\d,]+(\.\d+)?%?$/.test(trimmed)
  return (
    <td
      className="lr-sheet__cell"
      data-active={active}
      data-number={isNumber}
      title={value}
      onClick={() => onSelect(row, column)}
    >
      {value}
    </td>
  )
})

interface SheetRowProps {
  row: number
  values: (string | null)[]
  columnCount: number
  activeRow: boolean
  activeColumn: number | null
  onSelect: (row: number, column: number) => void
}

const SheetRow = memo(function SheetRow({ row, values, columnCount, activeRow, activeColumn, onSelect }: SheetRowProps) {
  return (
    <tr data-row={row}>
      <th className="lr-sheet__row-header" data-active={activeRow}>
        {row + 1}
      </th>
      {Array.from({ length: columnCount }, (_, column) => (
        <SheetCell
          key={column}
          row={row}
          column={column}
          value={values[column] ?? ''}
          active={activeRow && activeColumn === column}
          onSelect={onSelect}
        />
      ))}
    </tr>
  )
})

export function SheetReaderView({ tab, model }: Props): JSX.Element {
  const { t } = useTranslation()
  /*
   * 命中数据库缓存打开时，解析没有跑、内存缓存是空的：
   * 从原文件补载（ensureSheets 内部并发去重），失败时给出错误页而不是永远停在加载态。
   */
  const [sheets, setSheets] = useState<SheetData[]>(() => getSheets(model.docId) ?? [])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sheetIndex, setSheetIndex] = useState(0)
  const [showFormulas, setShowFormulas] = useState(false)
  const [activeCell, setActiveCell] = useState<{ row: number; column: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const setSelection = useUiStore((s) => s.setSelection)
  const setActiveReaderTab = useUiStore((s) => s.setActiveReaderTab)
  const setReaderProgress = useUiStore((s) => s.setReaderProgress)
  const { settings } = useSettings()

  const sheet: SheetData | undefined = sheets[sheetIndex]

  useEffect(() => {
    const cached = getSheets(model.docId)
    if (cached) {
      setSheets(cached)
      setLoadError(null)
      return
    }
    let cancelled = false
    ensureSheets(model.docId, model.filePath).then(
      (loaded) => {
        if (cancelled) return
        setSheets(loaded)
        setLoadError(null)
      },
      (error) => {
        if (cancelled) return
        const message = error instanceof Error ? error.message : String(error)
        setLoadError(message)
        void api.log.write('warn', 'reader', '表格数据加载失败：' + model.filePath + '（' + message + '）')
      }
    )
    return () => {
      cancelled = true
    }
  }, [model.docId, model.filePath])

  useEffect(() => {
    setActiveReaderTab(tab.id)
    setReaderProgress({ page: sheetIndex + 1, total: sheets.length, zoom: 1, percent: 0 })
  }, [tab.id, sheetIndex, sheets.length, setActiveReaderTab, setReaderProgress])

  const columnLabel = useCallback((index: number): string => {
    let n = index + 1
    let out = ''
    while (n > 0) {
      const rem = (n - 1) % 26
      out = String.fromCharCode(65 + rem) + out
      n = Math.floor((n - 1) / 26)
    }
    return out
  }, [])

  const selectCell = useCallback(
    (row: number, column: number) => {
      if (!sheet) return
      setActiveCell({ row, column })
      const value = showFormulas ? sheet.formulas[row]?.[column] ?? '' : sheet.rows[row]?.[column] ?? ''
      const address = columnLabel(column) + (row + 1)
      /*
       * 按 locator 的"工作表 + 行区间"找块，不看 meta.rowIndex：
       * 块落库时 meta 不持久化，命中数据库缓存打开时 meta 是空的，只有 locator 一定在。
       */
      const block = model.blocks.find(
        (b) => b.locator.kind === 'sheet' && b.locator.sheet === sheet.name && rowFromRange(b.locator.range) === row
      )
      if (block) {
        setSelection({
          docId: model.docId,
          tabId: tab.id,
          text: value || address,
          charStart: block.charStart + Math.min(column, block.text.length),
          charEnd: block.charStart + Math.min(column + (value.length || 1), block.text.length),
          anchorId: null,
          locationLabel: sheet.name + '!' + address
        })
      }
    },
    [sheet, showFormulas, model, columnLabel, setSelection, tab.id]
  )

  /**
   * 外部定位请求（图中节点/连线跳转）：切到目标 Sheet、滚到目标行并高亮 1.6 秒。
   *
   * 返回 false = 还没落到行上，交给 `useRevealRequest` 重试：
   * 切 Sheet 是 React 状态更新，这一轮 DOM 里还是旧表；从关系图跳过来时本视图也刚挂载。
   */
  const applyReveal = useCallback(
    (charStart: number, options: { hold?: boolean; durationMs?: number } = {}): boolean => {
      const block = model.blocks.find((b) => b.charStart <= charStart && b.charEnd >= charStart)
      const locator = block?.locator
      if (!block || locator?.kind !== 'sheet') return false
      const index = sheets.findIndex((item) => item.name === locator.sheet)
      if (index < 0) return false
      if (index !== sheetIndex) {
        setSheetIndex(index)
        return false
      }
      /*
       * 行号从 locator 的 range 里取（"A5:E5" → 第 5 行），不用 block.meta.rowIndex：
       * 块落库时 meta 不参与持久化（BlockRecord 没有该字段），
       * 命中数据库缓存打开时 meta 是空的 —— 只有 locator 一定在。
       */
      const row = rowFromRange(locator.range)
      if (row < 0) return false
      const target = scrollRef.current?.querySelector<HTMLElement>('tr[data-row="' + row + '"]')
      if (!target) return false
      target.scrollIntoView({ behavior: settings.reader.smoothScroll ? 'smooth' : 'auto', block: 'center' })
      markRange(scrollRef.current, target, { charStart, charEnd: charStart }, options)
      setActiveCell({ row, column: 0 })
      return true
    },
    [model, sheets, sheetIndex, settings.reader.smoothScroll]
  )

  useRevealRequest(model.docId, (request) =>
    applyReveal(request.charStart, { hold: request.hold, durationMs: request.durationMs })
  )
  useClearRevealOnReset(scrollRef)

  useEffect(() => {
    return registerReaderController({
      docId: model.docId,
      tabId: tab.id,
      kind: 'sheet',
      zoomIn: () => undefined,
      zoomOut: () => undefined,
      zoomFitWidth: () => undefined,
      zoomFitPage: () => undefined,
      zoomActual: () => undefined,
      setZoom: () => undefined,
      rotate: () => undefined,
      setViewMode: () => undefined,
      nextPage: () => setSheetIndex((index) => Math.min(sheets.length - 1, index + 1)),
      previousPage: () => setSheetIndex((index) => Math.max(0, index - 1)),
      gotoPage: (page) => setSheetIndex(Math.max(0, Math.min(sheets.length - 1, page - 1))),
      find: () => undefined,
      findNext: () => undefined,
      findPrevious: () => undefined,
      openFind: () => undefined,
      addAnnotation: () => undefined,
      deleteActiveAnnotation: () => undefined,
      clearAnnotations: () => undefined,
      exportAnnotated: () => undefined,
      revealRange: (charStart) => void applyReveal(charStart),
      copyCitation: () => {
        const selection = useUiStore.getState().selection
        if (!selection) return ''
        const citation = '《' + model.title + '》' + selection.locationLabel + '\n' + selection.text
        void navigator.clipboard.writeText(citation)
        return citation
      }
    })
  }, [model, tab.id, sheets.length, applyReveal])

  if (loadError) {
    return (
      <div className="lr-editor-message">
        <h2>{t('reader.parseFailed')}</h2>
        <p>{t('reader.sheet.loadFailed', { message: loadError })}</p>
      </div>
    )
  }

  if (!sheet) {
    return (
      <div className="lr-editor-message">
        <div className="lr-spinner" />
        <p>{t('reader.loading')}</p>
      </div>
    )
  }

  const rowsToRender = Math.min(sheet.rowCount, MAX_RENDER_ROWS)

  return (
    <div className="lr-reader">
      <div className="lr-reader__toolbar">
        {sheets.map((item, index) => (
          <button
            key={item.name}
            className="lr-sheet-tab"
            data-active={index === sheetIndex}
            onClick={() => {
              setSheetIndex(index)
              setActiveCell(null)
            }}
          >
            {item.name}
          </button>
        ))}
        <div className="lr-reader__toolbar-divider" />
        <label className="lr-reader__toolbar-meta">
          <input type="checkbox" checked={showFormulas} onChange={(event) => setShowFormulas(event.target.checked)} /> {t('reader.sheet.formulas')}
        </label>
        <div className="lr-reader__toolbar-spacer" />
        <span className="lr-reader__toolbar-meta">
          {sheet.name} · {sheet.rowCount} × {sheet.columnCount}
          {sheet.rowCount > MAX_RENDER_ROWS ? ' (' + t('common.warning') + ': ' + t('reader.sheet.truncatedRows', { rows: MAX_RENDER_ROWS }) + ')' : ''}
        </span>
      </div>
      <div className="lr-reader__viewport lr-scroll lr-sheet-viewport" ref={scrollRef}>
        <table className="lr-sheet">
          <thead>
            <tr>
              <th className="lr-sheet__corner" />
              {Array.from({ length: sheet.columnCount }, (_, column) => (
                <th key={column} className="lr-sheet__col-header" data-active={activeCell?.column === column}>
                  {columnLabel(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rowsToRender }, (_, row) => (
              <SheetRow
                key={row}
                row={row}
                values={(showFormulas ? sheet.formulas[row] : sheet.rows[row]) ?? EMPTY_ROW}
                columnCount={sheet.columnCount}
                activeRow={activeCell?.row === row}
                activeColumn={activeCell?.column ?? null}
                onSelect={selectCell}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
