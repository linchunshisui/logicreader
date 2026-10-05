import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
import { DEFAULT_ROW_HEIGHT, computeSheetWindow, rowScrollOffset } from '../../../lib/sheetWindow'
import { ZoomInput, clampZoom } from '../ZoomInput'
import { IconActualSize, IconFitWidth, IconZoomIn, IconZoomOut } from '../../../workbench/icons'

interface Props {
  tab: ReaderTab
  model: DocumentModel
}

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
 * 单元格与行都做 memo：点击一个单元格只重渲染受影响的行。
 * 表格本身只渲染窗口内的几十行（见 lib/sheetWindow），memo 是第二道防线：
 * 滚动时窗口滑动会让部分行换位，memo 让"值没变"的行不重渲染。
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
  const [scale, setScale] = useState(1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const tableRef = useRef<HTMLTableElement>(null)
  /*
   * 虚拟滚动：只渲染窗口内的行（见 lib/sheetWindow）。
   * `scroll` 是**滚动容器坐标**（已被 CSS zoom 放大），`rowHeight` 是**未缩放**行高；
   * 两套坐标的换算一律交给 sheetWindow 里的纯函数，这里不做心算。
   */
  const [scroll, setScroll] = useState({ top: 0, height: 0 })
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT)
  const scrollFrame = useRef(0)
  const setSelection = useUiStore((s) => s.setSelection)
  const setActiveReaderTab = useUiStore((s) => s.setActiveReaderTab)
  const setReaderProgress = useUiStore((s) => s.setReaderProgress)
  const { settings } = useSettings()

  const sheet: SheetData | undefined = sheets[sheetIndex]

  /*
   * 行高从已渲染的行上量：`.lr-sheet` 是 `white-space: nowrap`，行高统一，量一行就够。
   * `getBoundingClientRect()` 在这个 Chromium 下**会被 CSS zoom 放大**，
   * 所以要除以 scale 折回未缩放坐标 —— 窗口函数要的正是未缩放的 rowHeight。
   * 不依赖 scroll.top：那会让每帧滚动都强制同步布局，而行高与滚动位置无关。
   */
  useLayoutEffect(() => {
    const row = scrollRef.current?.querySelector<HTMLElement>('tbody tr[data-row]')
    if (!row || !sheet) return
    const measured = row.getBoundingClientRect().height
    const next = scale > 0 ? measured / scale : measured
    if (next > 0 && Math.abs(next - rowHeight) > 0.5) setRowHeight(next)
  }, [sheet, scale, showFormulas, rowHeight])

  /* 视口尺寸：切换工作表 / 缩放后容器高度会变，重取一次 */
  useLayoutEffect(() => {
    const host = scrollRef.current
    if (!host) return
    setScroll({ top: host.scrollTop, height: host.clientHeight })
  }, [sheet, scale])

  useEffect(() => {
    return () => {
      if (scrollFrame.current) cancelAnimationFrame(scrollFrame.current)
    }
  }, [])

  /**
   * 滚动位置：每帧最多提交一次。
   * 逐事件写 state 会让整棵树跟着重渲染（避坑指南 §45 的老毛病），所以用 rAF 合并。
   */
  const handleScroll = useCallback(() => {
    if (scrollFrame.current) return
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0
      const host = scrollRef.current
      if (!host) return
      setScroll({ top: host.scrollTop, height: host.clientHeight })
    })
  }, [])

  /**
   * 表格的"自然宽度"（倍率 1 时的像素宽）。
   *
   * **必须把 zoom 临时置 1 再量**：直接拿当前矩形除以 scale 的话，
   * 一旦这个 Chromium 的 `getBoundingClientRect()` 不按 zoom 缩放（旧行为），
   * `自然宽 = 矩形 / scale` 会随 scale 变小 → 适应宽度算出的倍率越算越大（正反馈，
   * 与 ARCHITECTURE §1.23 里 PDF 旋转不断放大是同一类 bug）。量之前先归一，闭环就不成立。
   */
  const naturalWidth = useCallback((): number => {
    const table = tableRef.current
    if (!table) return 0
    const previous = table.style.zoom
    table.style.zoom = '1'
    const width = table.getBoundingClientRect().width
    table.style.zoom = previous
    return width
  }, [])

  const fitWidth = useCallback((): void => {
    const host = scrollRef.current
    const natural = naturalWidth()
    if (!host || natural <= 0) return
    // 留 2px 余量：正好相等时亚像素误差会换来一条无意义的横向滚动条
    setScale(clampZoom((host.clientWidth - 2) / natural, 0.2, 4))
  }, [naturalWidth])

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
    // 表格分的是**工作表**不是页：口径交给状态栏（见 lib ReaderProgress.unit）
    setReaderProgress({ page: sheetIndex + 1, total: sheets.length, zoom: scale, percent: 0, unit: 'sheet' })
  }, [tab.id, sheetIndex, sheets.length, scale, setActiveReaderTab, setReaderProgress])

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
          locationLabel: sheet.name + '!' + address,
          // 单元格选区不经 DOM Range：工具条退回底部定位（表格视图下遮挡风险本来就小）
          rect: null
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
      const host = scrollRef.current
      if (!host) return false
      const target = host.querySelector<HTMLElement>('tr[data-row="' + row + '"]')
      if (!target) {
        /*
         * 虚拟滚动下目标行可能根本不在 DOM 里（落在窗口之外）。
         * 先把容器滚到那一行，行进入窗口后由 `useRevealRequest` 的下一轮重试接住 ——
         * 这里返回 false 就是"还没落地，请重试"，不能假装成功。
         */
        host.scrollTop = rowScrollOffset(row, rowHeight, scale)
        setScroll({ top: host.scrollTop, height: host.clientHeight })
        return false
      }
      target.scrollIntoView({ behavior: settings.reader.smoothScroll ? 'smooth' : 'auto', block: 'center' })
      markRange(scrollRef.current, target, { charStart, charEnd: charStart }, options)
      setActiveCell({ row, column: 0 })
      return true
    },
    [model, sheets, sheetIndex, settings.reader.smoothScroll, rowHeight, scale]
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
      zoomIn: () => setScale((value) => clampZoom(value + 0.1, 0.2, 4)),
      zoomOut: () => setScale((value) => clampZoom(value - 0.1, 0.2, 4)),
      zoomFitWidth: fitWidth,
      // 表格没有"页面"可装：适应页面等同于适应宽度（表比视口宽时才有意义）
      zoomFitPage: fitWidth,
      zoomActual: () => setScale(1),
      setZoom: (value) => setScale(clampZoom(value, 0.2, 4)),
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
  }, [model, tab.id, sheets.length, applyReveal, fitWidth])

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

  const sheetWindow = computeSheetWindow({
    scrollTop: scroll.top,
    viewportHeight: scroll.height,
    rowHeight,
    scale,
    totalRows: sheet.rowCount
  })

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
        <button
          className="lr-icon-button"
          title={t('reader.zoomOut')}
          onClick={() => setScale((value) => clampZoom(value - 0.1, 0.2, 4))}
        >
          <IconZoomOut size={16} />
        </button>
        <ZoomInput scale={scale} onCommit={setScale} min={0.2} max={4} />
        <button
          className="lr-icon-button"
          title={t('reader.zoomIn')}
          onClick={() => setScale((value) => clampZoom(value + 0.1, 0.2, 4))}
        >
          <IconZoomIn size={16} />
        </button>
        <button
          className="lr-icon-button"
          title={t('reader.zoomFitWidth')}
          data-active={false}
          onClick={fitWidth}
        >
          <IconFitWidth size={16} />
        </button>
        <button className="lr-icon-button" title={t('reader.zoomActual')} onClick={() => setScale(1)}>
          <IconActualSize size={16} />
        </button>
        <div className="lr-reader__toolbar-divider" />
        <label className="lr-reader__toolbar-meta">
          <input type="checkbox" checked={showFormulas} onChange={(event) => setShowFormulas(event.target.checked)} /> {t('reader.sheet.formulas')}
        </label>
        <div className="lr-reader__toolbar-spacer" />
        <span className="lr-reader__toolbar-meta">
          {sheet.name} · {sheet.rowCount} × {sheet.columnCount}
        </span>
      </div>
      <div
        className="lr-reader__viewport lr-scroll lr-sheet-viewport"
        ref={scrollRef}
        onScroll={handleScroll}
      >
        <table ref={tableRef} className="lr-sheet" style={{ zoom: scale }}>
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
            {/* 上方占位用**未缩放**高度：zoom 会把它放大回窗口顶端该在的位置 */}
            {sheetWindow.padTop > 0 && (
              <tr aria-hidden="true">
                <td
                  className="lr-sheet__spacer"
                  colSpan={sheet.columnCount + 1}
                  style={{ height: sheetWindow.padTop }}
                />
              </tr>
            )}
            {Array.from({ length: sheetWindow.end - sheetWindow.start }, (_, offset) => {
              const row = sheetWindow.start + offset
              return (
                <SheetRow
                  key={row}
                  row={row}
                  values={(showFormulas ? sheet.formulas[row] : sheet.rows[row]) ?? EMPTY_ROW}
                  columnCount={sheet.columnCount}
                  activeRow={activeCell?.row === row}
                  activeColumn={activeCell?.column ?? null}
                  onSelect={selectCell}
                />
              )
            })}
            {sheetWindow.padBottom > 0 && (
              <tr aria-hidden="true">
                <td
                  className="lr-sheet__spacer"
                  colSpan={sheet.columnCount + 1}
                  style={{ height: sheetWindow.padBottom }}
                />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
