import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { AnnotationRecord, PdfDarkMode, ReaderTab } from '@logicreader/shared'
import { createAnchor, describeLocator, pageForChar, type DocumentModel, type Rect } from '@logicreader/document-model'
import { api } from '../../../lib/api'
import { loadPdfDocument, releasePdfDocument, getPdfLayout, pdfjsLib } from '../../../lib/pdfjs'
import { expandRevealRange } from '@logicreader/document-model'
import { confirmFragments, rangeForChars, resolveDomSelection } from '../../../lib/selection'
import { useRevealRequest } from '../../../lib/revealRequest'
import { useZoomAnchor } from '../../../lib/zoomAnchor'
import { TEXT_LAYER_MAPPING_VERSION } from '../../../lib/textLayerMapping'
import { parsePdfDocument } from '../../../parsers/pdf'
import { useDocuments } from '../../../state/documents.store'
import { useSettings } from '../../../state/settings.store'
import { useUiStore } from '../../../state/ui.store'
import { useTabs } from '../../../state/tabs.store'
import { useNotifications } from '../../../state/notifications.store'
import { registerReaderController } from '../../../state/readerBridge'
import { PdfPageView, type PageAnnotationMark } from './PdfPageView'
import { SelectionToolbar } from '../SelectionToolbar'
import { ZoomInput, clampZoom } from '../ZoomInput'
import { exportAnnotatedPdf, type ExportAnnotation } from './pdfExport'
import { PdfRail } from './PdfRail'
import { notify } from '../../../state/notifications.store'
import i18n from '../../../i18n'

type ZoomSetting = number | 'fit-width' | 'fit-page' | 'actual'

/**
 * 双页时两页之间的中缝宽度（px）。
 * ★ 必须与 `pdf.css` 里 `.lr-pdf-spread { gap }` 一致 ——
 * 不一致时"适应页面"算出来的宽度装不下实际内容（差几像素就出横向滚动条）。
 */
const SPREAD_GAP = 14

interface Props {
  tab: ReaderTab
  model: DocumentModel
}

const HIGHLIGHT_COLORS = ['#ffd666', '#8ce99a', '#74c0fc', '#f783ac']

/** 选区链路诊断（每次会话最多 30 条，避免刷屏） */
let diagCount = 0
function diagSelection(message: string): void {
  if (diagCount > 30) return
  diagCount += 1
  const api = (globalThis as { logicreader?: { log: { write: (...args: unknown[]) => Promise<void> } } }).logicreader
  void api?.log.write('info', 'reader', 'drag: ' + message)
}

/** 正在补建文本层映射的文档（避免并发重复解析） */
const layoutPrep = new Set<string>()

function logToMain(level: 'info' | 'warn', scope: string, message: string): void {
  const api = (globalThis as { logicreader?: { log: { write: (...args: unknown[]) => Promise<void> } } }).logicreader
  void api?.log.write(level, scope, message)
}

export function PdfReaderView({ tab, model }: Props): JSX.Element {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(tab.view.page || 1)
  const [zoom, setZoom] = useState<ZoomSetting>((tab.view.zoom as ZoomSetting) ?? 'fit-width')
  const [rotation, setRotation] = useState<number>(tab.view.rotation ?? 0)
  const [viewMode, setViewMode] = useState<'single' | 'continuous' | 'spread'>(tab.view.viewMode ?? 'continuous')
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const [containerWidth, setContainerWidth] = useState(900)
  const [containerHeight, setContainerHeight] = useState(700)
  const [findQuery, setFindQuery] = useState('')
  const [findIndex, setFindIndex] = useState(0)
  const [annotations, setAnnotations] = useState<AnnotationView[]>([])
  const [activeAnnotation, setActiveAnnotation] = useState<string | null>(tab.view.activeAnnotationId)
  const [colorIndex, setColorIndex] = useState(0)
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null)
  const [flashRange, setFlashRange] = useState<{ charStart: number; charEnd: number } | null>(null)
  /**
   * 跳转落点：**只记页号与字符区间，不记像素矩形**。
   *
   * 矩形由 `PdfPageView` 在文本层每次重建完成后按**当前缩放 / 旋转**重新量一次
   * （见 PdfPageView 的 `flashRects`）。旧实现把"跳转那一刻"的像素矩形存在这里：
   * 缩放后页面重新排版、矩形却停在原地 —— 就是"高亮区域不随缩放变化"。
   */
  const [flashTarget, setFlashTarget] = useState<{ page: number; charStart: number; charEnd: number; hold: boolean } | null>(null)
  const flashTimerRef = useRef<number | null>(null)
  const { settings } = useSettings()
  const setReaderProgress = useUiStore((s) => s.setReaderProgress)
  const setActiveReaderTab = useUiStore((s) => s.setActiveReaderTab)
  const setSelection = useUiStore((s) => s.setSelection)
  const storedSelection = useUiStore((s) => s.selection)
  /** 文本层渲染计数：每次渲染完成后尝试恢复原生选区 */
  const [renderTick, setRenderTick] = useState(0)
  /** 布局缓存（文本层映射）就绪计数 */
  const [layoutTick, setLayoutTick] = useState(0)
  /** 稳定回调：避免子组件副作用被父组件渲染反复触发（React #185） */
  const notifyTextLayerReady = useCallback(() => setRenderTick((tick) => tick + 1), [])
  const updateReaderView = useTabs((s) => s.updateReaderView)
  const documents = useDocuments()

  const pageSizes = useMemo(() => getPdfLayout(model.docId)?.pageSizes ?? [], [model.docId, doc])

  // ------------------------------------------------------------ 加载文档
  useEffect(() => {
    let disposed = false
    setError(null)
    void loadPdfDocument(model.docHash, () => api.fs.readBinary(tab.filePath))
      .then((loaded) => {
        if (!disposed) setDoc(loaded)
      })
      .catch((reason: unknown) => {
        if (disposed) return
        const name = (reason as { name?: string })?.name
        if (name === 'PasswordException') setError(t('reader.passwordProtected'))
        else setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      disposed = true
      releasePdfDocument(model.docHash)
    }
  }, [model.docHash, tab.filePath, t])

  /**
   * 文本层映射准备。
   *
   * 正常路径（解析器 v4 起）：偏移表随 model.meta.textLayerMapping 持久化，
   * 命中数据库缓存的文档**打开即可选**，不会有任何空窗期。
   * 这里只在"旧缓存文档没有该字段"时补跑一次解析（结果只用于内存映射），
   * 并明确记录走的是哪条路径 —— 此前只有一句"缺少偏移表"，排查时完全看不出原因。
   */
  useEffect(() => {
    if (!doc) return
    const mapping = (model.meta as { textLayerMapping?: { version?: number } } | undefined)?.textLayerMapping
    const hasMapping = Boolean(mapping && mapping.version === TEXT_LAYER_MAPPING_VERSION)
    if (hasMapping || getPdfLayout(model.docId)) {
      // 已有映射（持久化或本次会话已解析过）：通知已渲染的页面补写定位属性
      setLayoutTick((tick) => (tick === 0 ? tick + 1 : tick))
      return
    }
    if (layoutPrep.has(model.docId)) return
    layoutPrep.add(model.docId)
    let disposed = false
    void (async () => {
      try {
        const rebuilt = await parsePdfDocument({
          filePath: tab.filePath,
          docId: model.docId,
          docHash: model.docHash,
          format: 'pdf',
          title: model.title
        })
        if (disposed) return
        /**
         * 把补建出来的映射并回**当前模型**（只并映射，不动块与正文）。
         * 各页的偏移都是"解析那一刻的全文绝对偏移"，只要并入的是同一份正文就成立；
         * 若不并回去，页面在解析完成前用现算兜底就会算错（第 2 页起整页偏移）。
         */
        useDocuments.getState().mergeTextLayerMapping(model.docId, rebuilt.meta.textLayerMapping)
        logToMain('info', 'reader', '旧缓存文档补建 PDF 文本层映射：' + model.title)
        setLayoutTick((tick) => tick + 1)
      } catch (error) {
        logToMain('warn', 'reader', '补建 PDF 文本层映射失败：' + String(error))
      } finally {
        layoutPrep.delete(model.docId)
      }
    })()
    return () => {
      disposed = true
    }
  }, [doc, model.docId, model.docHash, model.title, tab.filePath])

  // 容器尺寸：用回调 ref，保证元素真正挂载后再观测（加载态下没有该元素）
  useEffect(() => {
    if (!scrollElement) return
    const measure = (): void => {
      setContainerWidth(scrollElement.clientWidth)
      setContainerHeight(scrollElement.clientHeight)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(scrollElement)
    measure()
    return () => observer.disconnect()
  }, [scrollElement])

  const baseSize = pageSizes[0] ?? { width: 595, height: 842 }

  /**
   * 单页实际占的盒子 = **旋转之后**的尺寸。
   * `PdfPageView` 用 `page.getViewport({ scale, rotation })` 渲染，fit 必须按同一个盒子算 ——
   * 拿未旋转的尺寸去 fit，旋转 90° 之后页面就会横向溢出（宽高互换了）。
   */
  const pageBox = useMemo(() => {
    const swapped = rotation === 90 || rotation === 270
    return swapped
      ? { width: baseSize.height, height: baseSize.width }
      : { width: baseSize.width, height: baseSize.height }
  }, [baseSize.width, baseSize.height, rotation])

  /**
   * fit 要装下的东西：双页模式下是**一对页**（宽 = 两页 + 中缝，高 = 一页），
   * 单页/连续模式下就是一页。
   */
  const fitBox = useMemo(
    () =>
      viewMode === 'spread'
        ? { width: pageBox.width * 2 + SPREAD_GAP, height: pageBox.height }
        : pageBox,
    [pageBox, viewMode]
  )

  const scale = useMemo(() => {
    const padding = 48
    if (typeof zoom === 'number') return zoom
    if (zoom === 'actual') return 1
    if (zoom === 'fit-page') {
      const availableWidth = Math.max(200, containerWidth - padding)
      const availableHeight = Math.max(200, containerHeight - padding)
      return Math.max(0.15, Math.min(availableWidth / fitBox.width, availableHeight / fitBox.height))
    }
    const availableWidth = Math.max(200, containerWidth - padding)
    return Math.max(0.15, availableWidth / fitBox.width)
  }, [zoom, containerWidth, containerHeight, fitBox.width, fitBox.height])

  /**
   * 缩放或重渲染会重建文本层，原生选区随之丢失（表现就是"选完一会儿就没了"）。
   * 文本层重建完成后，用已保存的字符偏移把原生选区恢复回来。
   */
  useEffect(() => {
    if (!doc) return
    const stored = storedSelection
    if (!stored || stored.docId !== model.docId) return
    const native = window.getSelection()
    if (native && !native.isCollapsed && native.toString().trim().length > 0) return
    let cancelled = false
    let attempt = 0
    const tryRestore = (): void => {
      if (cancelled || attempt > 4) return
      attempt += 1
      const container = scrollRef.current
      if (!container) return
      const done = restoreNativeSelection(container, stored.charStart, stored.charEnd)
      if (!done) window.setTimeout(tryRestore, 150)
    }
    const timer = window.setTimeout(tryRestore, 120)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [doc, model.docId, scale, rotation, storedSelection, renderTick])

  // ------------------------------------------------------------ 标注读取
  const reloadAnnotations = useCallback(async () => {
    const records = (await api.store.listAnnotations(model.docId)).filter((record) => record.kind !== 'highlight')
    const views: AnnotationView[] = []
    for (const record of records) {
      const anchor = await api.store.getAnchor(record.anchorId)
      if (!anchor) continue
      const primary = JSON.parse(anchor.primaryJson) as { kind: string; page?: number; rects?: Rect[] }
      let page = primary.page
      if (!page) page = pageForChar(model.blocks, anchor.charStart) ?? 1
      views.push({
        id: record.id,
        kind: record.kind,
        color: record.color,
        note: record.note,
        page,
        rects: primary.rects ?? [],
        anchorId: record.anchorId,
        charStart: anchor.charStart,
        charEnd: anchor.charEnd
      })
    }
    setAnnotations(views)
  }, [model])

  useEffect(() => {
    void reloadAnnotations()
  }, [reloadAnnotations])

  // ------------------------------------------------------- 阅读进度保存
  const persistView = useCallback(
    (patch: Partial<{ page: number; zoom: ZoomSetting; rotation: number; viewMode: 'single' | 'continuous' | 'spread'; activeAnnotationId: string | null }>) => {
      const element = scrollRef.current
      const ratio = element && element.scrollHeight > 0 ? element.scrollTop / element.scrollHeight : 0
      updateReaderView(tab.id, {
        page: patch.page ?? currentPage,
        zoom: patch.zoom ?? zoom,
        rotation: (patch.rotation ?? rotation) as 0 | 90 | 180 | 270,
        viewMode: patch.viewMode ?? viewMode,
        activeAnnotationId: patch.activeAnnotationId ?? activeAnnotation,
        scrollTopRatio: ratio,
        scrollTop: element?.scrollTop ?? 0
      })
    },
    [tab.id, currentPage, zoom, rotation, viewMode, activeAnnotation, updateReaderView]
  )

  useEffect(() => {
    setActiveReaderTab(tab.id)
    setReaderProgress({ page: currentPage, total: doc?.numPages ?? 0, zoom: scale, percent: 0 })
  }, [tab.id, currentPage, scale, doc, setActiveReaderTab, setReaderProgress])

  // 滚动 → 当前页
  const onScroll = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    const pages = Array.from(element.querySelectorAll<HTMLElement>('.lr-pdf-page'))
    const middle = element.scrollTop + element.clientHeight / 3
    let best = currentPage
    let bestTop = Number.NEGATIVE_INFINITY
    for (const page of pages) {
      const top = page.offsetTop
      /**
       * 取"还没滚过去的最后一页"，并且**同高时让页码小的赢**：
       * 双页模式下同一对页共享 offsetTop，用 `>=` 会让当前页永远停在右页。
       */
      if (top <= middle && top > bestTop) {
        bestTop = top
        best = Number(page.dataset.page ?? best)
      }
    }
    if (best !== currentPage) setCurrentPage(best)
  }, [currentPage])

  // 恢复阅读位置：优先按锚点/页码，其次按滚动比例（§5.9.2）
  useEffect(() => {
    if (!doc || !scrollElement) return
    const timer = setTimeout(() => {
      const ratio = tab.view.scrollTopRatio ?? 0
      if (ratio > 0.001) {
        scrollElement.scrollTop = ratio * scrollElement.scrollHeight
      } else if (tab.view.page > 1) {
        const target = scrollElement.querySelector<HTMLElement>('.lr-pdf-page[data-page="' + tab.view.page + '"]')
        if (target) scrollElement.scrollTop = target.offsetTop - 12
      }
    }, 140)
    return () => clearTimeout(timer)
    // 仅在切换标签页 / 文档就绪时恢复一次
  }, [tab.id, doc, scrollElement])

  useEffect(() => {
    const timer = setTimeout(() => persistView({}), 600)
    return () => clearTimeout(timer)
  }, [currentPage, zoom, rotation, viewMode, persistView])

  const scrollToPage = useCallback((page: number) => {
    /**
     * 先切页码再滚动（旧实现只在找到目标页元素时才 setCurrentPage）：
     * 单页 / 双页模式只渲染 `pageNumbers` 里的页（见下方 useMemo），
     * 目标页不在其中时根本找不到元素 —— 于是"跳转到第 30 页"在单页模式下**静默失效**。
     */
    setCurrentPage(page)
    const element = scrollRef.current
    if (!element) return
    const target = element.querySelector<HTMLElement>('.lr-pdf-page[data-page="' + page + '"]')
    if (target) {
      element.scrollTo({ top: target.offsetTop - 12, behavior: settings.reader.smoothScroll ? 'smooth' : 'auto' })
    }
  }, [settings.reader.smoothScroll])

  // ------------------------------------------------------------ 查找
  const findHits = useMemo(() => {
    const query = findQuery.trim()
    if (query.length === 0) return [] as { charStart: number; page: number }[]
    const lower = model.text.toLowerCase()
    const needle = query.toLowerCase()
    const out: { charStart: number; page: number }[] = []
    let index = lower.indexOf(needle)
    while (index >= 0 && out.length < 500) {
      out.push({ charStart: index, page: pageForChar(model.blocks, index) ?? 1 })
      index = lower.indexOf(needle, index + Math.max(1, needle.length))
    }
    return out
  }, [findQuery, model])

  const gotoFindHit = useCallback(
    (index: number) => {
      if (findHits.length === 0) return
      const normalized = ((index % findHits.length) + findHits.length) % findHits.length
      setFindIndex(normalized)
      const hit = findHits[normalized]
      scrollToPage(hit.page)
      setFlashRange({ charStart: hit.charStart, charEnd: hit.charStart + findQuery.length })
    },
    [findHits, findQuery.length, scrollToPage]
  )

  // -------------------------------------------------------- 选区 → 锚点
  /**
   * 选区处理（统一入口）。
   * 关键点：
   * 1. 不要求选区落在"当前页"，支持跨页拖选；
   * 2. 端点落在 <br> 或文本层空白处时，回退到相邻的带定位属性的 span；
   * 3. 反向拖选（从下往上）自动把片段按文档顺序排好；
   * 4. 解析逻辑与 Markdown / DOCX / 文本阅读器共用 lib/selection.ts。
   */
  /** 映射就绪前做出的选区：先记下来，等定位属性补齐后再解析，避免"白选一次" */
  const pendingRangeRef = useRef<Range | null>(null)

  /**
   * 解析一个 DOM 选区 → 文档字符区间。
   * 返回 false 表示"文本层还没有可定位的 span"，调用方应当稍后重试。
   */
  const resolveSelectionRange = useCallback(
    (range: Range): boolean => {
      const container = scrollRef.current
      if (!container) return false
      const resolution = resolveDomSelection(range, container, '.lr-pdf-page .textLayer span[data-char-start]')
      if (!resolution) return false
      if (resolution.text.trim().length === 0) {
        setPendingSelection(null)
        setSelection(null)
        return true
      }
      // 片段必须是"用户真正选中的那段文字"，否则退化为浏览器报告的端点区间
      const confirmed = confirmFragments(model.text, resolution)
      const { charStart, charEnd, fragments } = confirmed
      const text = resolution.text
      // 主定位取"起点所在页"；起点不在页面内时按字符偏移反查
      const anchorNode =
        range.startContainer.nodeType === Node.ELEMENT_NODE
          ? (range.startContainer as Element)
          : range.startContainer.parentElement
      const pageElement =
        anchorNode?.closest<HTMLElement>('.lr-pdf-page') ??
        scrollRef.current?.querySelector<HTMLElement>(
          '.lr-pdf-page[data-page="' + String(pageForChar(model.blocks, charStart) ?? currentPage) + '"]'
        ) ??
        null
      const page = Number(pageElement?.dataset.page ?? pageForChar(model.blocks, charStart) ?? currentPage)
      const hostRect = pageElement?.getBoundingClientRect()
      const rects: Rect[] = []
      if (hostRect) {
        for (const clientRect of Array.from(range.getClientRects())) {
          const centerY = clientRect.top + clientRect.height / 2
          if (centerY < hostRect.top || centerY > hostRect.bottom) continue
          if (clientRect.width <= 0 || clientRect.height <= 0) continue
          rects.push({
            x: (clientRect.left - hostRect.left) / hostRect.width,
            y: (clientRect.top - hostRect.top) / hostRect.height,
            width: clientRect.width / hostRect.width,
            height: clientRect.height / hostRect.height
          })
        }
      }
      // 幂等保护：与已存选区一致时不写状态，避免"恢复选区 → selectionchange → 再写状态"的循环
      const existing = useUiStore.getState().selection
      if (existing && existing.docId === model.docId && existing.charStart === charStart && existing.charEnd === charEnd) {
        return true
      }

      setPendingSelection({ charStart, charEnd, text, rects, page, fragments })
      setSelection({
        docId: model.docId,
        tabId: tab.id,
        text,
        charStart,
        charEnd,
        anchorId: null,
        locationLabel: describeLocator({ kind: 'pdf', page, rects }, { locale: i18n.language })
      })
      return true
    },
    [model, currentPage, setSelection, tab.id]
  )

  const handleSelectionMouseUp = useCallback((target: Node | null) => {
    const nativeSelection = window.getSelection()
    const selection = nativeSelection
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      const container0 = scrollRef.current
      // 点在正文区域 = 用户主动取消选区；点在工具条/侧栏则保持已有选区
      if (container0 && target && container0.contains(target)) {
        pendingRangeRef.current = null
        setPendingSelection(null)
        setSelection(null)
      }
      return
    }
    // cloneRange：原生选区随后可能被重渲染清掉，克隆体可用于延迟解析
    const containerA = scrollRef.current
    if (containerA && !containerA.contains(selection.getRangeAt(0).startContainer)) return
    const range = selection.getRangeAt(0).cloneRange()
    const container = scrollRef.current
    const attrSpans = container
      ? container.querySelectorAll('.lr-pdf-page .textLayer span[data-char-start]').length
      : -1
    const resolved = resolveSelectionRange(range)
    if (!resolved) diagSelection('选区解析失败：已定位span数=' + attrSpans)
    pendingRangeRef.current = resolved ? null : range
  }, [resolveSelectionRange])

  /**
   * 选区监听挂在 document 上。
   * 判据必须是"**选区**是否落在本阅读器的文本层里"，而不是"鼠标在哪里松开"：
   * 真实拖选常在正文之外松手（拖到侧栏、面板、窗口边缘），
   * 此时 mouseup 的目标不在滚动容器内，挂在容器上的处理函数根本不会触发 —— 选区就丢了。
   */
  useEffect(() => {
    const onDocumentMouseUp = (event: MouseEvent): void => {
      handleSelectionMouseUp(event.target as Node | null)
    }
    document.addEventListener('mouseup', onDocumentMouseUp)

    // 兜底：在窗口之外松开鼠标时 mouseup 不会到达文档。
    // 监听 selectionchange 并做去抖，保证"任何方式产生的选区"最终都会落到应用状态里。
    let timer: number | null = null
    const onSelectionChange = (): void => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        handleSelectionMouseUp(null)
      }, 150)
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      document.removeEventListener('mouseup', onDocumentMouseUp)
      document.removeEventListener('selectionchange', onSelectionChange)
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [handleSelectionMouseUp])

  // 文本层定位属性补齐后，补解析之前没能处理的选区
  useEffect(() => {
    const range = pendingRangeRef.current
    if (!range) return
    if (!range.startContainer.isConnected) {
      pendingRangeRef.current = null
      return
    }
    if (resolveSelectionRange(range)) pendingRangeRef.current = null
  }, [layoutTick, renderTick, resolveSelectionRange])

  const createAnnotation = useCallback(
    async (kind: 'highlight' | 'underline' | 'strike' | 'note' | 'rect' | 'arrow' | 'ink') => {
      const selection = pendingSelection
      if (!selection) {
        notify(i18n.t('sideBar.annotationsEmpty'), 'info')
        return
      }
      const anchor = createAnchor({
        model,
        charStart: selection.charStart,
        charEnd: selection.charEnd,
        primary: { kind: 'pdf', page: selection.page, rects: selection.rects, fragments: selection.fragments },
        origin: 'annotation'
      })
      await api.store.saveAnchors([
        {
          id: anchor.id,
          docId: anchor.docId,
          docHash: anchor.docHash,
          blockIds: JSON.stringify(anchor.blockIds),
          charStart: anchor.charStart,
          charEnd: anchor.charEnd,
          quote: anchor.quote,
          quoteHash: anchor.quoteHash,
          primaryJson: JSON.stringify(anchor.primary),
          extrasJson: JSON.stringify(anchor.extras),
          status: anchor.status
        }
      ])
      const record: AnnotationRecord = {
        id: 'ann_' + anchor.id.slice(4),
        docId: model.docId,
        kind,
        color: kind === 'highlight' ? HIGHLIGHT_COLORS[colorIndex % HIGHLIGHT_COLORS.length] : '#ffd666',
        anchorId: anchor.id,
        note: null,
        createdAt: Date.now()
      }
      await api.store.upsertAnnotation(record)
      setColorIndex((value) => value + 1)
      await reloadAnnotations()
      setActiveAnnotation(record.id)
      persistView({ activeAnnotationId: record.id })
    },
    [pendingSelection, model, colorIndex, reloadAnnotations, persistView]
  )

  const deleteActiveAnnotation = useCallback(async () => {
    if (!activeAnnotation) return
    await api.store.deleteAnnotation(activeAnnotation)
    setActiveAnnotation(null)
    await reloadAnnotations()
  }, [activeAnnotation, reloadAnnotations])

  const clearAnnotations = useCallback(async () => {
    const answer = await api.dialog.message({
      type: 'question',
      message: i18n.t('reader.annotationClearAll'),
      buttons: [i18n.t('common.confirm'), i18n.t('common.cancel')],
      cancelId: 1
    })
    if (answer !== 0) return
    for (const annotation of annotations) await api.store.deleteAnnotation(annotation.id)
    await reloadAnnotations()
  }, [annotations, reloadAnnotations])

  // ------------------------------------------------------------ 导出
  const exportAnnotated = useCallback(async () => {
    if (annotations.length === 0) {
      notify(i18n.t('reader.export.noAnnotations'), 'info')
      return
    }
    const defaultPath = tab.filePath.replace(/\.pdf$/i, '') + '_annotated.pdf'
    const target = await api.dialog.saveFile({
      title: i18n.t('reader.export.annotatedTitle'),
      defaultPath,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (!target) return
    try {
      // 高亮不再渲染，自然也不导出（其余标注照常导出）
      const payload: ExportAnnotation[] = annotations
        .filter((annotation) => annotation.kind !== 'highlight')
        .map((annotation) => ({
        kind: annotation.kind as ExportAnnotation['kind'],
        color: annotation.color,
        note: annotation.note,
        page: annotation.page,
        rects: annotation.rects
      }))
      const count = await exportAnnotatedPdf(tab.filePath, target, payload)
      notify(i18n.t('reader.export.annotatedDone', { path: target }), 'success', {
        timeoutMs: 0,
        actions: [{ label: i18n.t('cmd.revealFileInOS'), run: () => void api.fs.reveal(target) }]
      })
      void count
    } catch (reason) {
      notify(
        i18n.t('reader.export.failed', { message: reason instanceof Error ? reason.message : String(reason) }),
        'error',
        { timeoutMs: 0 }
      )
    }
  }, [annotations, tab.filePath])

  // ------------------------------------------------- 外部定位请求（图中跳转）
  /**
   * 把"字符区间"变成"看得见的位置"：切页 → 滚动 → 高亮 1.6 秒。
   *
   * 返回 false 表示**还没落地**（目标页不存在、文本层还没建好），由 `useRevealRequest` 重试。
   * 这一点是本次修复的关键：从关系图跳过来时阅读器是刚挂载的，PDF 文档还在异步加载，
   * 页面上连 `.lr-pdf-page` 都没有 —— 旧实现一次性尝试、失败也不报错，
   * 表现出来就是"跳转功能像是没有"。
   *
   * `attempt` 用来做降级：始终拿不到文本层（扫描页、无映射的旧缓存）时，
   * 等几轮后改为闪整页，而不是一直等到超时、什么都不发生。
   */
  const applyReveal = useCallback(
    (
      charStart: number,
      charEnd: number,
      attempt: number,
      options: { hold?: boolean; durationMs?: number } = {}
    ): boolean => {
      /*
       * 先把区间收拾成人能看懂的一段：图里抽出来的锚点常常从半个单词开始
       * （"redu|ced"），高亮出来就是"圈了半个词"，看的人不知道它指哪一段。
       * 只调整**显示范围**，锚点本身不动。
       */
      const snapped = expandRevealRange(model.text, charStart, charEnd)
      charStart = snapped.charStart
      charEnd = snapped.charEnd
      const page = pageForChar(model.blocks, charStart) ?? 1
      // 单页 / 双页模式只渲染当前页：先切页，这一轮必然还找不到元素
      if (viewMode !== 'continuous' && page !== currentPage) {
        setCurrentPage(page)
        return false
      }
      const element = scrollRef.current
      const pageElement = element?.querySelector<HTMLElement>('.lr-pdf-page[data-page="' + page + '"]')
      if (!element || !pageElement) return false
      scrollToPage(page)

      const range = rangeForChars(pageElement, '.textLayer span[data-char-start]', charStart, charEnd)
      if (range) {
        const pageRect = pageElement.getBoundingClientRect()
        const rects: Rect[] = Array.from(range.getClientRects())
          .map((rect) => ({ x: rect.left - pageRect.left, y: rect.top - pageRect.top, width: rect.width, height: rect.height }))
          .filter((rect) => rect.width > 0 && rect.height > 0)
        if (rects.length > 0) {
          if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
          flashTimerRef.current = null
          /*
           * 只登记"哪一页的哪一段"：矩形由 PdfPageView 按当前缩放量。
           * 这一轮量出的 `rects` 只用于下面的"把落点拉到视口中间"，不进 state。
           */
          setFlashTarget({ page, charStart, charEnd, hold: Boolean(options.hold) })
          /*
           * hold = 高亮常驻（关系图跳转）：用户要求"跳转后高亮维持"，
           * 直到下一次跳转或被手动关掉；其余入口仍是 1.6 秒闪一下。
           */
          if (!options.hold) {
            flashTimerRef.current = window.setTimeout(() => {
              flashTimerRef.current = null
              setFlashTarget(null)
            }, options.durationMs ?? 1600)
          }
          /*
           * fit-width 下一页比视口高：只滚到页首还可能看不见目标段，把首处高亮拉到视口中间。
           * 位置用"两个 getBoundingClientRect 之差 + 当前 scrollTop"算，
           * 不依赖 offsetTop（它的基准是 offsetParent，一旦中间多一层定位元素就会整体偏移，
           * 而且不报错 —— 这类"只是偏"的问题在本项目查过整整一轮，见 ARCHITECTURE §4.1）。
           */
          const pageTopInContent = element.scrollTop + (pageElement.getBoundingClientRect().top - element.getBoundingClientRect().top)
          const offset = pageTopInContent + rects[0].y - element.clientHeight / 2
          element.scrollTo({
            top: Math.max(0, offset),
            behavior: settings.reader.smoothScroll ? 'smooth' : 'auto'
          })
          return true
        }
      }

      /*
       * 文本层还没建好：继续等精确矩形。滚动在第一次尝试时就已经发生，
       * 所以"再等"只影响高亮出现的早晚，不会让页面停着不动。
       * 等够 20 轮（约 2 秒）还拿不到映射（扫描页、无偏移表的旧缓存）才降级为闪整页。
       */
      if (attempt < 20) return false
      /* 拿不到文本层偏移表（扫描页、无映射的旧缓存）：收起"区间高亮"，降级为闪整页 */
      setFlashTarget(null)
      pageElement.classList.add('lr-flash')
      window.setTimeout(() => pageElement.classList.remove('lr-flash'), 1600)
      return true
    },
    [model, viewMode, currentPage, scrollToPage, settings.reader.smoothScroll]
  )

  useRevealRequest(model.docId, (request, attempt) =>
    applyReveal(request.charStart, request.charEnd, attempt, {
      hold: request.hold,
      durationMs: request.durationMs
    })
  )

  /**
   * 跳转上下文结束（关掉逻辑链面板 → `revealRequest` 置空）时收起常驻高亮。
   * 与 Markdown / DOCX / 文本阅读器的 `useClearRevealOnReset` 对齐 ——
   * PDF 的高亮是矩形覆盖层，复用不了那个按 class 清理的工具函数。
   */
  const revealRequest = useUiStore((state) => state.revealRequest)
  useEffect(() => {
    if (revealRequest) return
    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current)
      flashTimerRef.current = null
    }
    setFlashTarget(null)
  }, [revealRequest])

  /** 命令层调用（不重试，能定到哪算哪） */
  const revealRange = useCallback(
    (charStart: number, charEnd: number) => {
      void applyReveal(charStart, charEnd, Number.MAX_SAFE_INTEGER)
    },
    [applyReveal]
  )

  /**
   * 缩放锚点：跳转高亮 / 用户选区那一段在缩放（以及旋转）后**仍然居中、开头可见**。
   *
   * PDF 的文本层是异步重建的，所以额外给两道判断：
   *  · `ready`：目标页的文本层已按**新**的 scale/rotation 重建完（PdfPageView 写的 `data-render-scale`）；
   *  · `resolveRect`：用字符区间量出这一段的第一个矩形 —— 与跳转落点是同一把尺子。
   */
  useZoomAnchor({
    containerRef: scrollRef,
    docId: model.docId,
    layoutKey: String(scale) + '|' + String(rotation),
    ready: (anchor) => {
      const page = pageForChar(model.blocks, anchor.charStart) ?? 1
      const layer = scrollRef.current?.querySelector<HTMLElement>(
        '.lr-pdf-page[data-page="' + page + '"] .textLayer'
      )
      return Boolean(
        layer &&
          layer.dataset.renderScale === String(scale) &&
          layer.dataset.renderRotation === String(rotation)
      )
    },
    resolveRect: (anchor) => {
      const element = scrollRef.current
      if (!element) return null
      const page = pageForChar(model.blocks, anchor.charStart) ?? 1
      const pageElement = element.querySelector<HTMLElement>('.lr-pdf-page[data-page="' + page + '"]')
      const range = pageElement
        ? rangeForChars(pageElement, '.textLayer span[data-char-start]', anchor.charStart, anchor.charEnd)
        : null
      return range?.getClientRects()[0] ?? null
    }
  })

  // --------------------------------------------- 向命令层注册阅读器能力
  useEffect(() => {
    return registerReaderController({
      docId: model.docId,
      tabId: tab.id,
      kind: 'pdf',
      zoomIn: () => setZoom((value) => (typeof value === 'number' ? Math.min(4, value + 0.15) : Math.min(4, scale + 0.15))),
      zoomOut: () => setZoom((value) => (typeof value === 'number' ? Math.max(0.2, value - 0.15) : Math.max(0.2, scale - 0.15))),
      zoomFitWidth: () => setZoom('fit-width'),
      zoomFitPage: () => setZoom('fit-page'),
      zoomActual: () => setZoom('actual'),
      setZoom: (value) => setZoom(clampZoom(value)),
      rotate: () => setRotation((value) => (value + 90) % 360),
      setViewMode: (mode) => setViewMode(mode),
      nextPage: () => scrollToPage(Math.min((doc?.numPages ?? 1), currentPage + 1)),
      previousPage: () => scrollToPage(Math.max(1, currentPage - 1)),
      gotoPage: (page) => scrollToPage(Math.max(1, Math.min(doc?.numPages ?? 1, page))),
      find: (query) => {
        setFindQuery(query)
        setFindIndex(0)
      },
      findNext: () => gotoFindHit(findIndex + 1),
      findPrevious: () => gotoFindHit(findIndex - 1),
      openFind: () => {
        const element = document.querySelector<HTMLInputElement>('.lr-findbar input')
        element?.focus()
      },
      // 高亮已停用（产品决定：选中文字不需要再加色块），其余标注类型照旧
      addAnnotation: (kind) => (kind === 'highlight' ? undefined : void createAnnotation(kind)),
      deleteActiveAnnotation: () => void deleteActiveAnnotation(),
      clearAnnotations: () => void clearAnnotations(),
      exportAnnotated: () => void exportAnnotated(),
      revealRange,
      copyCitation: () => {
        const selection = useUiStore.getState().selection
        if (!selection) return ''
        const page = pageForChar(model.blocks, selection.charStart) ?? 1
        const citation = '《' + model.title + '》第 ' + page + ' 页\n"' + selection.text + '"'
        void navigator.clipboard.writeText(citation)
        return citation
      }
    })
  }, [
    model, tab.id, scale, doc, currentPage, findIndex, gotoFindHit, scrollToPage,
    createAnnotation, deleteActiveAnnotation, clearAnnotations, exportAnnotated, revealRange
  ])

  const marksByPage = useMemo(() => {
    const map = new Map<number, PageAnnotationMark[]>()
    for (const annotation of annotations) {
      const list = map.get(annotation.page) ?? []
      list.push({
        id: annotation.id,
        kind: annotation.kind,
        color: annotation.color,
        note: annotation.note,
        rects: annotation.rects,
        active: annotation.id === activeAnnotation
      })
      map.set(annotation.page, list)
    }
    return map
  }, [annotations, activeAnnotation])

  const pageNumbers = useMemo(() => {
    const total = doc?.numPages ?? 0
    if (total === 0) return []
    if (viewMode === 'single') return [currentPage]
    /**
     * 连续与双页都渲染**全篇**。
     * 双页只是"排版成一对一行"，不是"只留当前那一对" —— 旧实现只渲染当前一对，
     * 于是选双页之后就看不到全文了（用户反馈的原话：选择双页后依然要能看到全文）。
     */
    return Array.from({ length: total }, (_, index) => index + 1)
  }, [doc, viewMode, currentPage])

  /**
   * 双页：把全篇按 (1,2)(3,4)… 分行，行内**并排**（左页为奇数页，沿用原来的配对约定）。
   * 行与行之间仍竖向排列，所以全篇依然可以一路滚下去。
   */
  const spreadRows = useMemo(() => {
    const rows: number[][] = []
    for (let index = 0; index < pageNumbers.length; index += 2) rows.push(pageNumbers.slice(index, index + 2))
    return rows
  }, [pageNumbers])

  if (error) {
    return (
      <div className="lr-editor-message">
        <h2>{t('reader.parseFailed')}</h2>
        <p>{error}</p>
        <button className="lr-button" onClick={() => useDocuments.getState().open(tab.filePath, { force: true })}>
          {t('common.retry')}
        </button>
      </div>
    )
  }

  if (!doc) {
    return (
      <div className="lr-editor-message">
        <div className="lr-spinner" />
        <p>{t('reader.loading')}</p>
      </div>
    )
  }

  /**
   * 单页渲染（三种模式共用）。
   * 抽出来是因为双页要把它放进"一行两页"的行容器里；复制一份 JSX 迟早会漏改一处。
   * 放在这里（`if (!doc)` 之后）是让 TS 把 `doc` 收窄成非空。
   */
  const renderPage = (page: number): JSX.Element => (
    <PdfPageView
      key={page}
      doc={doc}
      docId={model.docId}
      pageNumber={page}
      scale={scale}
      rotation={rotation}
      darkMode={settings.pdfDarkMode as PdfDarkMode}
      imagePolicy={settings.pdfImagePolicy}
      brightness={settings.pdfDarkBrightness}
      theme={useSettings.getState().readerTheme}
      annotations={marksByPage.get(page) ?? []}
      searchQuery={findQuery}
      flashRange={
        flashTarget && flashTarget.page === page
          ? { charStart: flashTarget.charStart, charEnd: flashTarget.charEnd }
          : null
      }
      onNavigate={(target) => {
        if (target.page) scrollToPage(target.page)
        else if (target.url) void api.app.openExternal(target.url)
      }}
      onTextLayerReady={notifyTextLayerReady}
      layoutTick={layoutTick}
    />
  )

  return (
    <div className="lr-reader">
      <div className="lr-reader__toolbar">
        <button className="lr-icon-button" title={t('reader.prevPage')} onClick={() => scrollToPage(Math.max(1, currentPage - 1))}>
          ◀
        </button>
        <input
          className="lr-reader__page-input"
          value={currentPage}
          onChange={(event) => {
            const value = Number(event.target.value)
            if (Number.isFinite(value)) scrollToPage(Math.max(1, Math.min(doc.numPages, value)))
          }}
        />
        <span className="lr-reader__toolbar-meta">/ {doc.numPages}</span>
        <button className="lr-icon-button" title={t('reader.nextPage')} onClick={() => scrollToPage(Math.min(doc.numPages, currentPage + 1))}>
          ▶
        </button>
        <div className="lr-reader__toolbar-divider" />
        <button className="lr-icon-button" title={t('reader.zoomOut')} onClick={() => setZoom(Math.max(0.2, scale - 0.15))}>
          −
        </button>
        <ZoomInput scale={scale} onCommit={(value) => setZoom(clampZoom(value))} />
        <button className="lr-icon-button" title={t('reader.zoomIn')} onClick={() => setZoom(Math.min(4, scale + 0.15))}>
          ＋
        </button>
        <button className="lr-icon-button" title={t('reader.zoomFitWidth')} data-active={zoom === 'fit-width'} onClick={() => setZoom('fit-width')}>
          ⇔
        </button>
        <button className="lr-icon-button" title={t('reader.zoomFitPage')} data-active={zoom === 'fit-page'} onClick={() => setZoom('fit-page')}>
          ⤢
        </button>
        <div className="lr-reader__toolbar-divider" />
        <button className="lr-icon-button" title={t('reader.rotate')} onClick={() => setRotation((value) => (value + 90) % 360)}>
          ⟳
        </button>
        <select value={viewMode} onChange={(event) => setViewMode(event.target.value as 'single')} title={t('reader.viewContinuous')}>
          <option value="single">{t('reader.viewSingle')}</option>
          <option value="continuous">{t('reader.viewContinuous')}</option>
          <option value="spread">{t('reader.viewSpread')}</option>
        </select>
        <div className="lr-reader__toolbar-divider" />
        <input
          className="lr-reader__find"
          value={findQuery}
          placeholder={t('reader.findPlaceholder')}
          onChange={(event) => {
            setFindQuery(event.target.value)
            setFindIndex(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') gotoFindHit(event.shiftKey ? findIndex - 1 : findIndex + 1)
          }}
        />
        <span className="lr-reader__toolbar-meta">
          {findQuery ? t('reader.findCount', { index: findHits.length === 0 ? 0 : findIndex + 1, total: findHits.length }) : ''}
        </span>
        <button className="lr-icon-button" title={t('reader.findPrevious')} onClick={() => gotoFindHit(findIndex - 1)}>
          ↑
        </button>
        <button className="lr-icon-button" title={t('reader.findNext')} onClick={() => gotoFindHit(findIndex + 1)}>
          ↓
        </button>
        <div className="lr-reader__toolbar-divider" />
        {/* 高亮按钮已移除（产品决定：不需要高亮） */}
        <button className="lr-icon-button" title={t('reader.annotateUnderline')} onClick={() => void createAnnotation('underline')}>
          U
        </button>
        <button className="lr-icon-button" title={t('reader.annotateStrike')} onClick={() => void createAnnotation('strike')}>
          S
        </button>
        <div className="lr-reader__toolbar-spacer" />
        {/* 诊断入口：不依赖快捷键（有些环境会吞掉 Ctrl 组合键） */}
        <button
          className="lr-icon-button"
          title={t('reader.debugTextLayer')}
          onClick={() => {
            void (async () => {
              const { dumpTextLayerGeometry } = await import('../../../lib/textLayerDebug')
              await dumpTextLayerGeometry()
              notify(t('reader.debugTextLayerDone'), 'success', { timeoutMs: 6000 })
            })()
          }}
        >
          🔬
        </button>
        <button className="lr-icon-button" title={t('reader.export.annotatedTitle')} onClick={() => void exportAnnotated()}>
          ⤓
        </button>
        <span className="lr-reader__toolbar-meta">
          {settings.pdfDarkMode === 'off' ? t('reader.darkMode.off') : settings.pdfDarkMode === 'invert' ? t('reader.darkMode.invert') : t('reader.darkMode.smart')}
        </span>
      </div>

      <div className="lr-pdf-root">
        <PdfRail
          doc={doc}
          model={model}
          currentPage={currentPage}
          activeView={tab.view.sidebarView}
          expandedOutlineIds={tab.view.expandedOutlineIds}
          annotations={annotations}
          activeAnnotationId={activeAnnotation}
          onPickPage={(page) => scrollToPage(page)}
          onPickAnnotation={(id) => {
            const annotation = annotations.find((item) => item.id === id)
            if (!annotation) return
            setActiveAnnotation(id)
            scrollToPage(annotation.page)
            persistView({ activeAnnotationId: id })
          }}
          onDeleteAnnotation={async (id) => {
            await api.store.deleteAnnotation(id)
            await reloadAnnotations()
          }}
          onExport={() => void exportAnnotated()}
          findQuery={findQuery}
        />
        <div className="lr-pdf-root__main">
          <div
            className="lr-pdf-scroll lr-scroll"
            ref={(element) => {
              scrollRef.current = element
              setScrollElement(element)
            }}
            onScroll={onScroll}
                      >
            <div className="lr-pdf-pages" data-mode={viewMode}>
              {viewMode === 'spread'
                ? spreadRows.map((row) => (
                    /*
                     * 双页 = 一行两页**并排**（横向），行与行之间才竖着排。
                     * 不要再把这一层改成 column —— 那是"竖向摆两页"，与双页语义相反。
                     */
                    <div className="lr-pdf-spread" key={'spread-' + row[0]}>
                      {row.map((page) => renderPage(page))}
                    </div>
                  ))
                : pageNumbers.map((page) => renderPage(page))}
            </div>
          </div>
        </div>
      </div>
      {/* 选中文字后的浮动工具条（解释 / 追问 / 翻译 / 加入关系图 / 高亮 / 复制引用） */}
      <SelectionToolbar />
      {flashRange ? (
        <div className="lr-pdf-flash-indicator" aria-hidden>
          {t('reader.findCount', { index: findIndex + 1, total: findHits.length })}
        </div>
      ) : null}
      {documents.status[model.docId] === 'loading' ? <div className="lr-pdf-progress" /> : null}
    </div>
  )
}

/**
 * 依据字符偏移重建原生选区（缩放/重渲染后调用）。
 * 返回是否成功——失败时由调用方重试，等待文本层重建完成。
 */
function restoreNativeSelection(container: HTMLElement, charStart: number, charEnd: number): boolean {
  const range = rangeForChars(container, '.lr-pdf-page .textLayer span[data-char-start]', charStart, charEnd)
  if (!range) return false
  const native = window.getSelection()
  if (!native) return false
  native.removeAllRanges()
  native.addRange(range)
  return true
}

interface AnnotationView {
  id: string
  kind: string
  color: string
  note: string | null
  page: number
  rects: Rect[]
  anchorId: string
  charStart: number
  charEnd: number
}

interface PendingSelection {
  charStart: number
  charEnd: number
  text: string
  rects: Rect[]
  page: number
  /** 选区在文档文本中的精确片段（图表标签/多栏混排时不止一段） */
  fragments?: { start: number; end: number }[]
}

export { pdfjsLib, useNotifications }
