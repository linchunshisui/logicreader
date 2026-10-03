import { useDocuments } from '../../../state/documents.store'
import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist'
import 'pdfjs-dist/web/pdf_viewer.css'
import type { PdfDarkMode, PdfImagePolicy } from '@logicreader/shared'
import { getPdfLayout, pdfjsLib, resolveDestPage } from '../../../lib/pdfjs'
import { persistedPageMapping, TEXT_LAYER_MAPPING_VERSION, type PageMapping } from '../../../lib/textLayerMapping'
import { attachOffsets, mappingMatchesModel, renderOfficialTextLayer } from '../../../lib/pdfTextLayer'
import { applySmartDark, collectImageRegions, cssFilterFor } from './darkMode'
import { rangeForChars } from '../../../lib/selection'

export interface PageAnnotationMark {
  id: string
  kind: string
  color: string
  note: string | null
  rects: { x: number; y: number; width: number; height: number }[]
  active: boolean
}

interface Props {
  doc: PDFDocumentProxy
  docId: string
  pageNumber: number
  scale: number
  rotation: number
  darkMode: PdfDarkMode
  imagePolicy: PdfImagePolicy
  brightness: number
  /** 阅读区主题（用于页面底色与文本层颜色） */
  theme: 'light' | 'dark'
  annotations: PageAnnotationMark[]
  onVisible?: (pageNumber: number) => void
  onNavigate?: (target: { page?: number; url?: string }) => void
  /** 文本层渲染+定位完成（阅读器据此恢复原生选区） */
  onTextLayerReady?: () => void
  /** 布局缓存就绪计数：解析完成后 +1，用于给"提前渲染"的页面补写定位属性 */
  layoutTick?: number
  /**
   * 跳转落点（**字符区间**，不是像素矩形）。
   *
   * 阅读器只告诉"哪一页的哪一段"，矩形由本组件在文本层每次重建完成后按**当前缩放 / 旋转**
   * 重新量出来 —— 缩放后高亮自然跟着页面走。旧实现把跳转那一刻的像素存在阅读器里，
   * 缩放后页面重新排版、矩形却停在原地，就是用户看到的"高亮区域不随缩放变化"。
   * 用矩形而不是"整页闪一下"：fit-width 下一页比视口高，整页高亮说不清落在哪一段。
   * 区间同时写进 `data-reveal-range`，便于断言"落在正确的、完整的词上"（无需读像素）。
   */
  flashRange?: { charStart: number; charEnd: number } | null
  /** 查找命中：在文本层上高亮全部匹配 */
  searchQuery?: string
}

const PIXEL_RATIO = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)

/** 文本层映射诊断（每页一条，避免刷屏） */
const reportedPages = new Set<string>()

export function PdfPageView(props: Props): JSX.Element {
  const { doc, docId, pageNumber, scale, rotation, darkMode, imagePolicy, brightness, theme, searchQuery } = props
  const containerRef = useRef<HTMLDivElement>(null)
  /** 最近一次渲染出的文本层 span：由 lib/pdfTextLayer 调用 pdf.js 官方 TextLayer 渲染，顺序与解析侧"有文字项"一致，供布局就绪后补写字符偏移 */
  const lastSpansRef = useRef<HTMLElement[]>([])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const linkLayerRef = useRef<HTMLDivElement>(null)
  /**
   * 回调统一走 ref：
   * 一旦副作用的依赖里包含整个 props 对象，父组件每次渲染都会让它重跑，
   * 而重跑又回调父组件 setState —— 直接构成 React #185「Maximum update depth exceeded」死循环。
   */
  const propsRef = useRef(props)
  propsRef.current = props
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 })
  const [visible, setVisible] = useState(pageNumber <= 2)
  const [status, setStatus] = useState<'idle' | 'rendering' | 'ready' | 'error'>('idle')
  /** 跳转落点的高亮矩形（页内像素）：按**当前缩放 / 旋转**实时量出，不用跳转那一刻的旧值 */
  const [flashRects, setFlashRects] = useState<{ x: number; y: number; width: number; height: number }[] | null>(null)

  // 懒渲染：进入视口附近才处理
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true)
            propsRef.current.onVisible?.(pageNumber)
          }
        }
      },
      { rootMargin: '600px 0px' }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [pageNumber])

  /**
   * 映射晚于文本层就绪时补写字符偏移。
   *
   * 依赖里必须带 `modelMapping`：**docId + 页号 + tick 三者都不足以表达"映射变了"** ——
   * 当映射"打开时就已持久化"的时候，tick 在页面挂载之前就涨到 1 且不再变化，
   * 后挂载的页面永远收不到信号。直接把映射对象放进依赖，才能覆盖两种到达顺序。
   */
  const modelMapping = useDocuments(
    (state) => (state.models[docId]?.meta as { textLayerMapping?: unknown } | undefined)?.textLayerMapping
  )
  useEffect(() => {
    const spans = lastSpansRef.current
    if (spans.length === 0) return
    if (spans[0]?.dataset.charStart !== undefined) return
    if (!modelMapping && !props.layoutTick) return
    const model = useDocuments.getState().models[docId] ?? null
    const persisted = persistedPageMapping(model, pageNumber)
    if (!persisted || persisted.offsets.length !== spans.length || !model) return
    const strings = spans.map((span) => span.textContent ?? '')
    const check = mappingMatchesModel(strings, persisted, model.text)
    if (check.checked > 0 && check.matched / check.checked < 0.8) return
    const assigned = attachOffsets(spans, persisted)
    logOnce(
      'reattach:' + pageNumber,
      'info',
      '文本层：page=' + pageNumber + ' 迟到的映射已补写 ' + assigned + '/' + spans.length + ' 个 span'
    )
  }, [props.layoutTick, modelMapping, docId, pageNumber])

  /** 页面渲染主流程：canvas → 文本层 → 链接层 */
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let renderTask: { cancel: () => void } | null = null

    const run = async (): Promise<void> => {
      setStatus('rendering')
      try {
        const page: PDFPageProxy = await doc.getPage(pageNumber)
        if (cancelled) return
        const viewport = page.getViewport({ scale, rotation })
        setSize({ width: viewport.width, height: viewport.height })

        const canvas = canvasRef.current
        if (!canvas) return
        const context = canvas.getContext('2d', { willReadFrequently: darkMode === 'smart' })
        if (!context) return
        canvas.width = Math.floor(viewport.width * PIXEL_RATIO)
        canvas.height = Math.floor(viewport.height * PIXEL_RATIO)
        canvas.style.width = viewport.width + 'px'
        canvas.style.height = viewport.height + 'px'
        context.setTransform(PIXEL_RATIO, 0, 0, PIXEL_RATIO, 0, 0)

        const task = page.render({ canvas, canvasContext: context, viewport, intent: 'display' })
        renderTask = task
        await task.promise
        if (cancelled) return
        // ---------------------------------- 文本层：pdf.js 官方 TextLayer（复刻其运行环境）
        const textLayerDiv = textLayerRef.current
        if (textLayerDiv) {
          const cssViewport = page.getViewport({ scale, rotation })
          textLayerDiv.replaceChildren()
          // ①②③ 官方 TextLayer 需要的三件事：类名、CSS 变量、随视口的宽高
          textLayerDiv.classList.add('textLayer')
          textLayerDiv.style.setProperty('--scale-factor', String(scale))
          textLayerDiv.style.setProperty('--total-scale-factor', String(scale))
          textLayerDiv.style.setProperty('--user-unit', '1')
          textLayerDiv.style.width = cssViewport.width + 'px'
          textLayerDiv.style.height = cssViewport.height + 'px'
          const textContent = (await page.getTextContent()) as unknown as { items: unknown[] }
          if (cancelled) return
          const layer = await renderOfficialTextLayer({
            page,
            content: textContent,
            container: textLayerDiv,
            viewport: cssViewport
          })
          /*
           * 标记"这一层是按哪个缩放 / 旋转渲染出来的"：缩放锚点（lib/zoomAnchor）靠它判断
           * 新布局是否就绪 —— 文本层是异步重建的，早一步量到的是**旧几何**，
           * 而那正是"缩放后高亮/落点漂走"的来源。
           */
          textLayerDiv.dataset.renderScale = String(scale)
          textLayerDiv.dataset.renderRotation = String(rotation)
          // 我们只补一件事：字符偏移
          const model = useDocuments.getState().models[docId] ?? null
          const persisted = persistedPageMapping(model, pageNumber)
          let source = 'none'
          let assigned = 0
          if (persisted && persisted.offsets.length === layer.spans.length && model) {
            const check = mappingMatchesModel(layer.strings, persisted, model.text)
            if (check.checked === 0 || check.matched / check.checked >= 0.8) {
              assigned = attachOffsets(layer.spans, persisted)
              source = 'persisted'
            } else {
              source = 'rejected ' + check.matched + '/' + check.checked
            }
          } else if (persisted) {
            source = 'count-mismatch ' + persisted.offsets.length + 'vs' + layer.spans.length
          }
          lastSpansRef.current = layer.spans
          if (!reportedPages.has(docId + ':' + pageNumber)) {
            reportedPages.add(docId + ':' + pageNumber)
            logOnce(
              'layer:' + pageNumber,
              assigned > 0 ? 'info' : 'warn',
              '文本层(官方)：page=' +
                pageNumber +
                ' span=' +
                layer.allDivs.length +
                ' 有文字=' +
                layer.spans.length +
                ' 映射=' +
                source +
                ' 写入=' +
                assigned +
                ' scale=' +
                scale.toFixed(3) +
                ' 视口=' +
                Math.round(cssViewport.width) +
                'x' +
                Math.round(cssViewport.height)
            )
          }
          propsRef.current.onTextLayerReady?.()
        }

        // 链接层
        const linkLayer = linkLayerRef.current
        if (linkLayer) {
          linkLayer.replaceChildren()
          try {
            const annotations = (await page.getAnnotations()) as unknown as {
              subtype?: string
              rect?: number[]
              url?: string
              dest?: string | unknown[] | null
              unsafeUrl?: string
            }[]
            for (const annotation of annotations) {
              if (annotation.subtype !== 'Link' || !annotation.rect) continue
              const [x1, y1, x2, y2] = annotation.rect
              const [vx1, vy1] = viewport.convertToViewportPoint(x1, y2)
              const [vx2, vy2] = viewport.convertToViewportPoint(x2, y1)
              const link = document.createElement('a')
              link.className = 'lr-pdf-link'
              link.style.left = Math.min(vx1, vx2) + 'px'
              link.style.top = Math.min(vy1, vy2) + 'px'
              link.style.width = Math.abs(vx2 - vx1) + 'px'
              link.style.height = Math.abs(vy2 - vy1) + 'px'
              const url = annotation.url ?? annotation.unsafeUrl
              if (url) {
                link.href = '#'
                link.title = url
                link.addEventListener('click', (event) => {
                  event.preventDefault()
                  props.onNavigate?.({ url })
                })
              } else if (annotation.dest) {
                link.href = '#'
                link.title = '跳转'
                link.addEventListener('click', async (event) => {
                  event.preventDefault()
                  const page = await resolveDestPage(doc, annotation.dest ?? null)
                  if (page) props.onNavigate?.({ page })
                })
              }
              linkLayer.appendChild(link)
            }
          } catch {
            /* 链接层失败不影响正文 */
          }
        }

        if (!cancelled) setStatus('ready')
      } catch (error) {
        if (!cancelled && (error as { name?: string })?.name !== 'RenderingCancelledException') {
          setStatus('error')
        }
      }
    }

    void run()
    return () => {
      cancelled = true
      try {
        renderTask?.cancel()
      } catch {
        /* 忽略 */
      }
    }
  }, [visible, doc, docId, pageNumber, scale, rotation, darkMode, imagePolicy, brightness])

  /**
   * 跳转落点高亮：**每次文本层重建完成后按当前缩放/旋转重新量一次**。
   *
   * 只认字符区间（`flashRange`），不认跳转那一刻的像素 —— 缩放 / 旋转都会重建文本层，
   * 量出来的矩形自然跟着页面走（这是"高亮区域不随缩放变化"的根治点）。
   * 渲染中先保留上一份矩形（比"闪掉再回来"稳），文本层或偏移表还没就绪时按 100ms 重试；
   * 始终量不到（扫描页、无偏移表的旧缓存）就交给阅读器降级为"闪整页"。
   */
  const flashStart = props.flashRange?.charStart ?? null
  const flashEnd = props.flashRange?.charEnd ?? null
  useEffect(() => {
    if (flashStart === null || flashEnd === null) {
      setFlashRects(null)
      return
    }
    if (status !== 'ready') return
    let cancelled = false
    let attempt = 0
    const measure = (): void => {
      if (cancelled) return
      const layer = textLayerRef.current
      const page = containerRef.current
      const range = layer ? rangeForChars(layer, 'span[data-char-start]', flashStart, flashEnd) : null
      if (range && page) {
        const pageRect = page.getBoundingClientRect()
        const rects = Array.from(range.getClientRects())
          .map((rect) => ({
            x: rect.left - pageRect.left,
            y: rect.top - pageRect.top,
            width: rect.width,
            height: rect.height
          }))
          .filter((rect) => rect.width > 0 && rect.height > 0)
        if (rects.length > 0) {
          setFlashRects(rects)
          return
        }
      }
      attempt += 1
      if (attempt <= 20) window.setTimeout(measure, 100)
    }
    measure()
    return () => {
      cancelled = true
    }
  }, [flashStart, flashEnd, status, scale, rotation, props.layoutTick])

  // 查找命中高亮（在文本层 span 内做子串高亮）
  useEffect(() => {
    const textLayerDiv = textLayerRef.current
    if (!textLayerDiv) return
    const query = (searchQuery ?? '').trim()
    const spans = Array.from(textLayerDiv.querySelectorAll('span')) as HTMLElement[]
    for (const span of spans) {
      if (span.dataset.wrapped === '1') continue
      const raw = span.textContent ?? ''
      if (!query || raw.length === 0) continue
      const lower = raw.toLowerCase()
      const needle = query.toLowerCase()
      let index = lower.indexOf(needle)
      if (index < 0) continue
      const fragment = document.createDocumentFragment()
      let cursor = 0
      while (index >= 0) {
        if (index > cursor) fragment.appendChild(document.createTextNode(raw.slice(cursor, index)))
        const mark = document.createElement('mark')
        mark.className = 'lr-pdf-search-hit'
        mark.textContent = raw.slice(index, index + query.length)
        fragment.appendChild(mark)
        cursor = index + query.length
        index = lower.indexOf(needle, cursor)
      }
      if (cursor < raw.length) fragment.appendChild(document.createTextNode(raw.slice(cursor)))
      span.replaceChildren(fragment)
      span.dataset.wrapped = '1'
    }
  }, [searchQuery, status])

  const filter = cssFilterFor(darkMode)

  return (
    <div
      className="lr-pdf-page"
      ref={containerRef}
      data-page={pageNumber}
      data-doc-id={docId}
      data-theme={theme}
      style={{ width: size.width || undefined, height: size.height || undefined }}
    >
      <canvas ref={canvasRef} className="lr-pdf-canvas" style={{ filter }} />
      <div className="textLayer" ref={textLayerRef} data-page={pageNumber} />
      <div className="lr-pdf-links" ref={linkLayerRef} />
      {flashRects && flashRects.length > 0 && flashStart !== null ? (
        <div
          className="lr-pdf-flash"
          data-reveal-range={flashStart + '-' + String(flashEnd)}
          aria-hidden
        >
          {flashRects.map((rect, index) => (
            <div
              key={index}
              className="lr-pdf-flash__rect"
              style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
            />
          ))}
        </div>
      ) : null}
      {/**
       * 高亮标注**不渲染**（产品决定：选中文字时不需要额外加一层色块）。
       * 旧数据仍留在库里，只是不再画出来 —— 这样锚点/引用链路不受影响，
       * 以后若要恢复，删掉这段判断即可。
       */}
      <div className="lr-pdf-annotations">
        {props.annotations
          .filter((mark) => mark.kind !== 'highlight')
          .map((mark) =>
            mark.rects.map((rect, index) => (
              <div
                key={mark.id + '-' + index}
                className="lr-pdf-annotation"
                data-kind={mark.kind}
                data-active={mark.active}
                title={mark.note ?? undefined}
                style={{
                  left: rect.x * size.width + 'px',
                  top: rect.y * size.height + 'px',
                  width: rect.width * size.width + 'px',
                  height: rect.height * size.height + 'px',
                  background: 'transparent',
                  borderBottom: mark.kind === 'underline' ? '2px solid ' + mark.color : undefined,
                  textDecoration: mark.kind === 'strike' ? 'line-through ' + mark.color : undefined,
                  borderColor: mark.kind === 'rect' || mark.kind === 'note' ? mark.color : undefined
                }}
              />
            ))
          )}
      </div>
      {status === 'rendering' ? <div className="lr-pdf-page__badge">…</div> : null}
    </div>
  )
}

/**
 * 文本层交给 lib/pdfTextLayer（调用 pdf.js 官方 TextLayer，并复刻它的运行环境），
 * 几何与字符偏移交给 lib/pdfVectorText（矢量内容流）。
 * 本文件只保留日志去重这一件基础设施 —— 排查选区问题时日志是唯一的眼睛。
 */

let warnedKeys = new Set<string>()
/** 同一类告警只报一次（避免滚动/缩放时刷屏），但保留不同类别与不同页 */
function logOnce(key: string, level: 'info' | 'warn', message: string): void {
  if (warnedKeys.has(key)) return
  warnedKeys.add(key)
  if (warnedKeys.size > 200) warnedKeys = new Set<string>()
  const api = (globalThis as { logicreader?: { log: { write: (...args: unknown[]) => Promise<void> } } }).logicreader
  void api?.log.write(level, 'reader', message)
}

export type { PageViewport }
