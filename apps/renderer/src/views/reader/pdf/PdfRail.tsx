import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { flattenOutline, type DocumentModel, type OutlineNode } from '@logicreader/document-model'
import { useTabs } from '../../../state/tabs.store'

export interface RailAnnotation {
  id: string
  kind: string
  color: string
  note: string | null
  page: number
}

interface Props {
  doc: PDFDocumentProxy
  model: DocumentModel
  currentPage: number
  activeView: 'thumbnails' | 'outline' | 'annotations' | 'search'
  expandedOutlineIds: string[]
  annotations: RailAnnotation[]
  activeAnnotationId: string | null
  findQuery: string
  onPickPage: (page: number) => void
  onPickAnnotation: (id: string) => void
  onDeleteAnnotation: (id: string) => void
  onExport: () => void
}

export function PdfRail(props: Props): JSX.Element {
  const { t } = useTranslation()
  const tabs = useTabs()
  const tab = tabs.activeTab()
  const [view, setView] = useState(props.activeView)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  useEffect(() => {
    setView(props.activeView)
  }, [props.activeView])

  const switchView = (next: Props['activeView']): void => {
    setView(next)
    if (tab && tab.kind === 'reader') tabs.updateReaderView(tab.id, { sidebarView: next })
  }

  const outlineRows = useMemo(() => flattenOutline(props.model.outline), [props.model.outline])

  const isExpanded = (node: OutlineNode): boolean => expanded[node.id] ?? props.expandedOutlineIds.includes(node.id)

  return (
    <div className="lr-pdf-rail">
      <div className="lr-pdf-rail__tabs">
        <button className="lr-pdf-rail__tab" data-active={view === 'thumbnails'} onClick={() => switchView('thumbnails')}>
          {t('reader.thumbnails')}
        </button>
        <button className="lr-pdf-rail__tab" data-active={view === 'outline'} onClick={() => switchView('outline')}>
          {t('reader.outline')}
        </button>
        <button className="lr-pdf-rail__tab" data-active={view === 'annotations'} onClick={() => switchView('annotations')}>
          {t('reader.annotations')}
        </button>
      </div>
      <div className="lr-pdf-rail__body">
        {view === 'thumbnails' ? (
          <ThumbnailList doc={props.doc} currentPage={props.currentPage} onPick={props.onPickPage} />
        ) : null}

        {view === 'outline' ? (
          outlineRows.length === 0 ? (
            <div className="lr-empty">{t('sideBar.outlineEmpty')}</div>
          ) : (
            outlineRows.map((node) => (
              <button
                key={node.id}
                className="lr-pdf-outline-row"
                style={{ paddingLeft: 6 + (node.level - 1) * 10 }}
                title={node.title}
                onClick={() => {
                  if (node.locator && node.locator.kind === 'pdf') props.onPickPage(node.locator.page)
                }}
              >
                <span className="lr-tree__chevron">{node.children.length > 0 ? (isExpanded(node) ? '▾' : '▸') : ''}</span>
                <span className="lr-tree__label">{node.title}</span>
              </button>
            ))
          )
        ) : null}

        {view === 'annotations' ? (
          <div>
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
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
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
