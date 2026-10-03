/**
 * 文本层几何诊断（阅读器工具栏的 🔬 按钮，或命令面板"诊断：文本层几何"）。
 *
 * 官方 TextLayer 把位置写成**百分比**（`left: 11.85%`），字号由 CSS 变量算出。
 * 所以这里同时给出两种"应有值"，用来区分两类问题：
 *   · 百分比版（官方同款）：`left% × 视口宽` 应等于 `domLeft`
 *   · 像素版（矢量几何）：`item.rect.x × 页宽 × 缩放` 也应接近 `domLeft`
 * 两者都偏 → 容器尺寸/基准错；只有像素版偏 → 官方算法与实际排版不一致（可接受）。
 */
import { useDocuments } from '../state/documents.store'
import { getPdfLayout } from './pdfjs'

export interface SpanDelta {
  text: string
  charStart: number
  domLeft: number
  domTop: number
  domWidth: number
  domHeight: number
  cssLeft: string
  cssTop: string
  cssFontSize: string
  computedFontSize: string
  /** 官方窗口：由百分比换算出的像素位置 */
  pctLeft: number
  pctTop: number
  /** 矢量窗口：由 item.rect 换算出的像素位置 */
  vecLeft: number
  vecTop: number
}

export interface PageGeometryReport {
  page: number
  hostWidth: number
  hostHeight: number
  layerWidth: number
  layerHeight: number
  scaleFactorVar: string
  totalScaleVar: string
  spanCount: number
  mappedCount: number
  rows: SpanDelta[]
}

export function collectTextLayerGeometry(limit = 2): PageGeometryReport[] {
  const domDocId =
    document.querySelector<HTMLElement>('.lr-pdf-page')?.closest('[data-doc-id]')?.getAttribute('data-doc-id') ?? ''
  const models = useDocuments.getState().models
  const docId = domDocId || (Object.keys(models).find((id) => models[id]?.format === 'pdf') ?? '')
  const layout = getPdfLayout(docId)
  const pages = Array.from(document.querySelectorAll<HTMLElement>('.lr-pdf-page')).slice(0, limit)
  const reports: PageGeometryReport[] = []

  for (const page of pages) {
    const pageNumber = Number(page.dataset.page ?? 0)
    const host = page.getBoundingClientRect()
    const layer = page.querySelector<HTMLElement>('.textLayer')
    const layerRect = layer?.getBoundingClientRect()
    const baseWidth = layout?.pageSizes[pageNumber - 1]?.width ?? 0
    const baseHeight = layout?.pageSizes[pageNumber - 1]?.height ?? 0
    const scale = baseWidth > 0 ? host.width / baseWidth : 0
    const items = layout?.pages.get(pageNumber)?.items ?? []
    const spans = Array.from(layer?.querySelectorAll<HTMLElement>('span[data-char-start]') ?? [])

    const rows: SpanDelta[] = []
    for (let i = 0; i < spans.length && i < 12; i += 1) {
      const span = spans[i]
      const rect = span.getBoundingClientRect()
      const style = getComputedStyle(span)
      const pctLeft = (parseFloat(span.style.left || '0') / 100) * host.width
      const pctTop = (parseFloat(span.style.top || '0') / 100) * host.height
      const item = items[i]
      rows.push({
        text: (span.textContent ?? '').slice(0, 14),
        charStart: Number(span.dataset.charStart),
        domLeft: Math.round(rect.left - host.left),
        domTop: Math.round(rect.top - host.top),
        domWidth: Math.round(rect.width),
        domHeight: Math.round(rect.height),
        cssLeft: span.style.left,
        cssTop: span.style.top,
        cssFontSize: span.style.fontSize || '(未内联)',
        computedFontSize: style.fontSize,
        pctLeft: Math.round(pctLeft),
        pctTop: Math.round(pctTop),
        vecLeft: item ? Math.round(item.rect.x * baseWidth * scale) : -1,
        vecTop: item ? Math.round(item.rect.y * baseHeight * scale) : -1
      })
    }

    reports.push({
      page: pageNumber,
      hostWidth: Math.round(host.width),
      hostHeight: Math.round(host.height),
      layerWidth: Math.round(layerRect?.width ?? 0),
      layerHeight: Math.round(layerRect?.height ?? 0),
      scaleFactorVar: layer ? getComputedStyle(layer).getPropertyValue('--scale-factor').trim() : '',
      totalScaleVar: layer ? getComputedStyle(layer).getPropertyValue('--total-scale-factor').trim() : '',
      spanCount: layer?.querySelectorAll('span').length ?? 0,
      mappedCount: spans.length,
      rows
    })
  }
  return reports
}

/** 写入应用日志 */
export async function dumpTextLayerGeometry(): Promise<void> {
  const api = (globalThis as { logicreader?: { log: { write: (...args: unknown[]) => Promise<void> } } }).logicreader
  const report = collectTextLayerGeometry()
  const status = document.querySelector('.lr-statusbar')?.textContent ?? ''
  await api?.log.write(
    'info',
    'reader',
    'LAYER_GEOMETRY ' + JSON.stringify({ status: status.slice(-80), pages: report })
  )
}
