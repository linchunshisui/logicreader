import { ZoomInput, clampZoom } from './ZoomInput'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReaderTab } from '@logicreader/shared'
import { describeLocator, expandRevealRange, type DocumentModel } from '@logicreader/document-model'
import { useUiStore } from '../../state/ui.store'
import { useSettings } from '../../state/settings.store'
import { useDocuments } from '../../state/documents.store'
import { createAnchor } from '@logicreader/document-model'
import { api } from '../../lib/api'
import { useReaderSelection } from '../../lib/readerSelection'
import { useRevealRequest } from '../../lib/revealRequest'
import { markRange, useClearRevealOnReset } from '../../lib/revealMark'
import { anchorElementFor, useZoomAnchor } from '../../lib/zoomAnchor'
import { SelectionToolbar } from './SelectionToolbar'

interface Props {
  tab: ReaderTab
  model: DocumentModel
}

export function TextReaderView({ tab, model }: Props): JSX.Element {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(typeof tab.view.zoom === 'number' ? tab.view.zoom : 1)
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const setSelection = useUiStore((s) => s.setSelection)
  const setReaderProgress = useUiStore((s) => s.setReaderProgress)
  const setActiveReaderTab = useUiStore((s) => s.setActiveReaderTab)
  const { settings } = useSettings()

  useEffect(() => {
    setActiveReaderTab(tab.id)
    setReaderProgress({
      page: 1,
      total: 1,
      zoom,
      percent: 0
    })
  }, [tab.id, zoom, setActiveReaderTab, setReaderProgress])

  const blocks = model.blocks

  const matches = useMemo(() => {
    if (!query.trim()) return [] as number[]
    const needle = query.toLowerCase()
    const hay = model.text.toLowerCase()
    const out: number[] = []
    let index = hay.indexOf(needle)
    while (index >= 0 && out.length < 2000) {
      out.push(index)
      index = hay.indexOf(needle, index + Math.max(1, needle.length))
    }
    return out
  }, [query, model.text])

  /**
   * 选区处理走全阅读器共用的实现（lib/readerSelection）：
   * 每个块都带 data-char-start/end，因此跨段、跨块的选择也能精确解析。
   */
  useReaderSelection({
    containerRef,
    selector: '.lr-prose [data-char-start]',
    model,
    tabId: tab.id,
    label: (charStart) => {
      const block = model.blocks.find((b) => b.charStart <= charStart && b.charEnd >= charStart)
      return describeLocator(block?.locator ?? model.blocks[0]?.locator ?? { kind: 'text', line: 1, column: 0 })
    }
  })

  /**
   * 外部定位请求（图中节点/连线跳转、目录、查找）：滚动到目标块并高亮 1.6 秒。
   *
   * 纯文本阅读器此前**完全没有处理**这个请求 —— 从关系图跳到 .txt/.log 时，
   * 点了跟没点一样（跳转功能缺失的另一种表现）。
   */
  const applyReveal = useCallback(
    (charStart: number, charEnd: number, options: { hold?: boolean; durationMs?: number } = {}): boolean => {
      const root = containerRef.current
      if (!root) return false
      const snapped = expandRevealRange(model.text, charStart, charEnd)
      const block = model.blocks.find((b) => b.charStart <= snapped.charStart && b.charEnd >= snapped.charStart)
      const target =
        root.querySelector<HTMLElement>('[data-char-start="' + snapped.charStart + '"]') ??
        (block ? root.querySelector<HTMLElement>('[data-block-id="' + block.id + '"]') : null)
      if (!target) return false
      target.scrollIntoView({ behavior: settings.reader.smoothScroll ? 'smooth' : 'auto', block: 'center' })
      markRange(root, target, snapped, options)
      return true
    },
    [model, settings.reader.smoothScroll]
  )

  useRevealRequest(model.docId, (request) =>
    applyReveal(request.charStart, request.charEnd, { hold: request.hold, durationMs: request.durationMs })
  )
  useClearRevealOnReset(containerRef)

  /**
   * 缩放锚点：跳转高亮 / 用户选区那一段在缩放后**仍然居中、开头可见**。
   * 纯文本按字号缩放 → 上面的行数变多，目标段会整体下移；不重新对齐就会漂出视口。
   */
  useZoomAnchor({
    containerRef,
    docId: model.docId,
    layoutKey: String(zoom),
    resolveRect: (anchor) => {
      const root = containerRef.current
      const element = root ? anchorElementFor(root, model, anchor.charStart) : null
      return element ? element.getBoundingClientRect() : null
    }
  })

  const persistSelection = useCallback(async () => {
    const selection = useUiStore.getState().selection
    if (!selection || selection.docId !== model.docId) return null
    const anchor = createAnchor({
      model,
      charStart: selection.charStart,
      charEnd: selection.charEnd,
      origin: 'selection'
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
    setSelection({ ...selection, anchorId: anchor.id })
    return anchor
  }, [model, setSelection])

  useEffect(() => {
    void persistSelection
  }, [persistSelection])

  const reload = useDocuments((s) => s.open)

  return (
    <div className="lr-reader">
      <div className="lr-reader__toolbar">
        <button className="lr-icon-button" title={t('reader.zoomOut')} onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))}>
          −
        </button>
        <ZoomInput scale={zoom} min={0.5} max={3} onCommit={(value) => setZoom(clampZoom(value, 0.5, 3))} />
        <button className="lr-icon-button" title={t('reader.zoomIn')} onClick={() => setZoom((z) => Math.min(3, z + 0.1))}>
          ＋
        </button>
        <div className="lr-reader__toolbar-divider" />
        <button
          className="lr-icon-button"
          title={t('reader.find')}
          data-active={findOpen}
          onClick={() => setFindOpen((v) => !v)}
        >
          🔍
        </button>
        <div className="lr-reader__toolbar-spacer" />
        <span className="lr-reader__toolbar-meta">
          {model.format.toUpperCase()} · {model.blocks.length} {t('common.items', { count: model.blocks.length })}
        </span>
        <button
          className="lr-icon-button"
          title={t('common.refresh')}
          onClick={() => void reload(tab.filePath, { force: true })}
        >
          ⟳
        </button>
      </div>

      {findOpen ? (
        <div className="lr-findbar">
          <input
            autoFocus
            value={query}
            placeholder={t('reader.findPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="lr-findbar__count">
            {query ? t('sideBar.searchResults', { count: matches.length }) : ''}
          </span>
          <button className="lr-icon-button" onClick={() => setFindOpen(false)}>
            ✕
          </button>
        </div>
      ) : null}

      <div className="lr-reader__viewport lr-scroll" ref={containerRef} >
        <article className="lr-prose" style={{ fontSize: (settings.reader.smoothScroll ? 15 : 15) * zoom + 'px' }}>
          {blocks.map((block) => (
            <BlockView key={block.id} block={block} query={query} />
          ))}
        </article>
      </div>
      <SelectionToolbar />
    </div>
  )
}

function BlockView({ block, query }: { block: DocumentModel['blocks'][number]; query: string }): JSX.Element {
  const content = query ? highlight(block.text, query) : block.text
  const common = {
    'data-block-id': block.id,
    'data-char-start': block.charStart,
    'data-char-end': block.charEnd
  }
  switch (block.kind) {
    case 'heading':
      return (
        <h3 className="lr-prose__heading" data-level={block.level ?? 1} {...common}>
          {content}
        </h3>
      )
    case 'code':
      return (
        <pre className="lr-prose__code" {...common}>
          {block.text}
        </pre>
      )
    case 'quote':
      return (
        <blockquote className="lr-prose__quote" {...common}>
          {content}
        </blockquote>
      )
    case 'list-item':
      return (
        <div className="lr-prose__list" {...common}>
          {content}
        </div>
      )
    case 'table':
      return (
        <div className="lr-prose__table" {...common}>
          {content}
        </div>
      )
    default:
      return (
        <p className="lr-prose__paragraph" {...common}>
          {content}
        </p>
      )
  }
}

function highlight(text: string, query: string): JSX.Element[] {
  const needle = query.trim()
  if (!needle) return [text as unknown as JSX.Element]
  const out: JSX.Element[] = []
  const lower = text.toLowerCase()
  const target = needle.toLowerCase()
  let cursor = 0
  let index = lower.indexOf(target)
  let key = 0
  while (index >= 0) {
    if (index > cursor) out.push(text.slice(cursor, index) as unknown as JSX.Element)
    out.push(
      <mark key={key++} className="lr-mark">
        {text.slice(index, index + needle.length)}
      </mark>
    )
    cursor = index + needle.length
    index = lower.indexOf(target, cursor)
  }
  if (cursor < text.length) out.push(text.slice(cursor) as unknown as JSX.Element)
  return out
}

function closestBlock(node: Node): HTMLElement | null {
  let current: Node | null = node
  while (current) {
    if (current instanceof HTMLElement && current.dataset.blockId) return current
    current = current.parentNode
  }
  return null
}

function charOffsetWithin(block: HTMLElement, node: Node, offset: number): number {
  let count = 0
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let current = walker.nextNode()
  while (current) {
    if (current === node) return count + offset
    count += (current.textContent ?? '').length
    current = walker.nextNode()
  }
  return (block.textContent ?? '').length
}
