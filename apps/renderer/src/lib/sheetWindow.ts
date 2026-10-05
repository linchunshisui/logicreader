/**
 * 表格视图的窗口计算（纯函数，可单测）。
 *
 * 为什么单独抽出来：`SheetReaderView` 的表格带 `zoom: scale`（CSS zoom 会缩放子树里的
 * 所有 CSS 长度）。于是同一份几何有**两套坐标**：
 *
 *   · 滚动容器坐标（`scrollTop` / `scrollHeight` / 行偏移）—— 内容已被 zoom 放大；
 *   · 表格内部坐标（`<td height>` 等 CSS 长度）—— 还要再乘一次 zoom 才是容器尺寸。
 *
 * 混用这两套坐标的典型症状是"滚到底时行号对不上 / 滚动条长度不对"，而且不报错。
 * 所以这里**只收未缩放的行高 + scale**，两套坐标的换算在函数内部做完：
 *   - `computeSheetWindow`  行号换算用容器坐标，两段占位高度用表格内部坐标；
 *   - `rowScrollOffset`     返回容器坐标，供"跳到第 N 行"设置 scrollTop。
 *
 * 行高统一的前提：`.lr-sheet` 是 `white-space: nowrap`，单元格只有一个文字行，
 * 内容再多也只 `text-overflow: ellipsis`。所以窗口可以用固定行高算，不必逐行测量。
 */

/** 行高兜底值（**未缩放**，CSS px）。真值由视图从已渲染的行上量出来。 */
export const DEFAULT_ROW_HEIGHT = 22

/** 视口外多渲几行，滚起来才不会露白。 */
export const SHEET_OVERSCAN = 12

export interface SheetWindow {
  /** 起始行（含） */
  start: number
  /** 结束行（不含） */
  end: number
  /** 上方占位高度（**表格内部**坐标：未缩放），直接用作占位行的 CSS height */
  padTop: number
  /** 下方占位高度（同上） */
  padBottom: number
}

export interface SheetWindowInput {
  /** 滚动容器的 scrollTop（**容器**坐标） */
  scrollTop: number
  /** 滚动容器的可视高度（**容器**坐标） */
  viewportHeight: number
  /** 单行高度（**未缩放** CSS px） */
  rowHeight: number
  /** 表格当前的 CSS zoom 倍率 */
  scale: number
  /** 总行数 */
  totalRows: number
  overscan?: number
}

export function computeSheetWindow(input: SheetWindowInput): SheetWindow {
  const totalRows = Math.max(0, Math.floor(input.totalRows))
  if (totalRows === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 }

  const rowHeight = input.rowHeight > 0 ? input.rowHeight : DEFAULT_ROW_HEIGHT
  const zoom = input.scale > 0 && Number.isFinite(input.scale) ? input.scale : 1
  // 行号换算必须用**容器**坐标：容器里每行占 rowHeight × zoom
  const containerRowHeight = rowHeight * zoom
  const overscan = Math.max(0, Math.floor(input.overscan ?? SHEET_OVERSCAN))

  const first = Math.floor(Math.max(0, input.scrollTop) / containerRowHeight)
  const visible = Math.ceil(Math.max(0, input.viewportHeight) / containerRowHeight) + 1

  const start = Math.max(0, Math.min(first, totalRows - 1) - overscan)
  const end = Math.min(totalRows, first + visible + overscan)
  // 占位高度用**表格内部**坐标：zoom 会把它再放大一次，正好等于 start 行在容器里占的高度
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: (totalRows - end) * rowHeight
  }
}

/**
 * 某一行在滚动容器里的偏移量（**容器**坐标），用于"跳到第 N 行"。
 *
 * 与 `computeSheetWindow` 的分工：窗口算的是"我该渲染哪几行"（表格内部坐标），
 * 这里算的是"容器该滚到哪"（容器坐标）。跳转必须先滚过去，行才进入窗口、才会出现在 DOM 里。
 */
export function rowScrollOffset(row: number, rowHeight: number, scale: number): number {
  const height = rowHeight > 0 ? rowHeight : DEFAULT_ROW_HEIGHT
  const zoom = scale > 0 && Number.isFinite(scale) ? scale : 1
  return Math.max(0, Math.floor(row)) * height * zoom
}
