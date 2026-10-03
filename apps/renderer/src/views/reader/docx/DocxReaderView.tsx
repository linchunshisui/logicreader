import { ZoomInput, clampZoom } from '../ZoomInput'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { renderAsync } from 'docx-preview'
import type { ReaderTab } from '@logicreader/shared'
import { expandRevealRange, type Block, type DocumentModel } from '@logicreader/document-model'
import { api } from '../../../lib/api'
import { useUiStore } from '../../../state/ui.store'
import { useSettings } from '../../../state/settings.store'
import { registerReaderController } from '../../../state/readerBridge'
import { alignElementsToText, useReaderSelection } from '../../../lib/readerSelection'
import { useRevealRequest } from '../../../lib/revealRequest'
import { markRange, useClearRevealOnReset } from '../../../lib/revealMark'
import { anchorElementFor, useZoomAnchor } from '../../../lib/zoomAnchor'
import { SelectionToolbar } from '../SelectionToolbar'

interface Props {
  tab: ReaderTab
  model: DocumentModel
}

export function DocxReaderView({ tab, model }: Props): JSX.Element {
  const { t } = useTranslation()
  const hostRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(typeof tab.view.zoom === 'number' ? tab.view.zoom : 1)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [useLibreOffice, setUseLibreOffice] = useState(false)
  const { settings } = useSettings()
  const setSelection = useUiStore((s) => s.setSelection)
  const setActiveReaderTab = useUiStore((s) => s.setActiveReaderTab)
  const setReaderProgress = useUiStore((s) => s.setReaderProgress)

  useEffect(() => {
    setActiveReaderTab(tab.id)
    setReaderProgress({ page: 1, total: 1, zoom, percent: 0 })
  }, [tab.id, zoom, setActiveReaderTab, setReaderProgress])

  useEffect(() => {
    let cancelled = false
    const host = hostRef.current
    if (!host) return
    host.replaceChildren()
    setStatus('loading')
    void (async () => {
      try {
        const bytes = await api.fs.readBinary(tab.filePath)
        const blob = new Blob([bytes as unknown as BlobPart], {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        })
        await renderAsync(blob, host, host, {
          className: 'lr-docx',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true
        })
        if (cancelled) return
        requestAnimationFrame(() => attachBlockAttributes(host, model))
        setStatus('ready')
      } catch (reason) {
        if (cancelled) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setStatus('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [tab.filePath, model])

  /**
   * 选区处理走全阅读器共用的实现（lib/readerSelection）。
   * Word 文档里段落是 DOM 里最基本的可定位单元，跨段落、跨表格的选择同样能解析。
   */
  useReaderSelection({
    containerRef: scrollRef,
    selector: '.lr-docx-host [data-char-start]',
    model,
    tabId: tab.id,
    label: (charStart) => {
      const locator = model.blocks.find((b) => b.charStart <= charStart && b.charEnd >= charStart)?.locator
      return locator && locator.kind === 'docx' ? t('common.page') + ' ' + (locator.paraIndex + 1) : ''
    }
  })

  /**
   * 外部定位请求（图中跳转 / 目录 / 查找）：滚动到目标段落并高亮 1.6 秒。
   *
   * 返回 false = 段落还没渲染出来，交给 `useRevealRequest` 重试：
   * docx-preview 是异步渲染的（renderAsync + attachBlockAttributes），
   * 从关系图跳过来时本视图刚挂载，一次性的定位必然落空。
   */
  const applyReveal = useCallback(
    (charStart: number, charEnd: number, options: { hold?: boolean; durationMs?: number } = {}): boolean => {
      // 不许圈半个词（Word 里同样会从半个单词开始）
      const snapped = expandRevealRange(model.text, charStart, charEnd)
      const block = model.blocks.find((b) => b.charStart <= snapped.charStart && b.charEnd >= snapped.charStart)
      if (!block) return false
      const element = hostRef.current?.querySelector<HTMLElement>('[data-block-id="' + block.id + '"]')
      if (!element) return false
      element.scrollIntoView({ behavior: settings.reader.smoothScroll ? 'smooth' : 'auto', block: 'center' })
      markRange(hostRef.current, element, snapped, options)
      return true
    },
    [model, settings.reader.smoothScroll]
  )

  useRevealRequest(model.docId, (request) =>
    applyReveal(request.charStart, request.charEnd, { hold: request.hold, durationMs: request.durationMs })
  )
  useClearRevealOnReset(hostRef)

  /**
   * 缩放锚点：跳转高亮 / 用户选区那一段在缩放后**仍然居中、开头可见**。
   * Word 用 CSS `zoom` 缩放，段落在视口里的位置会整体平移；不重新对齐就会漂出视口。
   */
  useZoomAnchor({
    containerRef: scrollRef,
    docId: model.docId,
    layoutKey: String(zoom),
    resolveRect: (anchor) => {
      const root = scrollRef.current
      const element = root ? anchorElementFor(root, model, anchor.charStart) : null
      return element ? element.getBoundingClientRect() : null
    }
  })

  useEffect(() => {
    return registerReaderController({
      docId: model.docId,
      tabId: tab.id,
      kind: 'docx',
      zoomIn: () => setZoom((v) => Math.min(3, v + 0.1)),
      zoomOut: () => setZoom((v) => Math.max(0.5, v - 0.1)),
      zoomFitWidth: () => setZoom(1),
      zoomFitPage: () => setZoom(1),
      zoomActual: () => setZoom(1),
      setZoom: (value) => setZoom(clampZoom(value, 0.5, 3)),
      rotate: () => undefined,
      setViewMode: () => undefined,
      nextPage: () => scrollRef.current?.scrollBy({ top: scrollRef.current.clientHeight * 0.9, behavior: 'smooth' }),
      previousPage: () => scrollRef.current?.scrollBy({ top: -scrollRef.current.clientHeight * 0.9, behavior: 'smooth' }),
      gotoPage: () => undefined,
      find: (value) => setQuery(value),
      findNext: () => undefined,
      findPrevious: () => undefined,
      openFind: () => document.querySelector<HTMLInputElement>('.lr-reader__find')?.focus(),
      addAnnotation: () => undefined,
      deleteActiveAnnotation: () => undefined,
      clearAnnotations: () => undefined,
      exportAnnotated: () => undefined,
      revealRange: (charStart, charEnd) => void applyReveal(charStart, charEnd),
      copyCitation: () => {
        const selection = useUiStore.getState().selection
        if (!selection) return ''
        const block = model.blocks.find((b) => b.charStart <= selection.charStart && b.charEnd >= selection.charStart)
        const label = block && block.locator.kind === 'docx' ? '第 ' + (block.locator.paraIndex + 1) + ' 段' : ''
        const citation = '《' + model.title + '》' + label + '\n"' + selection.text + '"'
        void navigator.clipboard.writeText(citation)
        return citation
      }
    })
  }, [model, tab.id, applyReveal])

  const highlightCount = useMemo(() => {
    if (!query.trim()) return 0
    return model.text.split(query).length - 1
  }, [query, model.text])

  return (
    <div className="lr-reader">
      <div className="lr-reader__toolbar">
        <button className="lr-icon-button" title={t('reader.zoomOut')} onClick={() => setZoom((v) => Math.max(0.5, v - 0.1))}>
          −
        </button>
        <ZoomInput scale={zoom} min={0.5} max={3} onCommit={(value) => setZoom(clampZoom(value, 0.5, 3))} />
        <button className="lr-icon-button" title={t('reader.zoomIn')} onClick={() => setZoom((v) => Math.min(3, v + 0.1))}>
          ＋
        </button>
        <div className="lr-reader__toolbar-divider" />
        <input className="lr-reader__find" value={query} placeholder={t('reader.findPlaceholder')} onChange={(event) => setQuery(event.target.value)} />
        <span className="lr-reader__toolbar-meta">{query ? t('sideBar.searchResults', { count: highlightCount }) : ''}</span>
        <div className="lr-reader__toolbar-spacer" />
        <label className="lr-reader__toolbar-meta" title={t('settings.reader.pdfDarkSmart')}>
          <input type="checkbox" checked={useLibreOffice} onChange={(event) => setUseLibreOffice(event.target.checked)} /> LibreOffice
        </label>
        <span className="lr-reader__toolbar-meta">
          Word · {model.blocks.length} {t('common.items', { count: model.blocks.length })}
        </span>
      </div>
      <div className="lr-reader__viewport lr-scroll" ref={scrollRef} >
        {status === 'error' ? (
          <div className="lr-editor-message">
            <h2>{t('reader.parseFailed')}</h2>
            <p>{t('reader.parseFailedDetail', { message: error ?? '' })}</p>
          </div>
        ) : null}
        {status === 'loading' ? (
          <div className="lr-editor-message">
            <div className="lr-spinner" />
            <p>{t('reader.loading')}</p>
          </div>
        ) : null}
        <div className="lr-docx-host" ref={hostRef} style={{ zoom: String(zoom) }} />
      </div>
      <SelectionToolbar />
    </div>
  )
}

/**
 * 把解析阶段的块偏移注入 docx-preview 生成的 DOM。
 *
 * 两道保险：
 *  1) **按内容对齐**（alignElementsToText）：依据"这段文字在 model.text 里的位置"，
 *     不看 DOM 结构，因此 docx-preview 把段落拆成几段、把表格另起一节都不影响；
 *  2) 内容对齐失败的元素，再按"顺序 + 前缀"匹配到模型块，保证段落里仍能选中原文。
 * 一句总结：先给每个段落拿到一个**正确的**字符区间，再谈精度。
 */
function attachBlockAttributes(host: HTMLElement, model: DocumentModel): void {
  const paragraphs = Array.from(host.querySelectorAll<HTMLElement>('p, table')) as HTMLElement[]
  const align = alignElementsToText(model, paragraphs)
  const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim()
  let pointer = 0
  let fallback = 0
  for (const element of paragraphs) {
    if (!element.dataset.charStart) {
      fallback += 1
      const text = normalize(element.textContent ?? '')
      if (text.length === 0) continue
      let matchIndex = -1
      for (let i = pointer; i < Math.min(model.blocks.length, pointer + 6); i += 1) {
        if (normalize(model.blocks[i].text).startsWith(text.slice(0, 40))) {
          matchIndex = i
          break
        }
      }
      if (matchIndex < 0) {
        for (let i = Math.max(0, pointer - 4); i < model.blocks.length; i += 1) {
          if (normalize(model.blocks[i].text).startsWith(text.slice(0, 40))) {
            matchIndex = i
            break
          }
        }
      }
      if (matchIndex < 0) continue
      const block = model.blocks[matchIndex]
      element.dataset.charStart = String(block.charStart)
      element.dataset.charEnd = String(block.charEnd)
      pointer = matchIndex + 1
    }
    // 块 id 只用于"定位到这一段"，不参与选区换算
    const start = Number(element.dataset.charStart)
    const block = model.blocks.find((b) => b.charStart === start)
    if (block) element.dataset.blockId = block.id
  }
  if (align.failed > 0 || fallback > 0) {
    void window.logicreader?.log.write(
      'warn',
      'reader',
      'Word 选区对齐：内容对齐 ' + align.aligned + ' 个 / 内容失败 ' + align.failed + ' 个 / 顺位兜底 ' + fallback + ' 个'
    )
  }
  void ({} as Block)
}
