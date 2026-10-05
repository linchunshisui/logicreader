import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { DocumentModel } from '@logicreader/document-model'
import { IconClose } from '../../../workbench/icons'

export interface RailAnnotation {
  id: string
  kind: string
  color: string
  note: string | null
  page: number
}

/** 阅读器侧栏里的两块面板：各自独立、可同时打开 */
export type RailPanel = 'thumbnails' | 'annotations'

interface Props {
  doc: PDFDocumentProxy
  model: DocumentModel
  currentPage: number
  /**
   * 两块面板的显隐。**各自独立、允许同时为 true**（用户要求："支持同时存在"）；
   * 都为 false 时这一整条侧栏不渲染（工具栏上那两个按钮是唯一的唤起入口）。
   */
  panels: { thumbnails: boolean; annotations: boolean }
  annotations: RailAnnotation[]
  activeAnnotationId: string | null
  findQuery: string
  onPickPage: (page: number) => void
  onPickAnnotation: (id: string) => void
  onDeleteAnnotation: (id: string) => void
  onExport: () => void
  /** 关掉某一块（面板头上的 × 与工具栏按钮共用这一个状态） */
  onToggle: (panel: RailPanel, open: boolean) => void
}

/**
 * PDF 阅读器自带的侧栏：**缩略图**与**页内标注**两块，各自独立、可同时打开。
 *
 * 以前是"二选一的页签"（还要加上已并入全局「大纲」的目录，共三选一），
 * 用户的实际需求是"想看哪块看哪块、两块一起看也行，不想看就整条收起来" ——
 * 所以页签条去掉，改成两块可叠加的面板 + 工具栏上的唤起按钮。
 * 目录（PDF 内嵌书签）仍然只在全局活动栏的「大纲」里有一份，不在这里重复。
 */
export function PdfRail(props: Props): JSX.Element | null {
  const { t } = useTranslation()
  if (!props.panels.thumbnails && !props.panels.annotations) return null
  return (
    <div className="lr-pdf-rail">
      {props.panels.thumbnails ? (
        <section className="lr-pdf-rail__section" data-panel="thumbnails">
          <header className="lr-pdf-rail__section-head">
            <span>{t('reader.thumbnails')}</span>
            <button
              className="lr-icon-button"
              title={t('reader.railHide')}
              onClick={() => props.onToggle('thumbnails', false)}
            >
              <IconClose />
            </button>
          </header>
          <div className="lr-pdf-rail__section-body">
            <ThumbnailList doc={props.doc} currentPage={props.currentPage} onPick={props.onPickPage} />
          </div>
        </section>
      ) : null}

      {props.panels.annotations ? (
        <section className="lr-pdf-rail__section" data-panel="annotations">
          <header className="lr-pdf-rail__section-head">
            <span>{t('reader.annotations')}</span>
            <button
              className="lr-icon-button"
              title={t('reader.railHide')}
              onClick={() => props.onToggle('annotations', false)}
            >
              <IconClose />
            </button>
          </header>
          <div className="lr-pdf-rail__section-body">
            <div className="lr-pdf-sidebar-toolbar" style={{ padding: '4px 0', borderBottom: 'none' }}>
              <button className="lr-button lr-button--secondary" onClick={props.onExport}>
                {t('reader.export.annotatedTitle')}
              </button>
            </div>
            {props.annotations.length === 0 ? (
              <div className="lr-empty">{t('sideBar.annotationsEmpty')}</div>
            ) : (
              props.annotations.map((annotation) => (
                <div key={annotation.id} className="lr-annotation-row" data-active={annotation.id === props.activeAnnotationId}>
                  <button
                    className="lr-annotation-row__body"
                    onClick={() => props.onPickAnnotation(annotation.id)}
                    style={{ border: 'none', background: 'transparent', textAlign: 'left' }}
                  >
                    <span className="lr-annotation-row__kind">
                      <span className="lr-annotation-row__color" style={{ background: annotation.color, display: 'inline-block', width: 8, height: 8, borderRadius: 2, marginRight: 6 }} />
                      {t('common.page')} {annotation.page} · {annotation.kind}
                    </span>
                    <span className="lr-annotation-row__note">{annotation.note ?? ''}</span>
                  </button>
                  <button className="lr-icon-button" title={t('reader.annotationDelete')} onClick={() => props.onDeleteAnnotation(annotation.id)}>
                    <IconClose />
                  </button>
                </div>
              ))
            )}
          </div>
        </section>
      ) : null}
    </div>
  )
}

function ThumbnailList({ doc, currentPage, onPick }: { doc: PDFDocumentProxy; currentPage: number; onPick: (page: number) => void }): JSX.Element {
  const [pages, setPages] = useState<number[]>([])
  useEffect(() => {
    setPages(Array.from({ length: doc.numPages }, (_, index) => index + 1))
  }, [doc])
  return (
    <div>
      {pages.map((page) => (
        <Thumbnail key={page} doc={doc} page={page} active={page === currentPage} onPick={onPick} />
      ))}
    </div>
  )
}

function Thumbnail({ doc, page, active, onPick }: { doc: PDFDocumentProxy; page: number; active: boolean; onPick: (page: number) => void }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLButtonElement>(null)
  const [visible, setVisible] = useState(page <= 12)

  useEffect(() => {
    const element = hostRef.current
    if (!element) return
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) setVisible(true)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    void (async () => {
      try {
        const pdfPage = await doc.getPage(page)
        const base = pdfPage.getViewport({ scale: 1 })
        const scale = 150 / base.width
        const viewport = pdfPage.getViewport({ scale })
        const canvas = canvasRef.current
        if (!canvas || cancelled) return
        const context = canvas.getContext('2d')
        if (!context) return
        canvas.width = viewport.width
        canvas.height = viewport.height
        await pdfPage.render({ canvas, canvasContext: context, viewport }).promise
      } catch {
        /* 缩略图失败不影响主视图 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [visible, doc, page])

  return (
    <button ref={hostRef} className="lr-pdf-thumb" data-active={active} onClick={() => onPick(page)} title={String(page)}>
      <canvas ref={canvasRef} />
      <span className="lr-pdf-thumb__label">{page}</span>
    </button>
  )
}
