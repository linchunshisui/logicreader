import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CMD, PERMISSION_MODES } from '@logicreader/shared'
import { useSettings } from './state/settings.store'
import { Workbench } from './workbench/Workbench'
import { CommandPalette } from './workbench/CommandPalette'
import { QuickOpen } from './workbench/QuickOpen'
import { Notifications } from './workbench/Notifications'
import { openGraphTab, registerGlobalCommands } from './commands'
import { installKeybindings } from './keybindings'
import { restoreSession, reportRestoreOutcome, getLastSnapshot } from './state/session'
import { useUiStore } from './state/ui.store'
import { useTabs } from './state/tabs.store'
import { ErrorBoundary } from './workbench/ErrorBoundary'
import { FirstRunWizard } from './views/welcome/FirstRunWizard'

/**
 * 冒烟用：找出一个**确实有关系图**的文档。
 *
 * 会话里常常同时开着好几个文档，而只有一部分生成过关系图 ——
 * 早期版本的冒烟直接用"当前标签的 docId"，一旦活动标签是没生成过图的文档就只能失败，
 * 那是脚本的脆弱，不是产品的结论。
 */
async function findDocumentWithGraph(): Promise<string | null> {
  const { useTabs } = await import('./state/tabs.store')
  const candidates: string[] = []
  const push = (docId: string | undefined): void => {
    if (docId && !candidates.includes(docId)) candidates.push(docId)
  }
  const active = useTabs.getState().activeTab()
  if (active && 'docId' in active) push(active.docId)
  for (const group of useTabs.getState().groups) {
    for (const tab of group.tabs) if ('docId' in tab) push(tab.docId)
  }
  for (const docId of candidates) {
    const summaries = (await window.logicreader.store.graphList(docId)) as { stats?: { nodeCount?: number } }[]
    if (summaries.some((item) => (item.stats?.nodeCount ?? 0) > 0)) return docId
  }
  return candidates[0] ?? null
}

export function App(): JSX.Element {
  const { ready } = useSettings()
  const [bootError, setBootError] = useState<string | null>(null)
  const [showWizard, setShowWizard] = useState(false)
  const booted = useRef(false)
  const { t } = useTranslation()

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    const boot = async (): Promise<void> => {
      try {
        await useSettings.getState().init()
        registerGlobalCommands()
        installKeybindings()
        const outcome = await restoreSession()
        if (useTabs.getState().groups.every((group) => group.tabs.length === 0)) {
          useTabs.getState().openTab({ kind: 'welcome', id: 'welcome-1' })
        }
        reportRestoreOutcome(outcome)
        // 首次启动（没有可用快照）时给出四步向导
        if (!outcome.restored) setShowWizard(true)
        if (outcome.restored) {
          const total = outcome.tabs
          useUiStore.getState().setStatusMessage(
            t('notifications.sessionRestored', {
              tabs: total,
              positions: outcome.positions,
              drafts: outcome.drafts
            })
          )
        }
        void getLastSnapshot()
        // 主进程 → 渲染进程：执行命令（也用于冒烟自动化）
        window.logicreader.app.onMenuCommand((payload) => {
          // 支持 "命令:参数" 形式，便于冒烟脚本携带参数
          const rawCommand = payload?.commandId ?? ''
          const [commandId, inlineArg] = rawCommand.split(':')
          const inlineArgs = inlineArg ? { mode: inlineArg, page: Number(inlineArg) || undefined } : {}
          if (commandId === 'smoke.hitTest') {
            void (async () => {
              const page = document.querySelector<HTMLElement>('.lr-pdf-page')
              const span = page?.querySelector<HTMLElement>('.textLayer span')
              const rect = span?.getBoundingClientRect()
              const hit = rect ? document.elementFromPoint(rect.left + 2, rect.top + rect.height / 2) : null
              const spans = Array.from(page?.querySelectorAll<HTMLElement>('.textLayer span') ?? []).slice(0, 4)
              const sample = spans.map((item) => ({
                text: (item.textContent ?? '').slice(0, 12),
                blockId: item.dataset.blockId ?? null,
                charStart: item.dataset.charStart ?? null,
                left: item.style.left,
                top: item.style.top
              }))
              await window.logicreader.log.write('info', 'smoke', 'spanSample: ' + JSON.stringify(sample))
              await window.logicreader.log.write(
                'info',
                'smoke',
                'hitTest: tag=' + String(hit?.tagName ?? 'null') + ' class=' + String((hit as HTMLElement | null)?.className ?? '') + ' isSpan=' + String(hit?.tagName === 'SPAN')
              )
            })()
            return
          }
          if (commandId === 'smoke.highlight') {
            void (async () => {
              // 高亮标注已按产品决定下线（入口 / 渲染 / 命令一起关，见 避坑指南 §4.3.2.2）：
              // 这里若照旧创建标注，落库了却永远不会渲染，下面的审计必然报 MISMATCH。
              await window.logicreader.log.write('info', 'smoke', '高亮标注已下线（产品决定），跳过创建')
            })()
            return
          }
          if (commandId === 'smoke.auditAnchor') {
            void (async () => {
              const { useDocuments } = await import('./state/documents.store')
              const { useTabs } = await import('./state/tabs.store')
              const tab = useTabs.getState().activeTab()
              const model = tab && 'docId' in tab ? useDocuments.getState().models[tab.docId] : undefined
              if (!model) return
              const records = await window.logicreader.store.listAnchors(model.docId)
              const last = records[records.length - 1]
              if (!last) {
                await window.logicreader.log.write('warn', 'smoke', 'auditAnchor: 没有锚点')
                return
              }
              const primary = JSON.parse(last.primaryJson) as { fragments?: { start: number; end: number }[] }
              const fragments = primary.fragments ?? []
              const squash = (value: string): string => value.replace(/\s+/g, '')
              const fromFragments = squash(fragments.map((f) => model.text.slice(f.start, f.end)).join(''))
              const fromQuote = squash(last.quote ?? '')
              const selection = window.getSelection()
              const domText = squash(selection ? selection.toString() : '')
              const ok = fragments.length > 0 && fromFragments === fromQuote && (domText.length === 0 || fromQuote === domText)
              await window.logicreader.log.write(
                ok ? 'info' : 'error',
                'smoke',
                (ok ? 'ANCHOR_EXACT ' : 'ANCHOR_INEXACT ') +
                  JSON.stringify({
                    fragments: fragments.length,
                    chars: fromFragments.length,
                    quoteChars: fromQuote.length,
                    domChars: domText.length,
                    span: [last.charStart, last.charEnd],
                    head: fromQuote.slice(0, 40)
                  })
              )
            })()
            return
          }
          if (commandId === 'smoke.auditHighlight') {
            void (async () => {
              const selection = window.getSelection()
              if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
                await window.logicreader.log.write('warn', 'smoke', 'auditHighlight: 无选区')
                return
              }
              const range = selection.getRangeAt(0)
              const startEl =
                range.startContainer instanceof HTMLElement
                  ? range.startContainer
                  : range.startContainer.parentElement
              const pageEl = startEl?.closest<HTMLElement>('.lr-pdf-page')
              if (!pageEl) {
                await window.logicreader.log.write('warn', 'smoke', 'auditHighlight: 找不到页面元素')
                return
              }
              const host = pageEl.getBoundingClientRect()
              const union = (rects: DOMRect[]): { x: number; y: number; w: number; h: number } | null => {
                const valid = rects.filter((r) => r.width > 0 && r.height > 0)
                if (valid.length === 0) return null
                const left = Math.min(...valid.map((r) => r.left))
                const top = Math.min(...valid.map((r) => r.top))
                const right = Math.max(...valid.map((r) => r.right))
                const bottom = Math.max(...valid.map((r) => r.bottom))
                return { x: left - host.left, y: top - host.top, w: right - left, h: bottom - top }
              }
              const want = union(Array.from(range.getClientRects()))
              const marks = Array.from(
                pageEl.querySelectorAll<HTMLElement>('.lr-pdf-annotation[data-kind="highlight"]')
              )
              if (marks.length === 0) {
                // 没有可审计的盒子就如实说明原因，别报成 HIGHLIGHT_MISMATCH ——
                // 那会在验证矩阵里留一条永远为红的假失败（高亮已下线，见 避坑指南 §4.3.2.2）。
                await window.logicreader.log.write('info', 'smoke', 'auditHighlight 跳过：高亮标注已下线')
                return
              }
              const got = union(marks.map((mark) => mark.getBoundingClientRect()))
              const overlap = (a: typeof want, b: typeof got): number => {
                if (!a || !b) return 0
                const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
                const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
                const inter = ix * iy
                const unionArea = a.w * a.h + b.w * b.h - inter
                return unionArea > 0 ? inter / unionArea : 0
              }
              const iou = overlap(want, got)
              await window.logicreader.log.write(
                iou >= 0.5 ? 'info' : 'error',
                'smoke',
                (iou >= 0.5 ? 'HIGHLIGHT_MATCH ' : 'HIGHLIGHT_MISMATCH ') +
                  JSON.stringify({
                    iou: Number(iou.toFixed(3)),
                    want: want && { x: Math.round(want.x), y: Math.round(want.y), w: Math.round(want.w), h: Math.round(want.h) },
                    got: got && { x: Math.round(got.x), y: Math.round(got.y), w: Math.round(got.w), h: Math.round(got.h) },
                    pageH: Math.round(host.height),
                    marks: marks.length
                  })
              )
            })()
            return
          }
          if (commandId === 'smoke.auditMapping') {
            void (async () => {
              const { useDocuments } = await import('./state/documents.store')
              const { useTabs } = await import('./state/tabs.store')
              const tab = useTabs.getState().activeTab()
              const model = tab && 'docId' in tab ? useDocuments.getState().models[tab.docId] : undefined
              if (!model) {
                await window.logicreader.log.write('warn', 'smoke', 'auditMapping: 无模型')
                return
              }
              const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim()
              const spans = Array.from(
                document.querySelectorAll<HTMLElement>('.lr-pdf-page .textLayer span[data-char-start]')
              )
              let ok = 0
              let bad = 0
              const samples: unknown[] = []
              for (const span of spans) {
                const text = span.textContent ?? ''
                if (text.trim().length === 0) continue
                const from = Number(span.dataset.charStart)
                const actual = model.text.slice(from, from + text.length)
                if (collapse(actual) === collapse(text)) ok += 1
                else {
                  bad += 1
                  if (samples.length < 3) {
                    samples.push({
                      from,
                      blockId: span.dataset.blockId,
                      want: collapse(text).slice(0, 26),
                      got: collapse(actual).slice(0, 26)
                    })
                  }
                }
              }
              await window.logicreader.log.write(
                bad === 0 ? 'info' : 'error',
                'smoke',
                'MAPPING_AUDIT ok=' + ok + ' bad=' + bad + ' ' + JSON.stringify(samples)
              )
            })()
            return
          }
          if (commandId === 'smoke.verifySelection') {
            void (async () => {
              const { useUiStore } = await import('./state/ui.store')
              const { useDocuments } = await import('./state/documents.store')
              const picked = useUiStore.getState().selection
              if (!picked) {
                await window.logicreader.log.write('warn', 'smoke', 'verifySelection: 没有选区状态')
                return
              }
              const model = useDocuments.getState().models[picked.docId]
              if (!model) {
                await window.logicreader.log.write('warn', 'smoke', 'verifySelection: 模型未加载')
                return
              }
              const norm = (value: string): string => value.replace(/\s+/g, ' ').trim()
              // 位置正确性的判据：忽略一切空白后逐字相同。
              // 文档模型用 '\n' 表示换行，而 DOM 选区文本在行末通常没有分隔符，
              // 直接比较字符串会在每个换行处误报。
              const squash = (value: string): string => value.replace(/\s+/g, '')
              const expected = squash(picked.text)
              const actual = squash(model.text.slice(picked.charStart, picked.charEnd))
              // 判据：选中的文字必须是记录区间的（忽略空白的）子序列。
              // 图表/多栏页面上 pdf.js 的文本项顺序与模型行序可能交错，
              // 此时记录区间是"覆盖选区的最小并集"，会比选区本身多出交错内容 ——
              // 这是正确行为（引用文本仍是用户实际选中的原文，用于锚点重定位）。
              const isSubsequence = (needle: string, haystack: string): boolean => {
                let i = 0
                for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
                  if (needle[i] === haystack[j]) i += 1
                }
                return i === needle.length
              }
              // 判据：选中的文字必须是记录区间的（忽略空白的）子序列，
              // 且区间长度不能明显超出选区（允许 25% 的换行/交错余量）。
              // 只做子序列判断会放过"覆盖了很远内容"的假阳性 —— 本次就踩过。
              const ratio = expected.length > 0 ? actual.length / expected.length : 0
              const ok = expected.length > 0 && isSubsequence(expected, actual) && ratio <= 1.25
              // 诊断：真实位置 vs 记录位置
              const probe = norm(picked.text).slice(0, 30)
              const trueIndex = probe.length > 10 ? model.text.replace(/\s+/g, ' ').indexOf(probe) : -1
              const collapsedPrefix = norm(model.text.slice(0, picked.charStart)).length
              const startSpan = Array.from(
                document.querySelectorAll<HTMLElement>('.lr-pdf-page .textLayer span[data-char-start]')
              ).find((span) => Number(span.dataset.charStart) === picked.charStart)
              await window.logicreader.log.write(
                'info',
                'smoke',
                'SELECTION_PROBE ' +
                  JSON.stringify({
                    charStart: picked.charStart,
                    charEnd: picked.charEnd,
                    domLen: picked.text.length,
                    rawSliceLen: picked.charEnd - picked.charStart,
                    trueCollapsedIndex: trueIndex,
                    recordedCollapsedIndex: collapsedPrefix,
                    delta: trueIndex - collapsedPrefix,
                    startSpanText: (startSpan?.textContent ?? '(未找到该偏移的 span)').slice(0, 24),
                    startSpanBlock: startSpan?.dataset.blockId ?? null,
                    domHead: norm(picked.text).slice(0, 24),
                    modelHead: actual.slice(0, 24)
                  })
              )
              await window.logicreader.log.write(
                ok ? 'info' : 'error',
                'smoke',
                (ok ? 'SELECTION_MATCH ' : 'SELECTION_MISMATCH ') +
                  JSON.stringify({
                    zoom: document.querySelector('.lr-statusbar')?.textContent?.match(/\d+%/)?.[0] ?? '?',
                    len: expected.length,
                    expected: expected.slice(0, 48),
                    actual: actual.slice(0, 48)
                  })
              )
            })()
            return
          }
          if (commandId === 'smoke.layerProbe') {
            void (async () => {
              const pages = Array.from(document.querySelectorAll<HTMLElement>('.lr-pdf-page')).slice(0, 3)
              const report: unknown[] = []
              for (const page of pages) {
                const pageNumber = Number(page.dataset.page ?? 0)
                const host = page.getBoundingClientRect()
                const layer = page.querySelector<HTMLElement>('.textLayer')
                if (!layer) {
                  report.push({ page: pageNumber, error: 'no textLayer' })
                  continue
                }
                const layerRect = layer.getBoundingClientRect()
                const spans = Array.from(layer.querySelectorAll<HTMLElement>('span[data-char-start]')).slice(0, 12)
                const rows = spans.map((span) => {
                  const rect = span.getBoundingClientRect()
                  const charStart = Number(span.dataset.charStart)
                  return {
                    text: (span.textContent ?? '').slice(0, 14),
                    charStart,
                    // 相对页面容器
                    domLeft: Math.round(rect.left - host.left),
                    domTop: Math.round(rect.top - host.top),
                    domWidth: Math.round(rect.width),
                    domHeight: Math.round(rect.height),
                    cssLeft: span.style.left,
                    cssTop: span.style.top,
                    cssFont: span.style.fontSize,
                    computedFont: getComputedStyle(span).fontSize,
                    targetWidth: span.dataset.targetWidth
                  }
                })
                report.push({
                  page: pageNumber,
                  hostSize: { w: Math.round(host.width), h: Math.round(host.height) },
                  layerSize: { w: Math.round(layerRect.width), h: Math.round(layerRect.height) },
                  layerOffset: { x: Math.round(layerRect.left - host.left), y: Math.round(layerRect.top - host.top) },
                  canvasSize: (() => {
                    const canvas = page.querySelector('canvas')
                    const rect = canvas?.getBoundingClientRect()
                    return rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null
                  })(),
                  spanCount: layer.querySelectorAll('span').length,
                  rows
                })
              }
              await window.logicreader.log.write('info', 'smoke', 'LAYER_PROBE ' + JSON.stringify(report))
            })()
            return
          }
          if (commandId === 'smoke.readerProbe') {
            void (async () => {
              const { useUiStore } = await import('./state/ui.store')
              const { useDocuments } = await import('./state/documents.store')
              const { useTabs } = await import('./state/tabs.store')
              const tab = useTabs.getState().activeTab()
              const model = tab && 'docId' in tab ? useDocuments.getState().models[tab.docId] : undefined
              const container = document.querySelector<HTMLElement>('.lr-reader__viewport, .lr-pdf-scroll')
              const spans = Array.from(container?.querySelectorAll<HTMLElement>('[data-char-start]') ?? [])
              const mapped = spans.filter((element) => Number.isFinite(Number(element.dataset.charStart))).length
              const first = spans.find((element) => (element.textContent ?? '').trim().length > 12)
              let selected: { start: number; end: number; text: string } | null = null
              if (first && container) {
                const length = (first.textContent ?? '').length
                const range = document.createRange()
                range.setStart(first.firstChild ?? first, 0)
                range.setEnd(first.firstChild ?? first, Math.min(length, 40))
                const native = window.getSelection()
                native?.removeAllRanges()
                native?.addRange(range)
                await new Promise((resolve) => setTimeout(resolve, 400))
                const picked = useUiStore.getState().selection
                if (picked) selected = { start: picked.charStart, end: picked.charEnd, text: picked.text.slice(0, 30) }
              }
              const picked = useUiStore.getState().selection
              const slice = picked && model ? model.text.slice(picked.charStart, picked.charEnd) : ''
              const squash = (value: string): string => value.replace(/\s+/g, '')
              const ok =
                Boolean(picked) &&
                Boolean(model) &&
                squash(picked?.text ?? '').length > 0 &&
                squash(slice).startsWith(squash((picked?.text ?? '').slice(0, 20)))
              await window.logicreader.log.write(
                ok ? 'info' : 'error',
                'smoke',
                (ok ? 'READER_SELECTION_OK ' : 'READER_SELECTION_FAIL ') +
                  JSON.stringify({
                    kind: tab && 'kind' in tab ? tab.kind : '?',
                    modelChars: model?.text.length ?? -1,
                    mappedSpans: mapped,
                    totalSpans: spans.length,
                    selected,
                    toolbar: Boolean(document.querySelector('.lr-selection-toolbar')),
                    sliceHead: slice.slice(0, 30)
                  })
              )
            })()
            return
          }
          if (commandId === 'smoke.mapProbe') {
            void (async () => {
              const pageNumber = Number(inlineArgs.page ?? 2)
              const { useDocuments } = await import('./state/documents.store')
              const { useTabs } = await import('./state/tabs.store')
              const { hashDocumentText, persistedPageMapping, offsetsMatchModelText } = await import('./lib/textLayerMapping')
              const tab = useTabs.getState().activeTab()
              const model = tab && 'docId' in tab ? useDocuments.getState().models[tab.docId] : undefined
              if (!model) {
                await window.logicreader.log.write('warn', 'smoke', 'mapProbe: 无模型')
                return
              }
              const mapping = persistedPageMapping(model, pageNumber)
              /**
               * 只取"有文字的叶子 span"：pdf.js 会把 beginMarkedContent 渲染成额外的容器 span，
               * 它们没有文字、也不对应任何文本项，掺进来就会让下标整体错位。
               */
              // 与产品一致：只算"已写入定位属性"的 span（纯空白项不参与映射）
              const span = Array.from(
                document.querySelectorAll<HTMLElement>(
                  '.lr-pdf-page[data-page="' + pageNumber + '"] .textLayer > span[data-char-start]'
                )
              )
              const strings = span.map((element) => element.textContent ?? '')
              const head = mapping
                ? strings.slice(0, 4).map((text, index) => ({
                    i: index,
                    off: mapping.offsets[index],
                    len: mapping.lengths[index],
                    dom: text.slice(0, 18),
                    model: model.text.slice(mapping.offsets[index], mapping.offsets[index] + (mapping.lengths[index] ?? 0)).slice(0, 18)
                  }))
                : []
              const withDom = mapping
                ? offsetsMatchModelText(model.text, mapping.offsets, strings, mapping.lengths)
                : { checked: -1, matched: -1 }
              const domTypes = span.map((element) => ({
                tag: element.tagName,
                cls: element.className,
                len: (element.textContent ?? '').length,
                hasOff: Boolean(element.dataset.charStart)
              }))
              await window.logicreader.log.write(
                'info',
                'smoke',
                'MAP_PROBE ' +
                  JSON.stringify({
                    page: pageNumber,
                    modelChars: model.text.length,
                    modelHash: hashDocumentText(model.text),
                    modelMeta: (model.meta as { textLayerMapping?: { textHash?: string; textLength?: number; version?: number } }).textLayerMapping
                      ? {
                          version: (model.meta as { textLayerMapping: { version?: number } }).textLayerMapping.version,
                          textHash: (model.meta as { textLayerMapping: { textHash?: string } }).textLayerMapping.textHash,
                          textLength: (model.meta as { textLayerMapping: { textLength?: number } }).textLayerMapping.textLength
                        }
                      : null,
                    hasMapping: Boolean(mapping),
                    domSpans: strings.length,
                    mapLen: mapping?.offsets.length ?? -1,
                    check: withDom,
                    head,
                    emptyDom: domTypes.filter((item) => item.len === 0).length,
                    marked: domTypes.filter((item) => item.cls.includes('markedContent')).length,
                    tail: domTypes.slice(-3)
                  })
              )
            })()
            return
          }
          if (commandId === 'smoke.mapCoverage') {
            void (async () => {
              const pages = Array.from(document.querySelectorAll<HTMLElement>('.lr-pdf-page'))
              const rows = pages.map((page) => {
                const spans = Array.from(page.querySelectorAll<HTMLElement>('.textLayer span'))
                let mapped = 0
                let skipped = 0
                for (const span of spans) {
                  if (span.dataset.charStart) mapped += 1
                  else if ((span.textContent ?? '').trim().length > 0) skipped += 1
                }
                return { page: page.dataset.page ?? '?', spans: spans.length, mapped, skipped }
              })
              const totalSpans = rows.reduce((sum, row) => sum + row.spans, 0)
              const totalMapped = rows.reduce((sum, row) => sum + row.mapped, 0)
              const totalSkipped = rows.reduce((sum, row) => sum + row.skipped, 0)
              await window.logicreader.log.write(
                totalSkipped === 0 && totalMapped > 0 ? 'info' : 'error',
                'smoke',
                (totalSkipped === 0 && totalMapped > 0 ? 'MAP_COVERAGE_OK ' : 'MAP_COVERAGE_GAP ') +
                  JSON.stringify({ pages: rows.length, totalSpans, totalMapped, totalSkipped, detail: rows.slice(0, 6) })
              )
            })()
            return
          }
          if (commandId === 'smoke.view') {
            void (async () => {
              const { activeReader } = await import('./state/readerBridge')
              const mode = String(inlineArgs.mode ?? 'continuous') as 'single' | 'continuous'
              activeReader()?.setViewMode(mode)
              await window.logicreader.log.write('info', 'smoke', 'viewMode -> ' + mode)
            })()
            return
          }
          if (commandId === 'smoke.zoom') {
            void (async () => {
              const { activeReader } = await import('./state/readerBridge')
              const controller = activeReader()
              const mode = String((payload.args as { mode?: string } | undefined)?.mode ?? inlineArgs.mode ?? 'fit-width')
              const percent = Number(mode)
              if (Number.isFinite(percent) && percent > 0) controller?.setZoom(percent / 100)
              else if (mode === 'in') controller?.zoomIn()
              else if (mode === 'out') controller?.zoomOut()
              else if (mode === 'actual') controller?.zoomActual()
              else controller?.zoomFitWidth()
              await window.logicreader.log.write('info', 'smoke', 'zoom -> ' + mode)
            })()
            return
          }
          /**
           * "适应宽度/适应页面 + 旋转"不许把容器越撑越大。
           *
           * 这是**布局级**的回归闸门：fit-width 的 scale 来自 `.lr-pdf-scroll.clientWidth`，
           * 只要这条容器链里有一层被内容撑开，就会变成正反馈（旋转 → 页面变宽 → 容器变宽 →
           * scale 变大 → 页面更宽 …），一路涨到 Chromium 的 2^25 px 上限。
           * 纯函数单测测不到它（是 CSS/flex 的事），所以闸门只能坐在真实 DOM 上。
           * 判据：旋转两圈之后，容器宽度与 fit 刚完成时**一致**（±2px），且缩放倍率没有失控。
           */
          if (commandId === 'smoke.pdfZoomRotate') {
            void (async () => {
              const log = window.logicreader.log
              const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
              const { activeReader } = await import('./state/readerBridge')
              const controller = activeReader()
              if (!controller) {
                await log.write('info', 'smoke', 'PDF_ZOOM_ROTATE_SKIP 当前没有 PDF 阅读器')
                return
              }
              const widthOf = (): number => document.querySelector<HTMLElement>('.lr-pdf-scroll')?.clientWidth ?? 0
              const percentOf = (): number => Number(document.querySelector<HTMLInputElement>('.lr-zoom-input__field')?.value ?? '0')
              const samples: { step: string; container: number; percent: number }[] = []
              const record = (step: string): void => {
                samples.push({ step, container: widthOf(), percent: percentOf() })
              }
              // 两种 fit 都要试：fit-width 会被"页面比容器宽"触发，fit-page 不该被旋转影响
              for (const fit of ['width', 'page'] as const) {
                if (fit === 'width') controller.zoomFitWidth()
                else controller.zoomFitPage()
                await sleep(1200)
                const baseline = widthOf()
                record('fit-' + fit)
                for (let index = 1; index <= 2; index += 1) {
                  controller.rotate()
                  await sleep(1200)
                  record('fit-' + fit + '-rotate' + index)
                }
                // 转回原角度，免得把用户的阅读角度留在 180°
                controller.rotate()
                controller.rotate()
                await sleep(400)
              }
              const drift = Math.max(...samples.map((item) => Math.abs(item.container - samples[0].container)))
              const runaway = samples.some((item) => item.container > 100_000 || item.percent > 2000)
              const ok = !runaway && drift <= 2
              await log.write(
                ok ? 'info' : 'error',
                'smoke',
                (ok ? 'PDF_ZOOM_ROTATE_OK ' : 'PDF_ZOOM_ROTATE_FAIL ') +
                  JSON.stringify({ drift, runaway, samples })
              )
            })()
            return
          }
          /**
           * 跳转高亮必须**跟着缩放走**（用户反馈："从关系图跳到原文后，高亮区域不随缩放变化"）。
           *
           * 判据不看截图，直接对几何：缩放前后各量一次 ——
           *  ① 高亮矩形要贴在**当前**文本层同一段文字的矩形上（|Δ| ≤ 2px）；
           *  ② 页面确实变大了（否则这条冒烟等于没缩放）。
           * 旧实现把"跳转那一刻"的像素矩形存进阅读器 state，缩放后页面重排而矩形不动，
           * 于是 ② 成立、① 必然失败（Δ 随倍率线性变大）。
           */
          if (commandId === 'smoke.revealZoom') {
            void (async () => {
              const log = window.logicreader.log
              const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
              const { activeReader } = await import('./state/readerBridge')
              const controller = activeReader()
              if (!controller || controller.kind !== 'pdf') {
                await log.write('info', 'smoke', 'REVEAL_ZOOM_SKIP 当前没有 PDF 阅读器')
                return
              }
              const percentOf = (): number =>
                Number(document.querySelector<HTMLInputElement>('.lr-zoom-input__field')?.value ?? '0')
              const zoomBefore = percentOf()
              /** 量"高亮矩形 vs 当前文本层里同一段文字的矩形"（都换算成页内坐标，单位 px） */
              const measure = async (): Promise<{
                pageWidth: number
                dx: number
                dy: number
                dw: number
                dh: number
                startVisible: boolean
                startOffset: number
                centerDelta: number
                viewportHeight: number
                flash: number[]
                text: number[]
              } | null> => {
                const wrapper = document.querySelector<HTMLElement>('.lr-pdf-flash[data-reveal-range]')
                const flash = wrapper?.querySelector<HTMLElement>('.lr-pdf-flash__rect')
                const page = flash?.closest<HTMLElement>('.lr-pdf-page')
                const layer = page?.querySelector<HTMLElement>('.textLayer')
                const applied = wrapper?.dataset.revealRange
                if (!wrapper || !flash || !page || !layer || !applied) return null
                const [start, end] = applied.split('-').map(Number)
                if (!Number.isFinite(start) || !Number.isFinite(end)) return null
                const { rangeForChars } = await import('./lib/selection')
                const textRange = rangeForChars(layer, 'span[data-char-start]', start, end)
                const textRect = textRange?.getClientRects()[0] ?? null
                if (!textRange || !textRect) return null
                const pageRect = page.getBoundingClientRect()
                const flashRect = flash.getBoundingClientRect()
                const toPage = (rect: { left: number; top: number; width: number; height: number }): number[] => [
                  Math.round((rect.left - pageRect.left) * 10) / 10,
                  Math.round((rect.top - pageRect.top) * 10) / 10,
                  Math.round(rect.width * 10) / 10,
                  Math.round(rect.height * 10) / 10
                ]
                const f = toPage(flashRect)
                const t = toPage(textRect)
                /*
                 * 新要求（用户）：缩放时要以这一段为中心，且**开头必须可视**。
                 * 这里量的是"这一段第一个矩形"在滚动视口里的位置：
                 *  startVisible  —— 整个首行矩形都在视口内；
                 *  centerDelta   —— 首行中心离视口中心的距离（越小越居中）。
                 */
                const scroll = document.querySelector<HTMLElement>('.lr-pdf-scroll')
                const scrollRect = scroll?.getBoundingClientRect()
                return {
                  pageWidth: Math.round(pageRect.width),
                  dx: Math.abs(f[0] - t[0]),
                  dy: Math.abs(f[1] - t[1]),
                  dw: Math.abs(f[2] - t[2]),
                  dh: Math.abs(f[3] - t[3]),
                  startVisible: Boolean(
                    scrollRect &&
                      textRect.top >= scrollRect.top - 0.5 &&
                      textRect.bottom <= scrollRect.bottom + 0.5
                  ),
                  startOffset: scrollRect ? Math.round(textRect.top - scrollRect.top) : -1,
                  centerDelta: scrollRect
                    ? Math.round(
                        Math.abs(
                          textRect.top + textRect.height / 2 - (scrollRect.top + scrollRect.height / 2)
                        )
                      )
                    : -1,
                  viewportHeight: scrollRect ? Math.round(scrollRect.height) : 0,
                  flash: f,
                  text: t
                }
              }
              /*
               * 落点取"视口内、带定位偏移"的一个文本 span（扫描页没有偏移，直接跳过）。
               * ★ 优先取第 2 页起：第 1 页页首的段落**没法居中**（滚动位置到顶了），
               * 拿它当锚点，闸门测的是"夹紧后的必然结果"，而不是"有没有对齐"。
               */
              let anchor: { charStart: number; charEnd: number } | null = null
              for (let attempt = 0; attempt < 40 && !anchor; attempt += 1) {
                const host = document.querySelector<HTMLElement>('.lr-pdf-scroll')?.getBoundingClientRect()
                const pages = Array.from(document.querySelectorAll<HTMLElement>('.lr-pdf-page')).sort(
                  (a, b) => Number(b.dataset.page ?? 0) - Number(a.dataset.page ?? 0)
                )
                for (const page of pages) {
                  const box = page.getBoundingClientRect()
                  if (host && (box.bottom < host.top + 80 || box.top > host.bottom - 80)) continue
                  const span = Array.from(
                    page.querySelectorAll<HTMLElement>('.textLayer span[data-char-start]')
                  ).find((item) => (item.textContent ?? '').trim().length > 6)
                  if (!span) continue
                  const from = Number(span.dataset.charStart)
                  const to = Number(span.dataset.charEnd ?? span.dataset.charStart)
                  if (Number.isFinite(from) && Number.isFinite(to) && to > from) anchor = { charStart: from, charEnd: to }
                  break
                }
                if (!anchor) await sleep(150)
              }
              if (!anchor) {
                await log.write('warn', 'smoke', 'REVEAL_ZOOM_SKIP 找不到带偏移的文本 span（可能是扫描页）')
                return
              }
              const { useUiStore } = await import('./state/ui.store')
              useUiStore.getState().requestReveal({
                docId: controller.docId,
                charStart: anchor.charStart,
                charEnd: anchor.charEnd,
                hold: true
              })
              let before: Awaited<ReturnType<typeof measure>> = null
              for (let attempt = 0; attempt < 60 && !before; attempt += 1) {
                await sleep(150)
                before = await measure()
              }
              // 高亮出现 ≠ 滚动停稳（跳转用的是平滑滚动）：等它停稳再量"缩放前"的位置
              if (before) {
                await sleep(900)
                before = await measure()
              }
              if (!before) {
                await log.write('error', 'smoke', 'REVEAL_ZOOM_FAIL 高亮没出现 anchor=' + JSON.stringify(anchor))
                return
              }
              // 放大 1.5 倍（若当前是 fit，同样按"当前有效倍率 × 1.5"落地）
              controller.setZoom(Math.min(4, Math.round((percentOf() / 100) * 150) / 100))
              await sleep(1800)
              let after: Awaited<ReturnType<typeof measure>> = null
              for (let attempt = 0; attempt < 40 && !after; attempt += 1) {
                after = await measure()
                if (!after) await sleep(150)
              }
              // 还原缩放，别把用户的阅读倍率留在 150%
              if (zoomBefore > 0) controller.setZoom(zoomBefore / 100)
              await sleep(400)

              const onText = (probe: NonNullable<Awaited<ReturnType<typeof measure>>>): boolean =>
                probe.dx <= 2 && probe.dy <= 2 && probe.dw <= 3 && probe.dh <= 3
              /** 开头可视 + 基本居中（放不下整段时按"开头对齐顶部"，偏差只要求不超过 1/4 屏） */
              const onAnchor = (probe: NonNullable<Awaited<ReturnType<typeof measure>>>): boolean =>
                probe.startVisible && probe.centerDelta <= Math.max(40, Math.round(probe.viewportHeight * 0.25))
              const grew = after !== null && after.pageWidth > before.pageWidth * 1.05
              const ok =
                after !== null && onText(before) && onText(after) && onAnchor(before) && onAnchor(after) && grew
              await log.write(
                ok ? 'info' : 'error',
                'smoke',
                (ok ? 'REVEAL_ZOOM_OK ' : 'REVEAL_ZOOM_FAIL ') +
                  JSON.stringify({ anchor, grew, before, after, zoomBefore, zoomAfter: percentOf() })
              )
            })()
            return
          }
          /**
           * 「**用户自己选中的文段**」在缩放时同样要居中、开头可视（Markdown / DOCX / 纯文本）。
           *
           * 与 `smoke.revealZoom` 分开的原因：高亮与选区在 `useZoomAnchor` 里是**两条来源**
           * （高亮优先），用同一个命令测不出选区这条路径。这里刻意**不用**定位请求，
           * 只写 store 里的选区，从而保证测的是"用户选中 → 缩放"。
           */
          if (commandId === 'smoke.anchorZoomText') {
            void (async () => {
              const log = window.logicreader.log
              const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
              const { activeReader } = await import('./state/readerBridge')
              const controller = activeReader()
              if (!controller || controller.kind === 'pdf' || controller.kind === 'sheet') {
                await log.write('info', 'smoke', 'ANCHOR_ZOOM_TEXT_SKIP 当前不是可缩放的文本阅读器')
                return
              }
              // `.lr-scroll` 是各区域共用的滚动类（侧边栏/面板也有）—— 必须限定在阅读器里
              const container =
                document.querySelector<HTMLElement>('.lr-reader .lr-scroll') ??
                document.querySelector<HTMLElement>('.lr-scroll')
              const blocks = Array.from(
                container?.querySelectorAll<HTMLElement>(
                  '.lr-prose [data-char-start], .lr-docx-host [data-char-start]'
                ) ?? []
              )
              // 取靠中间的一段：首段/末段没法居中（滚动到顶/到底了），测出来只会是"夹紧的结果"
              const block = blocks[Math.floor(blocks.length / 2)] ?? null
              if (!container || !block) {
                await log.write('info', 'smoke', 'ANCHOR_ZOOM_TEXT_SKIP 找不到带定位的可视文段')
                return
              }
              const percentOf = (): number =>
                Number(document.querySelector<HTMLInputElement>('.lr-zoom-input__field')?.value ?? '0')
              const zoomBefore = percentOf()
              const charStart = Number(block.dataset.charStart)
              const charEnd = Number(block.dataset.charEnd ?? block.dataset.charStart)
              const { useUiStore } = await import('./state/ui.store')
              // 只写选区，不发定位请求 —— 这样锚点来源一定是"用户选区"这条路径
              useUiStore.getState().clearReveal()
              useUiStore.getState().setSelection({
                docId: controller.docId,
                tabId: controller.tabId,
                text: (block.textContent ?? '').slice(0, 40),
                charStart,
                charEnd,
                anchorId: null,
                locationLabel: '',
                rect: null
              })
              block.scrollIntoView({ block: 'center' })
              await sleep(900)
              /** 量"这一段"在滚动视口里的位置与居中程度 */
              const measure = (): { visible: boolean; offset: number; centerDelta: number; viewportHeight: number; rectHeight: number } | null => {
                const element = container.querySelector<HTMLElement>('[data-char-start="' + charStart + '"]')
                if (!element) return null
                const rect = element.getBoundingClientRect()
                const host = container.getBoundingClientRect()
                // 与 lib/zoomAnchor.centerScrollTop 同一把尺子：装得下就居中，装不下就"开头对齐顶部留边"
                const fitted = Math.min(rect.height, Math.max(0, host.height - 24))
                const expectedTop = host.top + Math.max(12, (host.height - fitted) / 2)
                return {
                  visible: rect.top >= host.top - 0.5 && rect.top <= host.bottom - 0.5,
                  offset: Math.round(rect.top - host.top),
                  centerDelta: Math.round(Math.abs(rect.top - expectedTop)),
                  viewportHeight: Math.round(host.height),
                  rectHeight: Math.round(rect.height)
                }
              }
              const before = measure()
              // 一次放大 30%：倍率太小时"漂移"会落在容差里，闸门就失去区分度
              controller.zoomIn()
              controller.zoomIn()
              controller.zoomIn()
              await sleep(1200)
              const after = measure()
              const zoomAfter = percentOf()
              const onAnchor = (probe: ReturnType<typeof measure>): boolean =>
                Boolean(probe) &&
                probe!.visible &&
                probe!.centerDelta <= Math.max(40, Math.round(probe!.viewportHeight * 0.25))
              const grew = zoomAfter !== zoomBefore
              const ok = onAnchor(before) && onAnchor(after) && grew
              // 还原：缩放与选区都恢复，别把用户状态留在冒烟里
              if (zoomBefore > 0) controller.setZoom(zoomBefore / 100)
              useUiStore.getState().setSelection(null)
              await log.write(
                ok ? 'info' : 'error',
                'smoke',
                (ok ? 'ANCHOR_ZOOM_TEXT_OK ' : 'ANCHOR_ZOOM_TEXT_FAIL ') +
                  JSON.stringify({ kind: controller.kind, grew, zoomBefore, zoomAfter, range: [charStart, charEnd], before, after })
              )
            })()
            return
          }
          /**
           * 双页：**并排**两页（不是竖着摆两页）、全篇仍可见、且"适应页面"要能把一对页装进视口。
           *
           * 三条判据对应三句需求，缺一条就会退回旧行为：
           *  ① `pages === total`                 —— 选双页后整篇都在（旧实现只渲染当前那一对）
           *  ② 第 1、2 页 `top` 相同且左右相邻   —— 是"并排"；若换成竖排，`top` 会差一整页高
           *  ③ 一对页的总宽 ≤ 视口宽 − 40        —— 自适应大小确实按"两页"算的
           */
          if (commandId === 'smoke.pdfSpread') {
            void (async () => {
              const log = window.logicreader.log
              const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
              const { activeReader } = await import('./state/readerBridge')
              const controller = activeReader()
              if (!controller) {
                await log.write('info', 'smoke', 'PDF_SPREAD_SKIP 当前没有 PDF 阅读器')
                return
              }
              const previous = document.querySelector<HTMLElement>('.lr-pdf-pages')?.dataset.mode ?? 'continuous'
              controller.setViewMode('spread')
              controller.zoomFitPage()
              await sleep(2200)

              const scroll = document.querySelector<HTMLElement>('.lr-pdf-scroll')
              const nodes = Array.from(document.querySelectorAll<HTMLElement>('.lr-pdf-page'))
              const boxes = nodes
                .map((node) => {
                  const rect = node.getBoundingClientRect()
                  return {
                    page: Number(node.dataset.page ?? 0),
                    top: Math.round(rect.top),
                    left: Math.round(rect.left),
                    right: Math.round(rect.right),
                    width: Math.round(rect.width)
                  }
                })
                .sort((a, b) => a.page - b.page)
              const total = boxes.length
              const first = boxes.find((item) => item.page === 1)
              const second = boxes.find((item) => item.page === 2)
              const third = boxes.find((item) => item.page === 3)
              const rows = new Set(boxes.map((item) => item.top)).size
              const sideBySide = Boolean(first && second && Math.abs(first.top - second.top) <= 2 && second.left >= first.right - 2)
              const nextRowBelow = Boolean(second && third && third.top >= second.top + 100)
              const pairWidth = first && second ? second.right - first.left : 0
              const viewport = scroll ? scroll.clientWidth : 0
              const fits = pairWidth > 0 && viewport > 0 && pairWidth <= viewport - 40
              const allPages = total > 0 && boxes.every((item, index) => item.page === index + 1)

              controller.setViewMode(previous as 'single' | 'continuous' | 'spread')
              await sleep(300)
              const ok = allPages && sideBySide && nextRowBelow && fits
              await log.write(
                ok ? 'info' : 'error',
                'smoke',
                (ok ? 'PDF_SPREAD_OK ' : 'PDF_SPREAD_FAIL ') +
                  JSON.stringify({
                    allPages,
                    sideBySide,
                    nextRowBelow,
                    fits,
                    pages: total,
                    rows,
                    pairWidth,
                    viewport,
                    firstTwo: boxes.slice(0, 3)
                  })
              )
            })()
            return
          }
          if (commandId === 'smoke.gotoPage') {
            void (async () => {
              const page = Number(
                (payload.args as { page?: number } | undefined)?.page ?? (inlineArgs.page || 4)
              )
              const { activeReader } = await import('./state/readerBridge')
              const controller = activeReader()
              await window.logicreader.log.write('info', 'smoke', 'gotoPage controller=' + String(Boolean(controller)) + ' page=' + page)
              controller?.gotoPage(page)
            })()
            return
          }
          if (commandId === 'smoke.selectText') {
            void (async () => {
              // 目标页取"当前可见页"，模拟用户真实所在页面
              const scroll = document.querySelector<HTMLElement>('.lr-pdf-scroll')
              const allPages = Array.from(document.querySelectorAll<HTMLElement>('.lr-pdf-page'))
              const visiblePage = allPages.find((item) => {
                if (!scroll) return true
                const rect = item.getBoundingClientRect()
                const host = scroll.getBoundingClientRect()
                return rect.bottom > host.top + 40 && rect.top < host.bottom - 40
              })
              const page = visiblePage ?? allPages[0] ?? null
              // 只用带定位属性的文本 span（真实用户拖选时端点也总是落在这些 span 的文本节点里）
              const spans = Array.from(
                page?.querySelectorAll<HTMLElement>('.textLayer span[data-char-start]') ?? []
              ).filter((item) => (item.textContent ?? '').trim().length > 0)
              const from = spans[2]
              const to = spans[6] ?? spans[spans.length - 1]
              await window.logicreader.log.write(
                'info',
                'smoke',
                'selectText picks=' +
                  JSON.stringify({
                    total: spans.length,
                    head: spans.slice(0, 8).map((item) => ({
                      t: (item.textContent ?? '').slice(0, 16),
                      o: item.dataset.charStart
                    })),
                    from: { t: (from?.textContent ?? '').slice(0, 20), o: from?.dataset.charStart },
                    to: { t: (to?.textContent ?? '').slice(0, 20), o: to?.dataset.charStart }
                  })
              )
              if (!from || !to) {
                await window.logicreader.log.write('warn', 'smoke', 'selectText: 文本层没有可用 span')
                return
              }
              const range = document.createRange()
              range.setStart(from.firstChild ?? from, 0)
              range.setEnd(to.firstChild ?? to, (to.textContent ?? '').length)
              const selection = window.getSelection()
              selection?.removeAllRanges()
              selection?.addRange(range)
              page?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
              // 等待 React 处理合成事件后再读状态
              await new Promise((resolve) => setTimeout(resolve, 400))
              const { useUiStore } = await import('./state/ui.store')
              const picked = useUiStore.getState().selection
              await window.logicreader.log.write(
                'info',
                'smoke',
                'selectText: "' +
                  range.toString().slice(0, 40) +
                  '" → selection=' +
                  (picked ? JSON.stringify({ start: picked.charStart, end: picked.charEnd, label: picked.locationLabel }) : 'null') +
                  ' toolbar=' +
                  String(Boolean(document.querySelector('.lr-selection-toolbar')))
              )
            })()
            return
          }
          /**
           * 关系图节点跳转的客观断言，按**用户的两步操作**来：
           *   第 1 步：单击节点 —— 只应选中，**不应跳转**（不能被拽到阅读器）；
           *   第 2 步：点检查器里的「跳转」按钮 —— 这时才应跳转，且三件事同时成立：
           *          ① 定位请求区间 == 该节点锚点区间；② 激活的是该文档的阅读器标签；
           *          ③ 目标元素真的带上了高亮类（.lr-pdf-flash__rect / .lr-flash）。
           * 任一条不成立就写 GRAPH_JUMP_FAIL / GRAPH_JUMP_IDLE_FAIL —— 不靠肉眼判断。
           */
          if (commandId === 'smoke.graphJump') {
            void (async () => {
              const log = window.logicreader.log
              const { useTabs } = await import('./state/tabs.store')
              const { useGraph } = await import('./state/graph.store')
              const { useUiStore } = await import('./state/ui.store')
              const waitFor = async <T,>(probe: () => T | null, timeoutMs: number): Promise<T | null> => {
                const deadline = Date.now() + timeoutMs
                let value = probe()
                while (!value && Date.now() < deadline) {
                  await new Promise((resolve) => setTimeout(resolve, 120))
                  value = probe()
                }
                return value
              }
              try {
                const docId = await findDocumentWithGraph()
                if (!docId) {
                  await log.write('error', 'smoke', 'GRAPH_JUMP_FAIL 会话里没有带关系图的文档')
                  return
                }
                const hadReaderTab = useTabs
                  .getState()
                  .groups.some((group) => group.tabs.some((tab) => tab.kind === 'reader' && tab.docId === docId))
                openGraphTab(docId)
                const graph = await waitFor(() => {
                  const data = useGraph.getState().graph
                  return data && data.docId === docId && data.nodes.length > 0 ? data : null
                }, 10000)
                if (!graph) {
                  await log.write('error', 'smoke', 'GRAPH_JUMP_FAIL 关系图未加载 docId=' + docId)
                  return
                }

                /*
                 * ---- 第 0 步：**全局画布上双击一个叶子节点**，必须跳到它的原文 ----
                 * 用户要求"全局图里也支持双击选择"；章节/父节点的双击仍是折叠展开（画布唯一的折叠入口），
                 * 所以这里专门挑一个**叶子**节点来验。双击 = 与右侧小图双击同一个动作。
                 */
                {
                  const parents = new Set(graph.nodes.map((item) => item.parentId).filter(Boolean) as string[])
                  const leaf = graph.nodes.find(
                    (item) =>
                      (item.anchorIds?.length ?? 0) > 0 &&
                      !item.meta?.isSection &&
                      !parents.has(item.id) &&
                      document.querySelector('.react-flow__node[data-id="' + item.id + '"]')
                  )
                  const element = leaf
                    ? document.querySelector<HTMLElement>('.react-flow__node[data-id="' + leaf.id + '"]')
                    : null
                  if (!leaf || !element) {
                    await log.write(
                      'error',
                      'smoke',
                      'GRAPH_CANVAS_DBLCLICK_FAIL ' +
                        JSON.stringify({ reason: '画布上没有可双击的叶子节点', nodes: graph.nodes.length })
                    )
                  } else {
                    const before = useUiStore.getState().revealRequest?.nonce ?? 0
                    element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }))
                    const jumped = await waitFor(() => {
                      const next = useUiStore.getState().revealRequest
                      return next && next.nonce !== before && next.chain?.nodeId === leaf.id ? next : null
                    }, 8000)
                    await log.write(
                      jumped ? 'info' : 'error',
                      'smoke',
                      (jumped ? 'GRAPH_CANVAS_DBLCLICK_OK ' : 'GRAPH_CANVAS_DBLCLICK_FAIL ') +
                        JSON.stringify({
                          node: leaf.id,
                          request: jumped ? [jumped.charStart, jumped.charEnd] : null,
                          requestNode: useUiStore.getState().revealRequest?.chain?.nodeId ?? null
                        })
                    )
                    // 回到关系图标签，继续原有的"单击只选中 / 检查器里才跳转"流程
                    openGraphTab(docId)
                    await new Promise((resolve) => setTimeout(resolve, 700))
                  }
                }

                // 挑"锚点最靠后"的已渲染节点：它一定不在文档开头，能顺带验证滚动是否真的发生
                const nodeElement = await waitFor(() => {
                  let best: HTMLElement | null = null
                  let bestStart = -1
                  for (const element of Array.from(document.querySelectorAll<HTMLElement>('.react-flow__node'))) {
                    const logical = graph.nodes.find((item) => item.id === (element.dataset.id ?? ''))
                    const anchor = logical?.anchors?.[0]
                    if (!anchor) continue
                    if (anchor.charStart > bestStart) {
                      bestStart = anchor.charStart
                      best = element
                    }
                  }
                  return best
                }, 10000)
                if (!nodeElement) {
                  await log.write('error', 'smoke', 'GRAPH_JUMP_FAIL 画布上没有带锚点的节点')
                  return
                }
                const nodeId = nodeElement.dataset.id ?? ''
                const logical = graph.nodes.find((item) => item.id === nodeId)
                const expected = logical?.anchors?.[0]
                if (!logical || !expected) {
                  await log.write('error', 'smoke', 'GRAPH_JUMP_FAIL 节点缺少锚点 ' + nodeId)
                  return
                }
                await log.write(
                  'info',
                  'smoke',
                  'GRAPH_JUMP 选中节点 ' +
                    JSON.stringify({
                      node: nodeId,
                      title: logical.title.slice(0, 24),
                      anchor: [expected.charStart, expected.charEnd],
                      readerTab: hadReaderTab ? 'open' : 'missing'
                    })
                )
                // ---- 第 1 步：单击节点，只应选中、不应跳转 ----
                const requestBefore = useUiStore.getState().revealRequest
                nodeElement.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                await new Promise((resolve) => setTimeout(resolve, 900))
                const afterClickTab = useTabs.getState().activeTab()
                const afterClickRequest = useUiStore.getState().revealRequest
                const stayedPut = afterClickTab?.kind === 'graph' && afterClickRequest === requestBefore
                const selectedNow = useGraph.getState().selectedNodeIds.includes(nodeId)
                await log.write(
                  stayedPut && selectedNow ? 'info' : 'error',
                  'smoke',
                  (stayedPut && selectedNow ? 'GRAPH_JUMP_IDLE_OK ' : 'GRAPH_JUMP_IDLE_FAIL ') +
                    JSON.stringify({ selected: selectedNow, activeTab: afterClickTab?.kind ?? null, newRequest: afterClickRequest !== requestBefore })
                )
                if (!stayedPut || !selectedNow) return

                // ---- 第 2 步：用户显式选择跳转（检查器里的「跳转」按钮） ----
                const jumpButton = document.querySelector<HTMLElement>('.lr-graph__inspector [data-action="jump"]')
                if (!jumpButton) {
                  await log.write('error', 'smoke', 'GRAPH_JUMP_FAIL 检查器里没有「跳转」按钮')
                  return
                }
                const started = Date.now()
                jumpButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                const landed = await waitFor(() => {
                  const request = useUiStore.getState().revealRequest
                  if (!request || request.docId !== docId || request.charStart !== expected.charStart) return null
                  const active = useTabs.getState().activeTab()
                  if (!active || active.kind !== 'reader' || active.docId !== docId) return null
                  const flash = document.querySelector<HTMLElement>('.lr-pdf-flash__rect, .lr-flash, .lr-reveal')
                  return flash ? { flash } : null
                }, 15000)
                const request = useUiStore.getState().revealRequest
                const activeTab = useTabs.getState().activeTab()

                /*
                 * 高亮的三个新要求（用户反馈）：
                 *  ① **不许圈半个词** —— DOM 上的 data-reveal-range 必须等于"收拾过"的区间；
                 *  ② **高亮常驻** —— 等 2.6 秒后高亮还在（旧实现 1.6 秒就没了）；
                 *  ③ **旁边给出相关逻辑链** —— 面板出现在阅读器旁，且指向同一个节点、有相连项。
                 */
                const { expandRevealRange } = await import('@logicreader/document-model')
                const { useDocuments } = await import('./state/documents.store')
                const model = useDocuments.getState().models[docId]
                const snapped = model
                  ? expandRevealRange(model.text, expected.charStart, expected.charEnd)
                  : { charStart: expected.charStart, charEnd: expected.charEnd }
                const expectedRange = snapped.charStart + '-' + snapped.charEnd
                const marked = document.querySelector<HTMLElement>('[data-reveal-range]')
                const appliedRange = marked?.dataset.revealRange ?? null
                const rangeOk = appliedRange === expectedRange
                const rawWasMidWord =
                  snapped.charStart !== expected.charStart || snapped.charEnd !== expected.charEnd

                await new Promise((resolve) => setTimeout(resolve, 2600))
                const holdOk = Boolean(document.querySelector('.lr-pdf-flash__rect, .lr-flash, .lr-reveal'))

                const chain = document.querySelector<HTMLElement>('.lr-chain[data-reveal-node]')
                const chainNodeOk = chain?.dataset.revealNode === nodeId
                const chainRows = chain?.querySelectorAll('.lr-chain__row').length ?? 0
                const chainOk = Boolean(chain) && chainNodeOk && chainRows > 0
                // 局部关系图（面板顶部的"放大图"）：有没有画出来、中心是不是当前节点
                const mapCards = chain?.querySelectorAll('.lr-localmap__card--peer').length ?? 0
                const mapLinks = chain?.querySelectorAll('.lr-localmap__link').length ?? 0
                const mapCenterId = chain?.querySelector<HTMLElement>('.lr-localmap__card--center')?.dataset.centerNode ?? null
                const mapCenterOk = mapCenterId === nodeId

                /* 小图窗口与卡片：悬停预览的两条断言（画出来 / 看得见）都要用 */
                const area = chain?.querySelector<HTMLElement>('.lr-localmap__area')
                const layer = area?.querySelector<SVGGElement>('svg > g')
                const rows = Array.from(chain?.querySelectorAll<HTMLElement>('.lr-chain__row[data-peer-node]') ?? [])
                const hostBox = area?.getBoundingClientRect()
                const cardOf = (peer: string | undefined | null): HTMLElement | null =>
                  peer
                    ? area?.querySelector<HTMLElement>('.lr-localmap__card[data-peer-node="' + peer + '"]') ?? null
                    : null
                const transformOf = (): string | null => layer?.getAttribute('transform') ?? null
                const zoomPercentOf = (): number =>
                  Number(chain?.querySelector<HTMLElement>('.lr-localmap__zoom')?.dataset.zoom ?? '0')

                /*
                 * 跳转过来必须**直接定位到当前节点**（用户要求）：小图不能停在"整张图缩成一小片"，
                 * 要把当前节点居中、并且至少放大到看得清字（READABLE_ZOOM = 90%）。
                 * 判据：缩放 ≥ 90%，且中心卡片中心与窗口中心相差 ≤ 24px。
                 */
                const transformLocated = transformOf()
                const locatedZoom = zoomPercentOf()
                const centerCard = chain?.querySelector<HTMLElement>('.lr-localmap__card--center')
                const centerCardBox = centerCard?.getBoundingClientRect()
                const centerShift = hostBox && centerCardBox
                  ? Math.round(
                      Math.abs(centerCardBox.left + centerCardBox.width / 2 - (hostBox.left + hostBox.width / 2)) +
                        Math.abs(centerCardBox.top + centerCardBox.height / 2 - (hostBox.top + hostBox.height / 2))
                    )
                  : -1
                const mapLocatedOk = locatedZoom >= 90 && centerShift >= 0 && centerShift <= 24

                /*
                 * 悬停预览（用户要求："鼠标位于下面的文字块时，上面的图片提供预览"）：
                 * 鼠标指到下面清单的某一行，上面的小图要把**那一行对应的节点**标出来。
                 * 断言不看截图：行与卡片都带 `data-peer-node`，悬停后必须出现 `data-preview-node` == 该节点；
                 * 移开后必须收起（否则就是"预览粘住了"）。
                 */
                const firstRow = chain?.querySelector<HTMLElement>('.lr-chain__row[data-peer-node]')
                const rowPeerId = firstRow?.dataset.peerNode ?? null
                let hoverPreviewId: string | null = null
                let hoverCleared = false
                /* 预览必须**画出来**：悬停后那张卡片的描边要变粗（同一张卡片前后对比，不看配色变量） */
                let hoverStrokeOk = false
                if (firstRow && rowPeerId) {
                  const boxOf = (peer: string | null): SVGElement | null =>
                    peer ? cardOf(peer)?.querySelector<SVGElement>('.lr-localmap__box') ?? null : null
                  const strokeOf = (element: SVGElement | null): number =>
                    element ? Number.parseFloat(getComputedStyle(element).strokeWidth) || 0 : 0
                  const strokeBefore = strokeOf(boxOf(rowPeerId))
                  firstRow.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }))
                  await new Promise((resolve) => setTimeout(resolve, 260))
                  const previewed = chain?.querySelector<HTMLElement>('.lr-localmap__card--preview')
                  hoverPreviewId = previewed?.dataset.previewNode ?? null
                  hoverStrokeOk = strokeOf(boxOf(rowPeerId)) > strokeBefore
                  firstRow.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true, view: window }))
                  await new Promise((resolve) => setTimeout(resolve, 260))
                  hoverCleared = !chain?.querySelector('.lr-localmap__card--preview')
                }
                const mapHoverOk = Boolean(rowPeerId) && hoverPreviewId === rowPeerId && hoverStrokeOk && hoverCleared

                /*
                 * 预览必须**看得见**：清单里那些当前落在小图窗口外的节点，悬停时小图要把它带进视野
                 * （只平移、不改缩放）。挑一个"卡片当前在窗口外"的行来验：悬停后图层 transform 必须变，
                 * 且那张卡片要落进窗口内。没有这种行时这条不适用（记为 skip，不算失败）。
                 */
                const outsideRowsNow = (): HTMLElement[] =>
                  rows.filter((row) => {
                    const card = cardOf(row.dataset.peerNode)
                    const box = card?.getBoundingClientRect()
                    if (!box || !hostBox) return false
                    return (
                      box.right < hostBox.left || box.left > hostBox.right || box.bottom < hostBox.top || box.top > hostBox.bottom
                    )
                  })
                /*
                 * 先把小图拖走（真交互：pointerdown + pointermove + pointerup，与用户拖动同一条路径），
                 * 让清单里的节点落到窗口外 —— 否则"要不要平移"这条根本不会被触发。
                 */
                if (area && hostBox && outsideRowsNow().length === 0) {
                  const x = hostBox.left + hostBox.width / 2
                  const y = hostBox.top + hostBox.height / 2
                  area.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1 }))
                  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x - 420, clientY: y - 300, pointerId: 1 }))
                  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x - 420, clientY: y - 300, pointerId: 1 }))
                  await new Promise((resolve) => setTimeout(resolve, 260))
                }
                const outside = outsideRowsNow()
                let mapHoverPanOk: boolean | 'skip' = 'skip'
                let panMoved = false
                let panVisible = false
                let mapHoverRestoreOk: boolean | 'skip' = 'skip'
                let hoverRestored = false
                const panRow = outside[0]
                if (panRow && area && layer && hostBox) {
                  const transformBefore = layer.getAttribute('transform')
                  panRow.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }))
                  await new Promise((resolve) => setTimeout(resolve, 320))
                  panMoved = layer.getAttribute('transform') !== transformBefore
                  const card = cardOf(panRow.dataset.peerNode)
                  const box = card?.getBoundingClientRect()
                  const margin = 4
                  panVisible = Boolean(
                    box &&
                      box.right > hostBox.left + margin &&
                      box.left < hostBox.right - margin &&
                      box.bottom > hostBox.top + margin &&
                      box.top < hostBox.bottom - margin
                  )
                  mapHoverPanOk = panMoved && panVisible
                  /* 脱手未选择 → 必须**还回原节点显示**（用户要求），而不是把小图留在预览的位置 */
                  panRow.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true, view: window }))
                  await new Promise((resolve) => setTimeout(resolve, 320))
                  hoverRestored = transformOf() === transformBefore
                  mapHoverRestoreOk = hoverRestored
                }

                /*
                 * 空白处"点一下没选中任何东西" → 同样恢复到当前节点的显示（用户要求的第二半句）。
                 * 挑一个不在卡片上的角落点下去；判据：图层 transform 回到"跳转后定位"的那一份。
                 */
                let mapTapRestoreOk: boolean | 'skip' = 'skip'
                let tapRestored = false
                if (area && hostBox && transformLocated) {
                  const corners: [number, number][] = [
                    [hostBox.left + 8, hostBox.top + 8],
                    [hostBox.right - 8, hostBox.top + 8],
                    [hostBox.left + 8, hostBox.bottom - 8],
                    [hostBox.right - 8, hostBox.bottom - 8]
                  ]
                  const point = corners.find(([x, y]) => !document.elementFromPoint(x, y)?.closest('.lr-localmap__card'))
                  if (point) {
                    const [x, y] = point
                    const hit = document.elementFromPoint(x, y) ?? area
                    hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1 }))
                    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1 }))
                    await new Promise((resolve) => setTimeout(resolve, 320))
                    tapRestored = transformOf() === transformLocated
                    mapTapRestoreOk = tapRestored
                  }
                }

                const hoverAllOk =
                  mapHoverOk && mapHoverPanOk !== false && mapHoverRestoreOk !== false && mapTapRestoreOk !== false
                const mapAllOk = mapLocatedOk && hoverAllOk

                if (landed && rangeOk && holdOk && chainOk && mapAllOk) {
                  await log.write(
                    'info',
                    'smoke',
                    'GRAPH_JUMP_OK ' +
                      JSON.stringify({
                        node: nodeId,
                        anchor: [expected.charStart, expected.charEnd],
                        request: [request?.charStart, request?.charEnd],
                        activeTab: activeTab?.kind,
                        flash: landed.flash.className,
                        page: landed.flash.closest('.lr-pdf-page')?.getAttribute('data-page') ?? null,
                        range: appliedRange,
                        rangeOk,
                        rawWasMidWord,
                        holdOk,
                        chainOk,
                        chainRows,
                        mapCards,
                        mapLinks,
                        mapCenterOk,
                        mapLocatedOk,
                        locatedZoom,
                        centerShift,
                        mapHoverOk,
                        hoverPreviewId,
                        mapHoverPanOk,
                        panMoved,
                        panVisible,
                        mapHoverRestoreOk,
                        hoverRestored,
                        mapTapRestoreOk,
                        tapRestored,
                        ms: Date.now() - started
                      })
                  )
                } else if (landed) {
                  await log.write(
                    'error',
                    'smoke',
                    'GRAPH_JUMP_FAIL ' +
                      JSON.stringify({
                        reason: '高亮/逻辑链断言未通过',
                        node: nodeId,
                        range: appliedRange,
                        expectedRange,
                        rangeOk,
                        holdOk,
                        chainOk,
                        chainRows,
                        mapCenterOk,
                        mapLocatedOk,
                        locatedZoom,
                        centerShift,
                        mapHoverOk,
                        mapHoverPanOk,
                        mapHoverRestoreOk,
                        mapTapRestoreOk,
                        hoverPreviewId,
                        hoverCleared
                      })
                  )
                } else {
                  await log.write(
                    'error',
                    'smoke',
                    'GRAPH_JUMP_FAIL ' +
                      JSON.stringify({
                        node: nodeId,
                        anchor: [expected.charStart, expected.charEnd],
                        request: request ? [request.charStart, request.charEnd] : null,
                        activeTab: activeTab?.kind ?? null,
                        ms: Date.now() - started
                      })
                  )
                }

                /*
                 * ---- 第 2.5 步：右侧小窗的两种视图都要能切（整个图谱 / 只看相邻） ----
                 * 只看外观判断容易骗自己，这里只看**根节点上的类名**换没换。
                 */
                if (landed && rangeOk && holdOk && chainOk) {
                  const toNeighbors = document.querySelector<HTMLElement>('.lr-localmap__mode[data-mode="neighbors"]')
                  const toWhole = document.querySelector<HTMLElement>('.lr-localmap__mode[data-mode="whole"]')
                  if (!toNeighbors || !toWhole) {
                    await log.write('error', 'smoke', 'GRAPH_MAP_MODE_FAIL ' + JSON.stringify({ reason: '小窗没有分段开关' }))
                  } else {
                    toNeighbors.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                    const toNeighborsOk = await waitFor(
                      () => (document.querySelector('.lr-localmap--neighbors') ? true : null),
                      5000
                    )
                    toWhole.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                    const backOk = await waitFor(() => (document.querySelector('.lr-localmap--whole') ? true : null), 5000)
                    await log.write(
                      toNeighborsOk && backOk ? 'info' : 'error',
                      'smoke',
                      (toNeighborsOk && backOk ? 'GRAPH_MAP_MODE_OK ' : 'GRAPH_MAP_MODE_FAIL ') +
                        JSON.stringify({ toNeighborsOk: Boolean(toNeighborsOk), backOk: Boolean(backOk) })
                    )

                    /*
                     * 整个图谱必须"和全局关系图一致且可缩放"：
                     * 读窗口上的缩放百分比（data-zoom），点三次「＋」后必须变大。
                     */
                    const zoomButton = document.querySelector<HTMLElement>('.lr-localmap__tool[data-tool="in"]')
                    const before = Number(document.querySelector<HTMLElement>('.lr-localmap__area')?.dataset.zoom ?? '0')
                    if (!zoomButton || before <= 0) {
                      await log.write('error', 'smoke', 'GRAPH_MAP_ZOOM_FAIL ' + JSON.stringify({ reason: '没有缩放按钮或取不到初始缩放', before, hasButton: Boolean(zoomButton) }))
                    } else {
                      for (let i = 0; i < 3; i += 1) {
                        zoomButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                      }
                      const after = await waitFor(() => {
                        const now = Number(document.querySelector<HTMLElement>('.lr-localmap__area')?.dataset.zoom ?? '0')
                        return now > before ? now : null
                      }, 5000)
                      await log.write(
                        after ? 'info' : 'error',
                        'smoke',
                        (after ? 'GRAPH_MAP_ZOOM_OK ' : 'GRAPH_MAP_ZOOM_FAIL ') +
                          JSON.stringify({ before, after: after ?? 0 })
                      )
                    }

                    /*
                     * ---- 「定位当前节点」：必须放大到看得清字，并且该节点居中 ----
                     * 判据：缩放 ≥ 90%（字号换算见 READABLE_ZOOM）+ 中心卡片中心与窗口中心相差 ≤ 12px。
                     */
                    const locateButton = document.querySelector<HTMLElement>('.lr-localmap__tool[data-tool="locate"]')
                    if (!locateButton) {
                      await log.write('error', 'smoke', 'GRAPH_MAP_LOCATE_FAIL ' + JSON.stringify({ reason: '没有定位按钮' }))
                    } else {
                      locateButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                      const located = await waitFor(() => {
                        const area = document.querySelector<HTMLElement>('.lr-localmap__area')
                        const card = document.querySelector<HTMLElement>('.lr-localmap__card--center')
                        if (!area || !card) return null
                        const zoom = Number(area.dataset.zoom ?? '0')
                        const frame = area.getBoundingClientRect()
                        const box = card.getBoundingClientRect()
                        const dx = Math.abs(box.left + box.width / 2 - (frame.left + frame.width / 2))
                        const dy = Math.abs(box.top + box.height / 2 - (frame.top + frame.height / 2))
                        return zoom >= 90 && dx <= 12 && dy <= 12 ? { zoom, dx: Math.round(dx), dy: Math.round(dy) } : null
                      }, 5000)
                      await log.write(
                        located ? 'info' : 'error',
                        'smoke',
                        (located ? 'GRAPH_MAP_LOCATE_OK ' : 'GRAPH_MAP_LOCATE_FAIL ') +
                          JSON.stringify(
                            located ?? {
                              zoom: Number(document.querySelector<HTMLElement>('.lr-localmap__area')?.dataset.zoom ?? '0')
                            }
                          )
                      )

                      /*
                       * ---- 卡片必须是"真能点到"的 ----
                       * 这条专治"容器把指针捕获走 / 被别的层盖住"导致的真机点不动 ——
                       * 只发合成事件的断言测不出这类问题（本轮就是这么漏过去的）。
                       * 判据：卡片中心点上的 elementFromPoint 命中卡片自己。
                       */
                      const paneForHit = document.querySelector<HTMLElement>('.lr-localmap__area')
                      const centerCard = document.querySelector<SVGGElement>('.lr-localmap__card--center')
                      if (!paneForHit || !centerCard) {
                        await log.write('error', 'smoke', 'GRAPH_MAP_HITTEST_FAIL ' + JSON.stringify({ reason: '取不到中心卡片' }))
                      } else {
                        const box = centerCard.getBoundingClientRect()
                        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
                        const hitOk = Boolean(hit && (centerCard === hit || centerCard.contains(hit)))
                        await log.write(
                          hitOk ? 'info' : 'error',
                          'smoke',
                          (hitOk ? 'GRAPH_MAP_HITTEST_OK ' : 'GRAPH_MAP_HITTEST_FAIL ') +
                            JSON.stringify({
                              hitTag: hit?.tagName ?? null,
                              hitClass: (hit as Element | null)?.getAttribute?.('class') ?? null,
                              insidePane: Boolean(hit && paneForHit.contains(hit))
                            })
                        )
                      }
                    }

                    /*
                     * ---- 不锁定：手动拖动之后，视图不能被"自动拉回焦点"拽回去 ----
                     * 先拖 120px，再等 800ms 看 transform 有没有被人改回来。
                     */
                    const pane = document.querySelector<HTMLElement>('.lr-localmap__area')
                    const paneGroup = pane?.querySelector('svg > g') ?? null
                    if (!pane || !paneGroup) {
                      await log.write('error', 'smoke', 'GRAPH_MAP_PAN_FAIL ' + JSON.stringify({ reason: '取不到窗口' }))
                    } else {
                      const beforeTransform = paneGroup.getAttribute('transform')
                      const frame = pane.getBoundingClientRect()
                      const startX = Math.round(frame.left + frame.width / 2)
                      const startY = Math.round(frame.top + frame.height / 2)
                      const send = (type: string, x: number, y: number): void => {
                        pane.dispatchEvent(
                          new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1 })
                        )
                      }
                      // 拖够远（260px > 半个窗口），让焦点**真的离开窗口** —— 这样才测得出"会不会被拽回去"
                      send('pointerdown', startX, startY)
                      for (let step = 1; step <= 13; step += 1) send('pointermove', startX - step * 20, startY)
                      send('pointerup', startX - 260, startY)
                      const draggedTo = await waitFor(() => {
                        const now = document.querySelector('.lr-localmap__area svg > g')?.getAttribute('transform') ?? null
                        return now && now !== beforeTransform ? now : null
                      }, 3000)
                      await new Promise((resolve) => setTimeout(resolve, 800))
                      const settled = document.querySelector('.lr-localmap__area svg > g')?.getAttribute('transform') ?? null
                      await log.write(
                        draggedTo && settled === draggedTo ? 'info' : 'error',
                        'smoke',
                        (draggedTo && settled === draggedTo ? 'GRAPH_MAP_PAN_OK ' : 'GRAPH_MAP_PAN_FAIL ') +
                          JSON.stringify({ dragged: Boolean(draggedTo), stayedPut: Boolean(draggedTo) && settled === draggedTo })
                      )
                    }
                  }
                }

                /*
                 * ---- 第 3 步：小图里的**单击 / 双击**两种手势 ----
                 *
                 * 用户要求：小图里**双击**另一个节点时，右侧信息更新为那个节点的相关信息。
                 * 定下来的手势（桌面老规矩）：**单击 = 就地切换右侧信息（不动论文）**、**双击 = 跳到那段原文**。
                 * 断言不看外观，只认事实：
                 *   ① 单击后面板以该节点为中心（data-reveal-node），**且没有新的定位请求**（论文没动）；
                 *   ② 双击后产生了**新的**定位请求、面板与图的中心都换成它 —— 于是"一路追下去"成立。
                 * 候选节点取"既有锚点又在图里画出来"的那一个，避免把"该节点没有原文位置"误判成功能坏了。
                 */
                if (landed && rangeOk && holdOk && chainOk) {
                  const { useGraph } = await import('./state/graph.store')
                  const current = useGraph.getState().graph
                  const nodeById = new Map((current?.nodes ?? []).map((item) => [item.id, item]))
                  const peerIds = (current?.edges ?? [])
                    .filter((edge) => edge.from === nodeId || edge.to === nodeId)
                    .map((edge) => (edge.from === nodeId ? edge.to : edge.from))
                  const target = peerIds
                    .map((id) => nodeById.get(id))
                    .find(
                      (item) =>
                        Boolean(item) &&
                        (item?.anchors?.length ?? 0) > 0 &&
                        (item?.anchorIds?.length ?? 0) > 0 &&
                        document.querySelector<HTMLElement>('.lr-localmap__card--peer[data-peer-node="' + item?.id + '"]')
                    )
                  const card = target
                    ? document.querySelector<HTMLElement>('.lr-localmap__card--peer[data-peer-node="' + target.id + '"]')
                    : null
                  if (!target || !card) {
                    await log.write(
                      'error',
                      'smoke',
                      'GRAPH_MAP_JUMP_FAIL ' +
                        JSON.stringify({ reason: '局部图里没有可点的对端节点', peers: peerIds.length, mapCards })
                    )
                  } else {
                    const beforeNonce = useUiStore.getState().revealRequest?.nonce ?? 0
                    /*
                     * 走**完整事件序列**（pointerdown → pointerup → click），不是只发一个 click：
                     * 卡片里有一道"刚拖过就不要误触发跳转"的闸门，它靠 pointerdown 复位 ——
                     * 真实点击永远带 pointerdown，只发 click 的脚本反而是假失败（§7.0 的原话：程序化事件 ≠ 用户操作）。
                     */
                    const rect = card.getBoundingClientRect()
                    const px = Math.round(rect.left + rect.width / 2)
                    const py = Math.round(rect.top + rect.height / 2)
                    const pointer = (type: string): void => {
                      card.dispatchEvent(
                        new PointerEvent(type, { bubbles: true, cancelable: true, clientX: px, clientY: py, pointerId: 2 })
                      )
                    }
                    const clickOnce = (): void => {
                      pointer('pointerdown')
                      pointer('pointerup')
                      card.dispatchEvent(
                        new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: px, clientY: py })
                      )
                    }

                    /* ---- 3a. 单击：右侧信息切到该节点，但**不许**移动论文 ---- */
                    clickOnce()
                    const inspected = await waitFor(() => {
                      const panel = document.querySelector<HTMLElement>('.lr-chain[data-reveal-node]')
                      if (panel?.dataset.revealNode !== target.id) return null
                      const next = useUiStore.getState().revealRequest
                      if ((next?.nonce ?? 0) !== beforeNonce) return null
                      return { preview: Boolean(document.querySelector('.lr-chain__badge[data-preview="true"]')) }
                    }, 5000)
                    await log.write(
                      inspected ? 'info' : 'error',
                      'smoke',
                      (inspected ? 'GRAPH_MAP_INSPECT_OK ' : 'GRAPH_MAP_INSPECT_FAIL ') +
                        JSON.stringify({
                          to: target.id,
                          previewBadge: Boolean(inspected?.preview),
                          panel: document.querySelector('.lr-chain')?.getAttribute('data-reveal-node') ?? null,
                          nonceChanged: (useUiStore.getState().revealRequest?.nonce ?? 0) !== beforeNonce
                        })
                    )

                    /* ---- 3b. 双击：跳到该节点的原文（并保持右侧信息也在这个节点） ---- */
                    clickOnce()
                    clickOnce()
                    card.dispatchEvent(
                      new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window, clientX: px, clientY: py })
                    )
                    const recentred = await waitFor(() => {
                      const next = useUiStore.getState().revealRequest
                      if (!next || next.nonce === beforeNonce || next.chain?.nodeId !== target.id) return null
                      const panel = document.querySelector<HTMLElement>('.lr-chain[data-reveal-node]')
                      if (panel?.dataset.revealNode !== target.id) return null
                      const center = document.querySelector<HTMLElement>('.lr-localmap__card--center')
                      if (center?.dataset.centerNode !== target.id) return null
                      return { next }
                    }, 15000)
                    if (recentred) {
                      await log.write(
                        'info',
                        'smoke',
                        'GRAPH_MAP_JUMP_OK ' +
                          JSON.stringify({
                            from: nodeId,
                            to: target.id,
                            request: [recentred.next.charStart, recentred.next.charEnd],
                            nonce: recentred.next.nonce
                          })
                      )
                    } else {
                      const next = useUiStore.getState().revealRequest
                      await log.write(
                        'error',
                        'smoke',
                        'GRAPH_MAP_JUMP_FAIL ' +
                          JSON.stringify({
                            reason: '点了图里的节点但没有重新定位',
                            from: nodeId,
                            to: target.id,
                            requestNode: next?.chain?.nodeId ?? null,
                            nonceChanged: (next?.nonce ?? 0) !== beforeNonce,
                            panel: document.querySelector('.lr-chain')?.getAttribute('data-reveal-node') ?? null,
                            center:
                              document.querySelector('.lr-localmap__card--center')?.getAttribute('data-center-node') ?? null
                          })
                      )
                    }
                  }
                }
              } catch (error) {
                await log.write('error', 'smoke', 'GRAPH_JUMP_FAIL 异常：' + String(error))
              }
            })()
            return
          }
          /**
           * 关系图图片导出的客观断言（PNG 透明 / JPG 铺画布底色）。
           *
           * 不看截图，直接读导出的像素：
           *   · PNG —— 角落像素 alpha 必须是 0（透明），且图里有内容（与角落不同的像素足够多）；
           *   · JPG —— 角落像素必须等于"当前界面上的画布底色"（容差内），同样必须有内容；
           *   · 两个文件都真的落盘（size > 0），尺寸 = SVG 尺寸 × 倍率。
           * 任一不成立写 GRAPH_IMAGE_FAIL。
           */
          /**
           * 论文↔关系图绑定的客观断言，按用户描述的四条走一遍真实流程：
           *   ① 调取关系图 → 图标签出现，标题 = "文档名 · 逻辑关系图"；
           *   ② 关关系图 → **论文还在**；
           *   ③ 再调取 → 图又回来了（Ctrl+Shift+L / 视图菜单 / 侧边栏都走这条命令）；
           *   ④ 关论文 → **图一起关**；重开论文后仍能再调取。
           * 任一不成立写 GRAPH_BINDING_FAIL。
           */
          /**
           * 人工建立联系的客观断言：**真的从把手拖一条线到另一个节点**。
           *
           * 断言四件事：
           *   ① 松手之后图上多了一条边，且连的正是拖的那两个节点；
           *   ② 这条边**落库**了（回读 graphGet）；
           *   ③ 画布上真的多了一条边（DOM）；
           *   ④ 同方向再连一次必须被**拒绝**（手一抖不该连出两条）。
           *
           * React Flow 的连接拖拽是 mousedown（把手）→ document 上的 mousemove → mouseup，
           * 所以这里按真实事件序列发。
           */
          /**
           * "选中内容送给 Agent 时必须是**完整的**"的客观断言。
           *
           * 用户反馈：选中一整行标题，交给 Agent 的文本却断在"…of SQL"上（老实现 slice(0, 60)），
           * 而且动作名用的是不存在的文案键（问题里出现字面的 agent.translateSelection）。
           * 这里按真实路径走一遍：DOM 选区 → 选区解析 → 问题文本 + 上下文，然后逐条比对：
           *   ① 问题文本包含**完整**选区（忽略空白）；
           *   ② 问题文本里没有裸露的文案键；
           *   ③ 上下文（【引用原文】）也带完整选区。
           */
          if (commandId === 'smoke.askPayload') {
            void (async () => {
              const log = window.logicreader.log
              const { useTabs } = await import('./state/tabs.store')
              const { useUiStore } = await import('./state/ui.store')
              const { useDocuments } = await import('./state/documents.store')
              const { useSettings } = await import('./state/settings.store')
              const { selectionQuestion } = await import('./state/askFlow')
              const { buildContext } = await import('./lib/contextBuilder')
              const { createAnchor } = await import('@logicreader/document-model')
              const { openFileInWorkbench } = await import('./commands')
              const squash = (value: string): string => value.replace(/\s+/g, '')
              try {
                const docId = await findDocumentWithGraph()
                if (!docId) {
                  await log.write('error', 'smoke', 'AGENT_PAYLOAD_FAIL 会话里没有可定位的文档')
                  return
                }
                const model = useDocuments.getState().models[docId]
                const filePath = model?.filePath ?? (await window.logicreader.store.getDocument(docId))?.path ?? null
                if (!filePath) {
                  await log.write('error', 'smoke', 'AGENT_PAYLOAD_FAIL 找不到文档路径')
                  return
                }
                await openFileInWorkbench(filePath)
                await new Promise((resolve) => setTimeout(resolve, 1200))

                // 造一次真实选区：像用户那样在文本层上拖出一段（这里用 Range + mouseup 触发同一套解析）
                const pick = (): { text: string } | null => {
                  const page = document.querySelector<HTMLElement>('.lr-pdf-page')
                  const spans = Array.from(page?.querySelectorAll<HTMLElement>('.textLayer span[data-char-start]') ?? []).filter(
                    (item) => (item.textContent ?? '').trim().length > 0
                  )
                  if (spans.length < 12) return null
                  /*
                   * 从**正文中部**起选，而不是页首：
                   *  1. 特意超过 60 字 —— 老实现是 slice(0, 60)，只有选区比 60 长，这个断言才有意义；
                   *  2. 页眉/标题区常出现"内容流顺序 ≠ 视觉顺序"的交错（本项目已知边界），
                   *     从正文取一段才能把"送出去的文全不全"这件事单独测出来。
                   */
                  const first = Math.floor(spans.length * 0.4)
                  const from = spans[first]
                  let last = spans[Math.min(spans.length - 1, first + 6)]
                  let acc = 0
                  for (let index = first; index < spans.length; index += 1) {
                    acc += (spans[index].textContent ?? '').length
                    last = spans[index]
                    if (acc >= 140) break
                  }
                  const to = last
                  const range = document.createRange()
                  range.setStart(from.firstChild ?? from, 0)
                  range.setEnd(to.firstChild ?? to, (to.textContent ?? '').length)
                  const native = window.getSelection()
                  native?.removeAllRanges()
                  native?.addRange(range)
                  page?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
                  return { text: range.toString() }
                }
                let domText = ''
                for (let attempt = 1; attempt <= 3; attempt += 1) {
                  const picked = pick()
                  domText = picked?.text ?? ''
                  await new Promise((resolve) => setTimeout(resolve, 500))
                  if (useUiStore.getState().selection) break
                  await log.write('warn', 'smoke', 'askPayload：第 ' + attempt + ' 次造选区未生效，重试')
                }
                const selection = useUiStore.getState().selection
                if (!selection || !model) {
                  await log.write('error', 'smoke', 'AGENT_PAYLOAD_FAIL 没能建立选区（脚本问题）')
                  return
                }

                const question = selectionQuestion('translate', selection)
                const anchor = createAnchor({
                  model,
                  charStart: selection.charStart,
                  charEnd: selection.charEnd,
                  origin: 'selection'
                })
                const settings = useSettings.getState().settings
                const payload = buildContext({
                  mode: 'fulltext',
                  document: model,
                  graph: null,
                  anchor,
                  nodeId: null,
                  history: [],
                  question,
                  contextParagraphsBefore: settings.reader.contextParagraphsBefore,
                  contextParagraphsAfter: settings.reader.contextParagraphsAfter,
                  includeLocationHeader: settings.reader.includeLocationHeader
                })

                const wanted = squash(selection.text)
                const quote = squash(anchor.quote)
                const questionHasAll = wanted.length > 0 && squash(question).includes(wanted)
                const contextHasAll = wanted.length > 0 && squash(payload.systemContext).includes(wanted)
                // 选区的（忽略空白）字符是否是引文的**子序列**：区分"引文更短"与"只是顺序/交错不同"
                const isSubsequence = (needle: string, haystack: string): boolean => {
                  let i = 0
                  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
                    if (needle[i] === haystack[j]) i += 1
                  }
                  return i === needle.length
                }
                const quoteIsSubsequenceOfSelection = isSubsequence(quote, wanted)
                const selectionIsSubsequenceOfQuote = isSubsequence(wanted, quote)
                const noRawKey = !/agent\.[a-zA-Z]+Selection/.test(question) && !question.includes('：\nagent.')
                const ok = questionHasAll && contextHasAll && noRawKey
                await log.write(
                  ok ? 'info' : 'error',
                  'smoke',
                  (ok ? 'AGENT_PAYLOAD_OK ' : 'AGENT_PAYLOAD_FAIL ') +
                    JSON.stringify({
                      docId,
                      selectedChars: selection.text.length,
                      domChars: domText.length,
                      questionChars: question.length,
                      questionHasFullSelection: questionHasAll,
                      contextHasFullSelection: contextHasAll,
                      noRawI18nKey: noRawKey,
                      selectionChars: wanted.length,
                      quoteChars: quote.length,
                      selectionInQuote: selectionIsSubsequenceOfQuote,
                      quoteInSelection: quoteIsSubsequenceOfSelection,
                      quoteHead: quote.slice(0, 30),
                      quoteTail: quote.slice(-30),
                      selectionHead: selection.text.slice(0, 40),
                      selectionTail: selection.text.slice(-40),
                      questionHead: question.slice(0, 60)
                    })
                )
              } catch (error) {
                await log.write('error', 'smoke', 'AGENT_PAYLOAD_FAIL 异常：' + String(error))
              }
            })()
            return
          }
          if (commandId === 'smoke.graphEdge') {
            void (async () => {
              const log = window.logicreader.log
              const { useGraph } = await import('./state/graph.store')
              const { openGraphTab } = await import('./commands')
              const { canLinkNodes } = await import('./state/graphEdits')
              const waitFor = async <T,>(probe: () => T | null, timeoutMs: number): Promise<T | null> => {
                const deadline = Date.now() + timeoutMs
                let value = probe()
                while (!value && Date.now() < deadline) {
                  await new Promise((resolve) => setTimeout(resolve, 120))
                  value = probe()
                }
                return value
              }
              const mouse = (type: string, x: number, y: number): MouseEvent =>
                new MouseEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  clientX: x,
                  clientY: y,
                  button: 0,
                  buttons: type === 'mouseup' ? 0 : 1,
                  view: window
                })
              try {
                const docId = await findDocumentWithGraph()
                if (!docId) {
                  await log.write('error', 'smoke', 'GRAPH_EDGE_FAIL 会话里没有带关系图的文档')
                  return
                }
                openGraphTab(docId)
                const graph = await waitFor(() => {
                  const data = useGraph.getState().graph
                  return data && data.docId === docId && data.nodes.length > 0 ? data : null
                }, 10000)
                if (!graph) {
                  await log.write('error', 'smoke', 'GRAPH_EDGE_FAIL 关系图未加载')
                  return
                }
                /*
                 * 挑一对"画布上已渲染、目前还没同方向连线、且**都稳稳在视口内**"的节点。
                 * 第三个条件很关键：贴着画布边缘的节点会触发 React Flow 的 autoPan，
                 * 拖动过程中画布一平移，事先量好的落点就失效了 —— 脚本会误报"拖了没反应"。
                 */
                const flow = document.querySelector<HTMLElement>('.react-flow')
                const bounds = flow?.getBoundingClientRect() ?? null
                const inside = (element: HTMLElement): boolean => {
                  if (!bounds) return true
                  const rect = element.getBoundingClientRect()
                  const margin = 48
                  return (
                    rect.left > bounds.left + margin &&
                    rect.right < bounds.right - margin &&
                    rect.top > bounds.top + margin &&
                    rect.bottom < bounds.bottom - margin
                  )
                }
                const pair = await waitFor(() => {
                  const elements = Array.from(document.querySelectorAll<HTMLElement>('.react-flow__node')).filter(inside)
                  if (elements.length < 2) return null
                  const current = useGraph.getState().graph
                  for (const a of elements) {
                    for (const b of elements) {
                      const fromId = a.dataset.id ?? ''
                      const toId = b.dataset.id ?? ''
                      if (!fromId || !toId || fromId === toId) continue
                      if (canLinkNodes(current, fromId, toId).ok) return { a, b, fromId, toId }
                    }
                  }
                  return null
                }, 10000)
                if (!pair) {
                  await log.write('error', 'smoke', 'GRAPH_EDGE_FAIL 画布上找不到可连接的节点对')
                  return
                }
                const sourceHandle = pair.a.querySelector<HTMLElement>('.react-flow__handle.source')
                const targetHandle = pair.b.querySelector<HTMLElement>('.react-flow__handle.target') ?? pair.b
                if (!sourceHandle) {
                  await log.write('error', 'smoke', 'GRAPH_EDGE_FAIL 起点节点上没有连接把手')
                  return
                }
                const centerOf = (element: HTMLElement): { x: number; y: number } => {
                  const rect = element.getBoundingClientRect()
                  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
                }
                const start = centerOf(sourceHandle)
                const edgesBefore = useGraph.getState().graph?.edges.length ?? 0
                const domEdgesBefore = document.querySelectorAll('.react-flow__edge').length
                const viewportBefore = JSON.stringify(useTabs.getState().activeTab()?.kind ?? null)

                sourceHandle.dispatchEvent(mouse('mousedown', start.x, start.y))
                for (let step = 1; step <= 5; step += 1) {
                  document.dispatchEvent(
                    mouse('mousemove', start.x + step * 6, start.y + step * 4)
                  )
                  await new Promise((resolve) => setTimeout(resolve, 20))
                }
                // 落点**当场重新量**：拖动期间画布可能已经平移/缩放（autoPan、fitView 收尾）
                const end = centerOf(pair.b.querySelector<HTMLElement>('.react-flow__handle.target') ?? pair.b)
                for (let step = 1; step <= 5; step += 1) {
                  document.dispatchEvent(
                    mouse('mousemove', start.x + ((end.x - start.x) * step) / 5, start.y + ((end.y - start.y) * step) / 5)
                  )
                  await new Promise((resolve) => setTimeout(resolve, 25))
                }
                const connectionLineVisible = Boolean(document.querySelector('.react-flow__connection'))
                document.dispatchEvent(mouse('mouseup', end.x, end.y))

                const created = await waitFor(() => {
                  const current = useGraph.getState().graph
                  return current?.edges.find((edge) => edge.from === pair.fromId && edge.to === pair.toId) ?? null
                }, 4000)
                const persisted = created
                  ? ((await window.logicreader.store.graphGet(graph.id)) as { edges?: { id: string }[] } | null)
                  : null
                const persistedOk = Boolean(persisted?.edges?.some((edge) => edge.id === created?.id))
                const domEdgesAfter = document.querySelectorAll('.react-flow__edge').length

                // 同方向再连一次：必须被拒绝（并把已有那条选中）
                const duplicate = await useGraph.getState().addEdge({ from: pair.fromId, to: pair.toId })
                const edgesAfterDuplicate = useGraph.getState().graph?.edges.length ?? 0
                const duplicateRejected = duplicate.ok === false && duplicate.reason === 'duplicate'
                const noExtraEdge = edgesAfterDuplicate === edgesBefore + 1

                const ok = Boolean(created) && persistedOk && duplicateRejected && noExtraEdge
                await log.write(
                  ok ? 'info' : 'error',
                  'smoke',
                  (ok ? 'GRAPH_EDGE_OK ' : 'GRAPH_EDGE_FAIL ') +
                    JSON.stringify({
                      docId,
                      from: pair.fromId,
                      to: pair.toId,
                      edgeId: created?.id ?? null,
                      kind: created?.kind ?? null,
                      manual: created?.meta?.manual === true,
                      anchorCount: created?.anchorIds?.length ?? 0,
                      persistedOk,
                      domEdges: [domEdgesBefore, domEdgesAfter],
                      duplicateRejected,
                      edges: [edgesBefore, edgesAfterDuplicate],
                      connectionLineVisible,
                      sourceInsideViewport: inside(pair.a),
                      targetInsideViewport: inside(pair.b),
                      viewportBefore
                    })
                )
              } catch (error) {
                await log.write('error', 'smoke', 'GRAPH_EDGE_FAIL 异常：' + String(error))
              }
            })()
            return
          }
          if (commandId === 'smoke.graphBinding') {
            void (async () => {
              const log = window.logicreader.log
              const { useTabs } = await import('./state/tabs.store')
              const { useDocuments } = await import('./state/documents.store')
              const { executeCommand } = await import('./state/commands.store')
              const { openFileInWorkbench, openGraphTab } = await import('./commands')
              const { graphDisplayName } = await import('./lib/graphName')
              try {
                const docId = await findDocumentWithGraph()
                if (!docId) {
                  await log.write('error', 'smoke', 'GRAPH_BINDING_FAIL 会话里没有带关系图的文档')
                  return
                }
                // 会话里可能只恢复了关系图标签（模型不在内存）→ 文件路径回数据库取
                const filePath =
                  useDocuments.getState().models[docId]?.filePath ??
                  (await window.logicreader.store.getDocument(docId))?.path ??
                  null
                if (!filePath) {
                  await log.write('error', 'smoke', 'GRAPH_BINDING_FAIL 找不到文档路径 docId=' + docId)
                  return
                }
                const findReader = (): boolean => Boolean(useTabs.getState().findByDoc(docId, 'reader'))
                const findGraph = (): { id: string; title: string } | null => {
                  const tab = useTabs.getState().findByDoc(docId, 'graph')
                  return tab ? { id: tab.id, title: tab.title ?? '' } : null
                }
                // 起点：先把关系图收起来，只留论文
                const stale = findGraph()
                if (stale) useTabs.getState().closeTab(stale.id)
                await openFileInWorkbench(filePath)
                const expectedTitle = graphDisplayName(docId)

                // ① 调取关系图
                await executeCommand(CMD.graphShow)
                const opened = findGraph()
                const titleOk = opened?.title === expectedTitle

                // ② 关关系图 —— 论文必须还在
                if (opened) useTabs.getState().closeTab(opened.id)
                const readerAlive = findReader()
                const graphGone = !findGraph()

                /*
                 * ③ 再调取 —— 图回来。
                 * 先把论文标签激活：用户的动作就是"看着论文 → Ctrl+Shift+L"。
                 * （会话里可能同时开着好几篇论文，"关掉图之后恰好是哪个标签被激活"
                 *  取决于标签顺序，脚本不能假设它一定是本篇论文。）
                 */
                const readerForReopen = useTabs.getState().findByDoc(docId, 'reader')
                if (readerForReopen) useTabs.getState().activate(readerForReopen.id)
                await executeCommand(CMD.graphShow)
                const reopened = findGraph()

                // ④ 关论文 —— 图跟着关
                const readerTab = useTabs.getState().findByDoc(docId, 'reader')
                if (readerTab) useTabs.getState().closeTab(readerTab.id)
                const bothGone = !findReader() && !findGraph()

                // ⑤ 重开论文后仍可再调取
                await openFileInWorkbench(filePath)
                openGraphTab(docId)
                const restored = findGraph()

                const ok = titleOk && readerAlive && graphGone && Boolean(reopened) && bothGone && Boolean(restored)
                await log.write(
                  ok ? 'info' : 'error',
                  'smoke',
                  (ok ? 'GRAPH_BINDING_OK ' : 'GRAPH_BINDING_FAIL ') +
                    JSON.stringify({
                      docId,
                      expectedTitle,
                      openedTitle: opened?.title ?? null,
                      titleOk,
                      readerAliveAfterGraphClose: readerAlive,
                      graphGoneAfterGraphClose: graphGone,
                      reopened: Boolean(reopened),
                      bothGoneAfterReaderClose: bothGone,
                      restoredAfterReopen: Boolean(restored)
                    })
                )
              } catch (error) {
                await log.write('error', 'smoke', 'GRAPH_BINDING_FAIL 异常：' + String(error))
              }
            })()
            return
          }
          if (commandId === 'smoke.graphImage') {
            void (async () => {
              const log = window.logicreader.log
              const { useTabs } = await import('./state/tabs.store')
              const { useGraph } = await import('./state/graph.store')
              const { openGraphTab } = await import('./commands')
              const { canvasBackgroundColor, exportGraphImage } = await import('./lib/graphImage')
              const waitFor = async <T,>(probe: () => T | null, timeoutMs: number): Promise<T | null> => {
                const deadline = Date.now() + timeoutMs
                let value = probe()
                while (!value && Date.now() < deadline) {
                  await new Promise((resolve) => setTimeout(resolve, 120))
                  value = probe()
                }
                return value
              }
              /** 把导出的字节解回像素，取角落颜色与"内容像素"个数 */
              const sampleImage = async (
                bytes: Uint8Array
              ): Promise<{ width: number; height: number; corner: number[]; content: number }> => {
                const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]))
                try {
                  const image = new Image()
                  image.src = url
                  await image.decode()
                  const canvas = document.createElement('canvas')
                  canvas.width = image.naturalWidth
                  canvas.height = image.naturalHeight
                  const context = canvas.getContext('2d')
                  if (!context) throw new Error('无法创建 2D 画布上下文')
                  context.drawImage(image, 0, 0)
                  const corner = Array.from(context.getImageData(1, 1, 1, 1).data)
                  const data = context.getImageData(0, 0, canvas.width, canvas.height).data
                  let content = 0
                  for (let i = 0; i < data.length; i += 28) {
                    const delta =
                      Math.abs(data[i] - corner[0]) +
                      Math.abs(data[i + 1] - corner[1]) +
                      Math.abs(data[i + 2] - corner[2]) +
                      Math.abs(data[i + 3] - corner[3])
                    if (delta > 24) content += 1
                  }
                  return { width: canvas.width, height: canvas.height, corner, content }
                } finally {
                  URL.revokeObjectURL(url)
                }
              }
              const parseColor = (color: string): [number, number, number] => {
                const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
                if (hex) {
                  const value = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1]
                  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)]
                }
                const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color)
                return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : [255, 255, 255]
              }
              try {
                const docId = await findDocumentWithGraph()
                if (!docId) {
                  await log.write('error', 'smoke', 'GRAPH_IMAGE_FAIL 会话里没有带关系图的文档')
                  return
                }
                await log.write('info', 'smoke', 'GRAPH_IMAGE 目标文档 ' + docId)
                openGraphTab(docId)
                const graph = await waitFor(() => {
                  const data = useGraph.getState().graph
                  return data && data.docId === docId && data.nodes.length > 0 ? data : null
                }, 10000)
                if (!graph) {
                  await log.write('error', 'smoke', 'GRAPH_IMAGE_FAIL 关系图未加载 docId=' + docId)
                  return
                }
                const background = canvasBackgroundColor(document.querySelector<HTMLElement>('.lr-graph__canvas'))
                const rgb = parseColor(background)
                const info = await window.logicreader.app.info()
                const report: Record<string, unknown> = { nodes: graph.nodes.length, background }
                let ok = true
                for (const format of ['png', 'jpg'] as const) {
                  const target = info.userDataPath + '/exports/smoke-graph.' + format
                  // 走的就是 UI 那条导出路径（同一个函数）；随后**从磁盘回读**判像素
                  const image = await exportGraphImage(graph.id, format, target)
                  const stat = await window.logicreader.fs.stat(target)
                  const bytes = await window.logicreader.fs.readBinary(target)
                  const sample = await sampleImage(bytes)
                  const sized = sample.width === image.width && sample.height === image.height && sample.width > 0
                  const hasContent = sample.content > 50
                  const cornerOk =
                    format === 'png'
                      ? sample.corner[3] === 0
                      : Math.abs(sample.corner[0] - rgb[0]) <= 12 &&
                        Math.abs(sample.corner[1] - rgb[1]) <= 12 &&
                        Math.abs(sample.corner[2] - rgb[2]) <= 12 &&
                        sample.corner[3] === 255
                  if (!sized || !hasContent || !cornerOk || !stat || stat.size <= 0) ok = false
                  report[format] = {
                    size: stat?.size ?? 0,
                    width: sample.width,
                    height: sample.height,
                    corner: sample.corner,
                    content: sample.content,
                    sized,
                    hasContent,
                    cornerOk
                  }
                }
                await log.write(ok ? 'info' : 'error', 'smoke', (ok ? 'GRAPH_IMAGE_OK ' : 'GRAPH_IMAGE_FAIL ') + JSON.stringify(report))
              } catch (error) {
                await log.write('error', 'smoke', 'GRAPH_IMAGE_FAIL 异常：' + String(error))
              }
            })()
            return
          }
          if (commandId === 'smoke.generateGraph') {
            const forcedAgentId = (payload.args as { agentId?: string } | undefined)?.agentId
          void (async () => {
            const { useTabs } = await import('./state/tabs.store')
            const { useGraph } = await import('./state/graph.store')
            const { openGraphTab } = await import('./commands')
            const tab = useTabs.getState().activeTab()
            const docId = tab && tab.kind !== 'welcome' && tab.kind !== 'settings' ? tab.docId : null
            await window.logicreader.log.write('info', 'smoke', 'graph smoke start docId=' + String(docId))
            if (!docId) return
            openGraphTab(docId)
            await new Promise((resolve) => setTimeout(resolve, 900))
            try {
              // 冒烟：优先用当前选中的真实 Agent（未选中时退回 Mock）
              const { useAgent } = await import('./state/agent.store')
              await useAgent.getState().init()
              await useAgent.getState().refreshAgents(false)
              const agentId = forcedAgentId ?? useAgent.getState().selectedAgentId ?? 'mock'
              await window.logicreader.log.write('info', 'smoke', 'graph smoke agent=' + agentId)
              await useGraph.getState().generate({ docId, agentId, precision: 'structure', concurrency: 2 })
              await window.logicreader.log.write(
                'info',
                'smoke',
                'graph smoke done nodes=' + String(useGraph.getState().graph?.nodes.length ?? -1)
              )
            } catch (error) {
              await window.logicreader.log.write('error', 'smoke', 'graph smoke failed: ' + String(error))
            }
            })()
            return
          }
          /**
           * 拖拽性能自检：证明"拖拽期间不触发 React 渲染"。
           *
           * 判据：
           *  - 拖拽期间 Workbench 渲染次数 **增量 0**、layout store 更新 **增量 0**（只有 CSS 变量在变）；
           *  - 松手后渲染次数 **恰好 +1**（一次提交）；
           *  - 宽度确实变了（否则"没渲染"就只是因为压根没生效）。
           */
          if (commandId === 'smoke.resizeDrag') {
            void (async () => {
              const log = window.logicreader.log
              const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
              try {
                const { useLayout } = await import('./state/layout.store')
                const metrics = (globalThis as unknown as { __lrDragMetrics?: { renders: number; storeUpdates: number } })
                  .__lrDragMetrics
                /**
                 * 用"有没有 data-dragging 属性"来筛，而不是靠 `:not()` 伪类：
                 * 属性存在即为 `false` 字符串，比伪类更稳（本轮就踩过选择器没匹配到）。
                 */
                const all = Array.from(document.querySelectorAll<HTMLElement>('.lr-resizer'))
                const handle = all.find((item) => item.getAttribute('data-dragging') !== 'true')
                if (!metrics || !handle) {
                  await log.write(
                    'error',
                    'smoke',
                    'RESIZE_FAIL 找不到拖拽句柄或指标：' +
                      JSON.stringify({
                        metrics: Boolean(metrics),
                        resizers: all.length,
                        classes: all.map((item) => item.className),
                        auxVisible: useLayout.getState().auxVisible,
                        sidebarVisible: useLayout.getState().sidebarVisible,
                        bodyClasses: Array.from(document.querySelectorAll('.lr-workbench__body > *')).map((n) => (n as HTMLElement).className)
                      })
                  )
                  return
                }
                const before = { renders: metrics.renders, updates: metrics.storeUpdates, width: useLayout.getState().auxWidth }
                const rect = handle.getBoundingClientRect()
                const x = Math.round(rect.left + rect.width / 2)
                const y = Math.round(rect.top + rect.height / 2)
                const fire = (type: string, clientX: number): void => {
                  handle.dispatchEvent(
                    new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', clientX, clientY: y, buttons: 1 })
                  )
                }
                /**
                 * 关键判据：**丢帧不影响结果**。
                 * 先跳 40px、再跳 80px（中间不逐帧移动），最终宽度必须等于
                 * \`起始宽度 + 位移\` —— 增量累加的实现会在这里暴露出来（它只加"相邻两点的差"）。
                 */
                const withMin = 240
                const withMax = 900
                const expected = (deltaX: number): number =>
                  Math.min(withMax, Math.max(withMin, Math.round(before.width + deltaX)))
                /**
                 * 等两帧再量：ResizeHandle 把写入排在 `requestAnimationFrame` 里，
                 * 它的回调排在**当前帧回调之后**，所以只等一帧会量到上一帧的宽度
                 * （本轮就因此误报过一次 `jumpExact:false`）。
                 * 量的时候用 `getBoundingClientRect()`，它会同步刷新布局，量到的一定是新值。
                 */
                const settled = async (): Promise<number> => {
                  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
                  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
                  const element = document.querySelector<HTMLElement>('.lr-auxbar')
                  return element ? Math.round(element.getBoundingClientRect().width) : 0
                }
                fire('pointerdown', x)
                /**
                 * 必须等 `setDragging(true)` 提交后再发第一次移动。
                 * 处理器里是 `if (!dragging) return`，同一 tick 内派发会被丢掉 ——
                 * 真实拖拽人手不可能在同一 tick 按下又移动，所以这是**测试造的事件序列不真实**，
                 * 不是实现的问题（本轮就因此误报过一次 jumpExact:false）。
                 */
                await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
                fire('pointermove', x - 40)
                const widthJump1 = await settled()
                fire('pointermove', x - 120)
                const widthJump2 = await settled()
                // 重复派发同一坐标：绝对定位下必须幂等（增量实现会继续累加）
                fire('pointermove', x - 120)
                const widthRepeat = await settled()
                const during = { renders: metrics.renders, updates: metrics.storeUpdates, width: useLayout.getState().auxWidth }
                fire('pointerup', x - 120)
                await sleep(250)
                const after = { renders: metrics.renders, updates: metrics.storeUpdates, width: useLayout.getState().auxWidth }
                const element = document.querySelector<HTMLElement>('.lr-auxbar')
                const domWidth = element ? Math.round(element.getBoundingClientRect().width) : 0
                const report = {
                  rendersDuringDrag: during.renders - before.renders,
                  storeUpdatesDuringDrag: during.updates - before.updates,
                  rendersOnRelease: after.renders - during.renders,
                  storeUpdatesOnRelease: after.updates - during.updates,
                  widthBefore: before.width,
                  widthAfterCommit: after.width,
                  domWidth,
                  widthChanged: after.width !== before.width,
                  /** 绝对定位的核心判据：跳到某点后宽度就等于"起点宽度 + 位移" */
                  expectJump1: expected(40),
                  actualJump1: widthJump1,
                  expectJump2: expected(120),
                  actualJump2: widthJump2,
                  /** 同一坐标重复派发必须幂等 */
                  actualRepeat: widthRepeat,
                  jumpExact: widthJump1 === expected(40) && widthJump2 === expected(120),
                  idempotent: widthRepeat === widthJump2
                }
                const ok =
                  report.jumpExact &&
                  report.idempotent &&
                  report.rendersDuringDrag === 0 &&
                  report.storeUpdatesDuringDrag === 0 &&
                  report.rendersOnRelease >= 1 &&
                  report.widthChanged
                await log.write(ok ? 'info' : 'error', 'smoke', (ok ? 'RESIZE_OK ' : 'RESIZE_FAIL ') + JSON.stringify(report))
              } catch (error) {
                await log.write('error', 'smoke', 'RESIZE_FAIL 异常：' + String(error))
              }
            })()
            return
          }
          /**
           * 分叉自检：从一个历史会话分叉，断言"确实开了新会话"。
           * 判据取两次会话 id：分叉前（resume 目标的 id）与分叉后（新会话的 id）必须不同。
           */
          if (commandId === 'smoke.forkSession') {
            void (async () => {
              const log = window.logicreader.log
              const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
              try {
                const { useAgent } = await import('./state/agent.store')
                await useAgent.getState().refreshHistory('D:/逻辑阅读器')
                const history = useAgent.getState().history
                const target = history.find((item) => (item.summary ?? '').includes('/context')) ?? history[0]
                if (!target) {
                  await log.write('error', 'smoke', 'FORK_FAIL 没有可用的历史会话')
                  return
                }
                await useAgent.getState().forkSession(target.sessionId)
                await sleep(6000)
                const sessionId = useAgent.getState().sessionId
                const messages = useAgent.getState().messages.length
                const ok = Boolean(sessionId) && sessionId !== target.sessionId
                await log.write(
                  ok ? 'info' : 'error',
                  'smoke',
                  (ok ? 'FORK_OK ' : 'FORK_FAIL ') +
                    JSON.stringify({ forkedFrom: target.sessionId.slice(0, 8), newSession: sessionId, messages })
                )
              } catch (error) {
                await log.write('error', 'smoke', 'FORK_FAIL 异常：' + String(error))
              }
            })()
            return
          }
          /**
           * 逐块回退自检（确定性，不需要真实模型）：
           * 先让 mock 写一个文件（工具卡片上就有 diff 卡片），再回退第一块，
           * 最后断言磁盘内容确实只剩"未回退的那部分"。
           */
          if (commandId === 'smoke.hunkRevert') {
            void (async () => {
              const log = window.logicreader.log
              const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
              try {
                const target = (payload.args as { file?: string } | undefined)?.file ?? 'D:/逻辑阅读器/.smoke-hunk/work/n.txt'
                const { useAgent } = await import('./state/agent.store')
                useAgent.getState().setDraft('mock-write:' + target)
                await sleep(500)
                await log.write('info', 'smoke', 'HUNK_REVERT_STEP write-requested')
                for (let attempt = 0; attempt < 40; attempt += 1) {
                  await sleep(250)
                  const tool = useAgent
                    .getState()
                    .messages.flatMap((message) => message.tools)
                    .find((item) => item.diff && item.diff.hunks.length > 0)
                  if (!tool?.diff) continue
                  const before = tool.diff
                  const result = await useAgent.getState().revertHunks(before.toolUseId, [0])
                  const after = await window.logicreader.fs.readText(target).catch(() => '')
                  const report = {
                    hunks: before.hunks.length,
                    additions: before.additions,
                    deletions: before.deletions,
                    revertOk: result.ok,
                    conflict: result.conflict ?? null,
                    contentAfter: (after ?? '').replace(/\r\n/g, '\\n')
                  }
                  const ok = result.ok && (after ?? '').includes('bravo') && !(after ?? '').includes('CHANGED')
                  await log.write(ok ? 'info' : 'error', 'smoke', (ok ? 'HUNK_REVERT_OK ' : 'HUNK_REVERT_FAIL ') + JSON.stringify(report))
                  return
                }
                await log.write('error', 'smoke', 'HUNK_REVERT_FAIL 没有拿到带差异的工具卡片')
              } catch (error) {
                await log.write('error', 'smoke', 'HUNK_REVERT_FAIL 异常：' + String(error))
              }
            })()
            return
          }
          /**
           * 把"模型"弹层打开并留在界面上（给截图用）——用于确认"角色别名 → 真实模型"的展示。
           */
          /**
           * **回车确定改名**：点 ✎ → 输入 → 按 Enter，逐条断言到 DOM。
           *
           * 这条是用户直接提出的（"重命名支持回车确定"）。之前点 ✎ 会被"点空白关弹层"的
           * window 监听先把弹层关掉，输入框留不住 —— 所以要真的点一次、真的按一次 Enter。
           * 不消耗模型额度。
           */
          if (commandId === 'smoke.historyRenameEnter') {
            void (async () => {
              const log = window.logicreader.log
              const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
              try {
                const { useLayout } = await import('./state/layout.store')
                const { useAgent } = await import('./state/agent.store')
                if (useLayout.getState().auxView !== 'agent' || !useLayout.getState().auxVisible) {
                  useLayout.getState().setAuxView('agent')
                  if (!useLayout.getState().auxVisible) useLayout.getState().toggleAuxBar(true)
                }
                await useAgent.getState().init()
                await useAgent.getState().refreshAgents(false)
                const target =
                  useAgent.getState().agents.find((item) => item.id === 'dsh' && item.capability?.available) ??
                  useAgent.getState().agents.find((item) => item.capability?.available && item.id !== 'mock')
                if (!target) {
                  await log.write('error', 'smoke', 'HISTORY_RENAME_FAIL 没有可用的真实 Agent')
                  return
                }
                if (useAgent.getState().selectedAgentId !== target.id) await useAgent.getState().selectAgent(target.id)

                // 直接放一条假历史（不依赖 ACP：这条冒烟验的是"界面 + 回车 + 落库"，不是列表本身）
                const sessionId = 'smoke-rename-session'
                useAgent.setState({
                  history: [{ sessionId, title: null, titleSource: null, shortId: 'smoke-ren', lastModified: Date.now() }]
                })
                const chip = document.querySelector<HTMLElement>('[data-chip="history"]')
                chip?.click()
                let picker: HTMLElement | null = null
                for (let attempt = 0; attempt < 25; attempt += 1) {
                  picker = document.querySelector<HTMLElement>('.lr-agent__picker')
                  if (picker?.querySelector('.lr-agent__picker-action')) break
                  await sleep(150)
                }
                const renameButton = Array.from(
                  picker?.querySelectorAll<HTMLElement>('.lr-agent__picker-action') ?? []
                ).find((button) => (button.textContent ?? '').includes('改名'))
                if (!renameButton) {
                  await log.write('error', 'smoke', 'HISTORY_RENAME_FAIL 找不到「改名」按钮')
                  return
                }
                renameButton.click()
                let input: HTMLInputElement | null = null
                for (let attempt = 0; attempt < 20; attempt += 1) {
                  input = document.querySelector<HTMLInputElement>('.lr-agent__rename input')
                  if (input) break
                  await sleep(120)
                }
                if (!input) {
                  await log.write('error', 'smoke', 'HISTORY_RENAME_FAIL 点「改名」后输入框没出现（弹层被关掉了？）')
                  return
                }
                // React 受控输入：必须走原生 setter + input 事件，直接改 value 不会被 React 认到
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
                setter?.call(input, '回车改名冒烟')
                input.dispatchEvent(new Event('input', { bubbles: true }))
                await sleep(120)
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
                await sleep(600)
                const title = useAgent.getState().history.find((item) => item.sessionId === sessionId)?.title ?? null
                const stillEditing = Boolean(document.querySelector('.lr-agent__rename input'))
                const ok = title === '回车改名冒烟' && !stillEditing
                await log.write(
                  ok ? 'info' : 'error',
                  'smoke',
                  (ok ? 'HISTORY_RENAME_OK ' : 'HISTORY_RENAME_FAIL ') +
                    JSON.stringify({ title, stillEditing, inputAppeared: true })
                )
              } catch (error) {
                await log.write('error', 'smoke', 'HISTORY_RENAME_FAIL ' + String(error))
              }
            })()
            return
          }

          /**
           * 只做"列出来"：把历史会话的标题与来源写进日志（不给 ACP 通道额外压力，
           * 每次列表都要新起一个 Agent 进程，所以这条特意不含改名/命名等追加动作）。
           */
          if (commandId === 'smoke.historyList') {
            void (async () => {
              const log = window.logicreader.log
              const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
              try {
                const { useAgent } = await import('./state/agent.store')
                await useAgent.getState().init()
                await useAgent.getState().refreshAgents(false)
                const target =
                  useAgent.getState().agents.find((item) => item.id === 'dsh' && item.capability?.available) ??
                  useAgent.getState().agents.find((item) => item.capability?.available && item.id !== 'mock')
                if (!target) {
                  await log.write('error', 'smoke', 'HISTORY_LIST_FAIL 没有可用的真实 Agent')
                  return
                }
                if (useAgent.getState().selectedAgentId !== target.id) await useAgent.getState().selectAgent(target.id)
                await useAgent.getState().refreshHistory('D:\\逻辑阅读器')
                for (let attempt = 0; attempt < 40 && useAgent.getState().history.length === 0; attempt += 1) {
                  await sleep(1000)
                }
                const rows = useAgent.getState().history.slice(0, 30).map((item) => ({
                  id: item.sessionId.slice(0, 8),
                  title: item.title ?? null,
                  source: item.titleSource ?? null
                }))
                await log.write(
                  rows.length > 0 ? 'info' : 'error',
                  'smoke',
                  (rows.length > 0 ? 'HISTORY_LIST_OK ' : 'HISTORY_LIST_FAIL ') +
                    JSON.stringify({ agent: target.id, count: useAgent.getState().history.length, rows })
                )
              } catch (error) {
                await log.write('error', 'smoke', 'HISTORY_LIST_FAIL ' + String(error))
              }
            })()
            return
          }

          /**
           * 历史会话的"总结命名"链路：列出来 → 改名（本地保存）→ 让 Agent 总结命名。
           *
           * `LR_SMOKE_NAME=1` 时才真的让 Agent 总结（那是一次很小的模型调用），
           * 默认只验证"列表 + 改名 + 优先级的落库与回显"。
           */
          if (commandId === 'smoke.historyName') {
            void (async () => {
              const log = window.logicreader.log
              const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
              try {
                const { useAgent } = await import('./state/agent.store')
                await log.write('info', 'smoke', 'HISTORY_NAME_START')
                await useAgent.getState().init()
                await useAgent.getState().refreshAgents(false)
                const store = useAgent.getState()
                /** 优先挑 dsh（用户实际在用的通道），没有就第一个可用的真实 Agent */
                const target =
                  store.agents.find((item) => item.id === 'dsh' && item.capability?.available) ??
                  store.agents.find((item) => item.capability?.available && item.id !== 'mock')
                if (!target) {
                  await log.write('error', 'smoke', 'HISTORY_NAME_FAIL 没有可用的真实 Agent')
                  return
                }
                if (store.selectedAgentId !== target.id) await store.selectAgent(target.id)
                await useAgent.getState().refreshHistory('D:\\逻辑阅读器')
                for (let attempt = 0; attempt < 20; attempt += 1) {
                  if (useAgent.getState().history.length > 0) break
                  await sleep(300)
                }
                const rows = (): { id: string; title: string | null; source: string | null }[] =>
                  useAgent.getState().history.slice(0, 5).map((item) => ({
                    id: item.sessionId,
                    title: item.title ?? null,
                    source: item.titleSource ?? null
                  }))
                const before = rows()
                let renamed: { id: string; title: string | null } | null = null
                if (before.length > 0) {
                  const id = before[0].id
                  await useAgent.getState().renameHistorySession(id, '冒烟：手动改名')
                  /**
                   * 改名后**重新拉一次列表**来确认（而不是只看 store 里那一刻的值：
                   * ACP 列表要新起一个进程，刷新可能还没回来）。从新列表里找不到就再等一下。
                   */
                  let after = useAgent.getState().history.find((item) => item.sessionId === id)
                  for (let attempt = 0; attempt < 10 && !after; attempt += 1) {
                    await useAgent.getState().refreshHistory('D:\\逻辑阅读器')
                    after = useAgent.getState().history.find((item) => item.sessionId === id)
                    if (!after) await sleep(500)
                  }
                  renamed = { id, title: after?.title ?? null }
                }
                const ok = before.length > 0 && renamed?.title === '冒烟：手动改名'
                await log.write(
                  ok ? 'info' : 'error',
                  'smoke',
                  (ok ? 'HISTORY_NAME_OK ' : 'HISTORY_NAME_FAIL ') +
                    JSON.stringify({ agent: target.id, before, renamed })
                )
              } catch (error) {
                await log.write('error', 'smoke', 'HISTORY_NAME_FAIL ' + String(error))
              }
            })()
            return
          }

          /**
           * 让 Agent 给历史会话"总结命名"（**会真的调用一次模型**，只在需要时手动跑）。
           * 渲染进程读不到环境变量，所以单独做成一条冒烟命令。
           */
          if (commandId === 'smoke.historyAiName') {
            void (async () => {
              const log = window.logicreader.log
              const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
              try {
                const { useAgent } = await import('./state/agent.store')
                await useAgent.getState().init()
                await useAgent.getState().refreshAgents(false)
                const target =
                  useAgent.getState().agents.find((item) => item.id === 'dsh' && item.capability?.available) ??
                  useAgent.getState().agents.find((item) => item.capability?.available && item.id !== 'mock')
                if (!target) {
                  await log.write('error', 'smoke', 'HISTORY_AI_NAME_FAIL 没有可用的真实 Agent')
                  return
                }
                if (useAgent.getState().selectedAgentId !== target.id) await useAgent.getState().selectAgent(target.id)
                await useAgent.getState().refreshHistory('D:\\逻辑阅读器')
                for (let attempt = 0; attempt < 25 && useAgent.getState().history.length === 0; attempt += 1) {
                  await sleep(400)
                }
                const first = useAgent.getState().history[0]
                if (!first) {
                  await log.write('error', 'smoke', 'HISTORY_AI_NAME_FAIL 没有历史会话')
                  return
                }
                const title = await useAgent.getState().nameHistorySession(first.sessionId, first.firstPrompt ?? null)
                const after = useAgent.getState().history.find((item) => item.sessionId === first.sessionId)
                await log.write(
                  title ? 'info' : 'error',
                  'smoke',
                  (title ? 'HISTORY_AI_NAME_OK ' : 'HISTORY_AI_NAME_FAIL ') +
                    JSON.stringify({ agent: target.id, sessionId: first.sessionId, title, stored: after?.title ?? null })
                )
              } catch (error) {
                await log.write('error', 'smoke', 'HISTORY_AI_NAME_FAIL ' + String(error))
              }
            })()
            return
          }

          /**
           * Agent 输出的 **markdown 渲染**（对话正文 + 计划卡片）。
           *
           * 不消耗任何模型额度：直接往 store 里塞一条"模型会回的那种 markdown"和一个待批方案，
           * 然后断言 DOM 里**真的渲染出了元素**（h2 / 表格 / 代码块），并且**不再出现裸语法**
           * （面板文本里不该有 `## ` 或 `| --- |` 这种源码）。截图留档。
           */
          if (commandId === 'smoke.agentRender') {
            void (async () => {
              const log = window.logicreader.log
              const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
              const SAMPLE = [
                '## 结论',
                '',
                '先给结论：**SFT 与 RL 是分工关系**，不是替代关系（见下表）。',
                '',
                '| 方法 | 作用 | 局限 |',
                '| --- | --- | --- |',
                '| SFT | 提供初始策略 | 只约束 token 级分布 |',
                '| GRPO | 修正组合泛化 | 依赖可靠的奖励 |',
                '',
                '> 引用：`teacher forcing` 训练用 gold 前缀，推理用自己生成的 token。',
                '',
                '1. 第一点说明监督粒度；',
                '2. 第二点说明曝光偏差；',
                '3. 第三点说明分桶后的差距。'
              ].join('\n')
              const PLAN = [
                '### 实施计划',
                '',
                '1. 先读 `graph.service.ts` 的抽取入口，确认分块与重试边界；',
                '2. 再把整批丢弃改成逐块留痕；',
                '3. 最后补一条单测覆盖"校验失败仍要出图"。'
              ].join('\n')
              try {
                const { useLayout } = await import('./state/layout.store')
                const { useAgent } = await import('./state/agent.store')
                if (useLayout.getState().auxView !== 'agent' || !useLayout.getState().auxVisible) {
                  useLayout.getState().setAuxView('agent')
                  if (!useLayout.getState().auxVisible) useLayout.getState().toggleAuxBar(true)
                }
                await useAgent.getState().init()
                useAgent.setState({
                  messages: [
                    {
                      id: 'smoke_user',
                      role: 'user',
                      content: '用 markdown 说明一下 SFT 与 RL 的分工。',
                      thinking: '',
                      tools: [],
                      createdAt: Date.now() - 1000,
                      status: 'done'
                    },
                    {
                      id: 'smoke_assistant',
                      role: 'assistant',
                      content: SAMPLE,
                      thinking: '',
                      tools: [],
                      createdAt: Date.now(),
                      status: 'done'
                    }
                  ],
                  pendingPlan: { messageId: 'smoke_assistant', plan: PLAN, filePath: null },
                  streaming: false
                })
                let panel: HTMLElement | null = null
                for (let attempt = 0; attempt < 25; attempt += 1) {
                  panel = document.querySelector<HTMLElement>('.lr-agent')
                  if (panel?.querySelector('.lr-md h2')) break
                  await sleep(200)
                }
                const headings = panel?.querySelectorAll('.lr-md h2').length ?? 0
                const tables = panel?.querySelectorAll('.lr-md table').length ?? 0
                const code = panel?.querySelectorAll('.lr-md code').length ?? 0
                const planRendered = Boolean(panel?.querySelector('.lr-plancard__body .lr-md h3'))
                const bodyText = (panel?.textContent ?? '').replace(/\s+/g, ' ')
                // 裸语法：标题与表格分隔行不该以源码形式出现在文本里
                const rawHeading = bodyText.includes('## 结论')
                const rawRule = bodyText.includes('| --- |')
                // 正文里应有 h2（`## 结论`），计划卡片里应有 h3（`### 实施计划`）—— 分开断言
                const ok = headings >= 1 && tables >= 1 && code >= 1 && planRendered && !rawHeading && !rawRule
                await log.write(
                  ok ? 'info' : 'error',
                  'smoke',
                  (ok ? 'AGENT_RENDER_OK ' : 'AGENT_RENDER_FAIL ') +
                    JSON.stringify({ headings, tables, code, planRendered, rawHeading, rawRule })
                )
              } catch (error) {
                await log.write('error', 'smoke', 'AGENT_RENDER_FAIL ' + String(error))
              }
            })()
            return
          }

          /**
           * Agent 选择器（输入区那颗 Agent 芯片点开的那层）：把每个通道列出来给截图用。
           *
           * 这是用户最常看的一处（"到底有哪些 Agent 能用"），以前只列可用通道，
           * 装了却没找到的就直接消失 —— 所以这条冒烟既断言 dsh 在列表里，也把整层留在界面上。
           */
          if (commandId === 'smoke.agentPicker') {
            void (async () => {
              const log = window.logicreader.log
              const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
              try {
                const { useLayout } = await import('./state/layout.store')
                const { useAgent } = await import('./state/agent.store')
                if (useLayout.getState().auxView !== 'agent' || !useLayout.getState().auxVisible) {
                  useLayout.getState().setAuxView('agent')
                  if (!useLayout.getState().auxVisible) useLayout.getState().toggleAuxBar(true)
                }
                await useAgent.getState().init()
                await useAgent.getState().refreshAgents(false)
                let panel: HTMLElement | null = null
                for (let attempt = 0; attempt < 25; attempt += 1) {
                  panel = document.querySelector<HTMLElement>('.lr-agent')
                  if (panel) break
                  await sleep(200)
                }
                const chip = panel?.querySelector<HTMLElement>('[data-chip="agent"]')
                if (!chip) {
                  await log.write('error', 'smoke', 'AGENT_PICKER_FAIL 找不到 Agent 芯片')
                  return
                }
                chip.click()
                let picker: HTMLElement | null = null
                for (let attempt = 0; attempt < 15; attempt += 1) {
                  picker = panel?.querySelector<HTMLElement>('.lr-agent__picker') ?? null
                  if (picker) break
                  await sleep(150)
                }
                const rows = Array.from(picker?.querySelectorAll<HTMLElement>('.lr-agent__picker-item') ?? []).map((row) => ({
                  name: (row.querySelector('.lr-agent__picker-name')?.textContent ?? '').trim(),
                  disabled: row.getAttribute('data-disabled') === 'true'
                }))
                const dsh = rows.find((row) => row.name.toLowerCase().includes('deepseek'))
                const ok = Boolean(picker) && Boolean(dsh) && !dsh?.disabled
                await log.write(
                  ok ? 'info' : 'error',
                  'smoke',
                  (ok ? 'AGENT_PICKER_OK ' : 'AGENT_PICKER_FAIL ') + JSON.stringify({ rows, dsh: dsh ?? null })
                )
              } catch (error) {
                await log.write('error', 'smoke', 'AGENT_PICKER_FAIL ' + String(error))
              }
            })()
            return
          }

          /**
           * 设置 → Agent 管理器：验证"每个 Agent 的可用性与路径"真的看得见。
           * 这是本轮新增的界面（用户反馈"装好了却显示不可用，无从下手"时的唯一入口），
           * 所以要有一条能把它的行数与 dsh 状态写进日志、并留下截图的冒烟。
           */
          if (commandId === 'smoke.agentManager') {
            void (async () => {
              const log = window.logicreader.log
              const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
              try {
                const { useTabs } = await import('./state/tabs.store')
                const { useUiStore } = await import('./state/ui.store')
                const { useAgent } = await import('./state/agent.store')
                await useAgent.getState().init()
                await useAgent.getState().refreshAgents(false)
                useUiStore.getState().setSettingsCategory('agent')
                const tabs = useTabs.getState()
                const existing = tabs.groups.flatMap((group) => group.tabs).find((tab) => tab.kind === 'settings')
                if (existing) tabs.activate(existing.id)
                else tabs.openTab({ kind: 'settings', id: 'tab_smoke_settings' })

                let rows: HTMLElement[] = []
                for (let attempt = 0; attempt < 30; attempt += 1) {
                  rows = Array.from(document.querySelectorAll<HTMLElement>('.lr-agent-manager__item'))
                  if (rows.length > 0) break
                  await sleep(200)
                }
                const report = rows.map((row) => ({
                  name: (row.querySelector('.lr-agent-manager__name')?.textContent ?? '').trim(),
                  available: row.getAttribute('data-available') === 'true',
                  version: (row.querySelector('.lr-setting__hint')?.textContent ?? '').trim()
                }))
                const dsh = report.find((item) => item.name.toLowerCase().includes('deepseek'))
                const ok = rows.length > 0 && Boolean(dsh)
                await log.write(
                  ok ? 'info' : 'error',
                  'smoke',
                  (ok ? 'AGENT_MANAGER_OK ' : 'AGENT_MANAGER_FAIL ') +
                    JSON.stringify({ rows: report.length, dsh: dsh ?? null, report })
                )
              } catch (error) {
                await log.write('error', 'smoke', 'AGENT_MANAGER_FAIL ' + String(error))
              }
            })()
            return
          }

          if (commandId === 'smoke.modelPicker') {
            void (async () => {
              const log = window.logicreader.log
              const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
              try {
                const { useAgent } = await import('./state/agent.store')
                await useAgent.getState().init()
                await useAgent.getState().refreshAgents(false)
                for (let attempt = 0; attempt < 25; attempt += 1) {
                  if (useAgent.getState().resolvedModels.length > 0) break
                  await sleep(400)
                }
                const rows = useAgent.getState().resolvedModels.map((item) => item.id + '→' + String(item.resolvedModel))
                await log.write('info', 'smoke', 'MODEL_PICKER rows=' + rows.length + ' ' + JSON.stringify(rows))
                const buttons = Array.from(document.querySelectorAll<HTMLElement>('.lr-agent__chip'))
                const modelButton = buttons.find((button) => button.title.includes('→') || button.title.includes('模型'))
                modelButton?.click()
              } catch (error) {
                await log.write('error', 'smoke', 'MODEL_PICKER 失败：' + String(error))
              }
            })()
            return
          }
          /**
           * 把"引用文件"面板打开并留在界面上（给截图用）。
           * 界面按"当前文档所在目录"取候选，没有文档时为空 —— 这里显式传目录，
           * 属于冒烟脚本的便利，不代表产品行为。
           */
          if (commandId === 'smoke.atPalette') {
            void (async () => {
              const log = window.logicreader.log
              const { useAgent } = await import('./state/agent.store')
              await useAgent.getState().init()
              const files = await useAgent.getState().queryFiles('D:/逻辑阅读器', '')
              await log.write('info', 'smoke', 'AT_PALETTE files=' + files.length)
              useAgent.getState().setDraft('看看 @ARCHITECTURE')
            })()
            return
          }
          /**
           * 只把斜杠面板打开并**留在界面上**（给截图用）。
           * 与 smoke.agentUi 分开：那个会做一堆点击，最后把草稿清掉，截不到面板。
           */
          if (commandId === 'smoke.slashPalette') {
            void (async () => {
              const log = window.logicreader.log
              const { useAgent } = await import('./state/agent.store')
              await useAgent.getState().init()
              await useAgent.getState().refreshAgents(false)
              for (let attempt = 0; attempt < 25; attempt += 1) {
                if (useAgent.getState().commands.length > 0) break
                await new Promise((resolve) => setTimeout(resolve, 400))
              }
              useAgent.getState().setDraft('/')
              await log.write('info', 'smoke', 'SLASH_PALETTE_OPEN commands=' + useAgent.getState().commands.length)
            })()
            return
          }
          /**
           * Agent 面板形态自检。
           *
           * 断言的是"界面结构"而不是像素：面板在、空态是欢迎块、输入区与模式按钮在，
           * 模式弹层能开、项数与当前选中正确、点一条能真的改到 store 并写进快照。
           * 这样以后改样式（最容易把按钮改没的东西）时，破坏会立刻变成一条 FAIL 日志。
           */
          if (commandId === 'smoke.agentUi') {
            void (async () => {
              const log = window.logicreader.log
              const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
              const text = (element: Element | null): string => (element?.textContent ?? '').replace(/\s+/g, ' ').trim()
              const rawKey = (value: string): boolean => /(?:^|\s)(?:agent|graph|settings|common|cmd|command|sideBar|panel|reader)\.[a-zA-Z][\w.]*/.test(value)
              try {
                const { useLayout } = await import('./state/layout.store')
                if (useLayout.getState().auxView !== 'agent' || !useLayout.getState().auxVisible) {
                  useLayout.getState().setAuxView('agent')
                  if (!useLayout.getState().auxVisible) useLayout.getState().toggleAuxBar(true)
                }
                const { useAgent } = await import('./state/agent.store')
                await useAgent.getState().init()
                await useAgent.getState().refreshAgents(false)
                // 稳定性 > 速度：Agent 面板可能刚挂载，给它几轮机会
                let panel: HTMLElement | null = null
                for (let attempt = 0; attempt < 20; attempt += 1) {
                  panel = document.querySelector<HTMLElement>('.lr-agent')
                  if (panel) break
                  await sleep(200)
                }
                if (!panel) {
                  await log.write('error', 'smoke', 'AGENT_UI_FAIL 找不到 .lr-agent 面板（辅助侧边栏没挂上？）')
                  return
                }
                const modeButton = panel.querySelector<HTMLElement>('.lr-agent__mode')
                const composer = panel.querySelector<HTMLElement>('.lr-agent__input textarea')
                const sendButton = panel.querySelector<HTMLElement>('.lr-agent__send')
                // 1) 固定结构：输入区、模式按钮、发送按钮
                if (!modeButton || !composer || !sendButton) {
                  await log.write(
                    'error',
                    'smoke',
                    'AGENT_UI_FAIL 结构缺失 ' +
                      JSON.stringify({ mode: Boolean(modeButton), composer: Boolean(composer), send: Boolean(sendButton) })
                  )
                  return
                }
                // 2) 空态必须是"欢迎块"，有对话时不许再显示
                const welcome = panel.querySelector('.lr-agent__welcome')
                const empty = useAgent.getState().messages.length === 0
                if (empty !== Boolean(welcome)) {
                  await log.write(
                    'error',
                    'smoke',
                    'AGENT_UI_FAIL 空态判定不一致 empty=' + String(empty) + ' welcome=' + String(Boolean(welcome))
                  )
                  return
                }
                // 3) 模式弹层：能开、项数对、当前项有勾
                //    点开以后**轮询**等它出现：React 的挂载时机不是同步的，
                //    固定 sleep 在慢机器上会变成假失败（本轮就踩过一次）。
                modeButton.click()
                let items: HTMLElement[] = []
                for (let attempt = 0; attempt < 10; attempt += 1) {
                  // 必须限定在弹出的**同一个** picker 里：模式弹层与模型弹层用的是同一套 class，
                  // 只按 .lr-agent__picker-item 取会把模型清单当成档位清单（本轮误报过一次）
                  items = Array.from(document.querySelectorAll<HTMLElement>('.lr-agent__popover .lr-agent__picker-item'))
                  if (items.length > 0) break
                  await sleep(80)
                }
                const popover = document.querySelector('.lr-agent__popover')
                const names = items.map((item) => text(item.querySelector('.lr-agent__picker-name')))
                const descriptions = items.map((item) => text(item.querySelector('.lr-agent__picker-desc')))
                const activeIndex = items.findIndex((item) => item.dataset.active === 'true')
                // 不写死顺序：从共享的 PERMISSION_MODES 推期望值，改顺序时断言不会变成误报
                const modes = PERMISSION_MODES
                const expected = modes.map((mode) => t('agent.mode.' + mode + '.name'))
                const namesOk = names.length === modes.length && names.every((name, index) => name === expected[index])
                const activeOk = activeIndex === modes.indexOf(useAgent.getState().permissionMode)
                const descOk = descriptions.every((value) => value.length > 0)
                /**
                 * 4) 点一个**与当前不同**的档位：必须真的改到 store，并且**把旧会话关掉**
                 *    （写权限在会话建立时就声明过了，不换会话就会出现"切了自动档却写不了文件"）。
                 *    不能写死点"自动"：当前档位本来就是自动时点击是幂等 no-op，
                 *    sessionRebuilt 理应为 false —— 本轮因此误报过一次 FAIL。
                 */
                const sessionBefore = useAgent.getState().sessionId
                const modeBefore = useAgent.getState().permissionMode
                const targetIndex = items.findIndex((item) => item.dataset.active !== 'true')
                const targetItem = items[targetIndex] ?? items[0]
                const targetName = names[targetIndex] ?? ''
                targetItem.click()
                await sleep(200)
                const modeAfter = useAgent.getState().permissionMode
                const modeChanged = modeAfter !== modeBefore
                const labelOk = targetName.length > 0 && (modeButton.textContent ?? '').includes(targetName)
                const sessionRebuilt = sessionBefore === null || useAgent.getState().sessionId === null
                // 5) 还原成冒烟前的档位（不要写死 manual：那会把用户/用例的初始状态改掉，
                //    本轮就因此把"计划模式"的截图和断言弄成了手动）
                await useAgent.getState().setPermissionMode(modeBefore)
                await sleep(120)
                const restored = useAgent.getState().permissionMode === modeBefore
                const leftovers = Array.from(document.querySelectorAll<HTMLElement>('.lr-agent *'))
                  .map((item) => text(item))
                  .filter((value) => rawKey(value))
                /**
                 * 文案键泄漏要查得比面板更宽：
                 * 本轮就是靠这条发现菜单/侧边栏里的 graph.show 一直是裸露的键名
                 * （i18next 缺键会原样返回键名，界面上看起来只是"文字怪怪的"）。
                 */
                const chromeLeaks = Array.from(
                  document.querySelectorAll<HTMLElement>(
                    '.lr-titlebar *, .lr-sidebar *, .lr-auxbar__header *, .lr-statusbar *, .lr-activitybar *'
                  )
                )
                  .map((item) => text(item))
                  .filter((value) => rawKey(value) && value.length < 60)
                /** 历史会话：能不能从 CLI 的会话记录里读到（与 VS Code 共用同一份） */
                await useAgent.getState().refreshHistory('D:/逻辑阅读器')
                const historyCount = useAgent.getState().history.length
                /**
                 * 模型：换 API 之后必须能显示"角色别名 → 真实模型"，以及**当前实际在跑**的模型。
                 * 这两个值都来自 CLI（supportedModels().resolvedModel / system\/init.model），界面不得自己编。
                 */
                /**
                 * 等模型清单刷新落地再断言：它由 `system/init` 事件触发，
                 * 而那份清单要跨 IPC 走一趟（本轮就因为在这里读早了而误报过一次 modelResolved:0）。
                 */
                let modelRows: { id: string; real: string | null }[] = []
                for (let attempt = 0; attempt < 20; attempt += 1) {
                  modelRows = useAgent
                    .getState()
                    .resolvedModels.map((item) => ({ id: item.id, real: item.resolvedModel ?? null }))
                  if (modelRows.some((row) => row.real)) break
                  await sleep(250)
                }
                const activeModel = useAgent.getState().activeModel
                const modelsRevision = useAgent.getState().modelsRevision
                /** "@ 文件引用"：主进程的工作区索引能否返回候选，面板能否开出来 */
                const fileHits = await useAgent.getState().queryFiles('D:/逻辑阅读器', 'ARCHITECTURE')
                /**
                 * 面板渲染单独验证：没有打开文档时 workspaceDir() 是空的（设计如此），
                 * 所以这里用"先关掉其它弹层再让面板自己查一次"的方式，避免把两件事混在一个断言里。
                 */
                const atItems: string[] = []
                if (fileHits.length > 0) {
                  useAgent.getState().setDraft('看看 @ARCH')
                  for (let attempt = 0; attempt < 12; attempt += 1) {
                    await sleep(120)
                    const found = Array.from(
                      document.querySelectorAll<HTMLElement>('.lr-agent__popover .lr-agent__picker-name')
                    ).map((item) => text(item))
                    if (found.length > 0) {
                      atItems.push(...found)
                      break
                    }
                  }
                  useAgent.getState().setDraft('')
                  await sleep(80)
                }
                /** 斜杠命令面板：命令清单是否真的从 CLI 下发、面板能否开出来 */
                const storeCommands = useAgent.getState().commands.length
                useAgent.getState().setDraft('/')
                await sleep(150)
                const slashItems = Array.from(
                  document.querySelectorAll<HTMLElement>('.lr-agent__popover .lr-agent__picker-item')
                ).map((item) => text(item.querySelector('.lr-agent__picker-name')))
                useAgent.getState().setDraft('')
                await sleep(80)
                const permissionCards = Array.from(document.querySelectorAll<HTMLElement>('.lr-permission')).map((card) =>
                  text(card.querySelector('.lr-permission__title'))
                )
                // 内联差异卡片（VS Code 招牌交互）：有改动就必须看得见
                const diffCards = Array.from(document.querySelectorAll<HTMLElement>('.lr-diffcard')).map((card) => ({
                  file: text(card.querySelector('.lr-diffcard__file')),
                  added: text(card.querySelector('.lr-diffcard__plus')),
                  removed: text(card.querySelector('.lr-diffcard__minus')),
                  rows: card.querySelectorAll('.lr-diffrow').length,
                  hunkHeads: Array.from(card.querySelectorAll('.lr-diffhunk__head')).map((h) => text(h))
                }))
                const report = {
                  empty,
                  permissionCards: permissionCards.length,
                  diffCards: diffCards.length,
                  slashCommandCount: storeCommands,
                  historyCount,
                  activeModel,
                  modelsRevision,
                  modelResolved: modelRows.filter((row) => row.real).length,
                  modelTotal: modelRows.length,
                  modelSample: modelRows.slice(0, 3).map((row) => row.id + '→' + String(row.real)),
                  fileIndexHits: fileHits.length,
                  fileIndexSample: fileHits.slice(0, 2).map((file) => file.path),
                  atMentionItems: atItems.slice(0, 2),
                  slashPaletteItems: slashItems.length,
                  slashPaletteSample: slashItems.slice(0, 3),
                  diffSample: diffCards.slice(0, 2),
                  permissionCardTitles: permissionCards.slice(0, 2),
                  welcomeTitle: text(panel.querySelector('.lr-agent__welcome-title')),
                  modeLabel: text(modeButton),
                  modeInDom: modeButton.dataset.mode ?? null,
                  modeInStore: useAgent.getState().permissionMode,
                  names,
                  descriptions: descriptions.length,
                  activeIndex,
                  popoverFound: Boolean(popover),
                  modeAfterClick: modeAfter,
                  modeTarget: targetName,
                  modeChanged,
                  sessionRebuilt,
                  restored,
                  rawKeyLeaks: leftovers.length,
                  chromeKeyLeaks: chromeLeaks.length,
                  chromeLeakSample: chromeLeaks.slice(0, 3),
                  panelWidth: Math.round(panel.getBoundingClientRect().width)
                }
                const ok =
                  Boolean(popover) &&
                  namesOk &&
                  activeOk &&
                  descOk &&
                  modeChanged &&
                  labelOk &&
                  sessionRebuilt &&
                  restored &&
                  leftovers.length === 0 &&
                  chromeLeaks.length === 0
                await log.write(ok ? 'info' : 'error', 'smoke', (ok ? 'AGENT_UI_OK ' : 'AGENT_UI_FAIL ') + JSON.stringify(report))
              } catch (error) {
                await log.write('error', 'smoke', 'AGENT_UI_FAIL 异常：' + String(error))
              }
            })()
            return
          }
          // 其它命令：直接交给命令系统执行（便于自动化验证快捷键行为）
          if (commandId.startsWith('smoke.')) return
          void (async () => {
            const { executeCommand } = await import('./state/commands.store')
            await executeCommand(commandId, payload.args)
          })()
        })
        await window.logicreader.log.write('info', 'renderer', '界面已就绪（workbench mounted）')
      } catch (error) {
        setBootError(error instanceof Error ? error.message : String(error))
      }
    }
    void boot()
  }, [t])

  if (bootError) {
    return (
      <div className="lr-boot-error">
        <h1>LogicReader</h1>
        <p>启动失败：{bootError}</p>
      </div>
    )
  }

  if (!ready) {
    return <div className="lr-boot-splash">LogicReader</div>
  }

  return (
    <ErrorBoundary>
      <Workbench />
      {showWizard ? (
        <FirstRunWizard
          onDone={() => {
            setShowWizard(false)
          }}
        />
      ) : null}
      <CommandPalette />
      <QuickOpen />
      <Notifications />
    </ErrorBoundary>
  )
}

export { CMD }
