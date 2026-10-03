import { ZoomInput, clampZoom } from '../ZoomInput'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import type { ReaderTab } from '@logicreader/shared'
import { createAnchor, expandRevealRange, pageForChar, type Block, type DocumentModel } from '@logicreader/document-model'
import { api } from '../../../lib/api'
import { useUiStore } from '../../../state/ui.store'
import { useSettings } from '../../../state/settings.store'
import { registerReaderController } from '../../../state/readerBridge'
import { alignElementsToText, useReaderSelection } from '../../../lib/readerSelection'
import { useRevealRequest } from '../../../lib/revealRequest'
import { markRange, useClearRevealOnReset } from '../../../lib/revealMark'
import { anchorElementFor, useZoomAnchor } from '../../../lib/zoomAnchor'
import { SelectionToolbar } from '../SelectionToolbar'
import { CodeBlock } from './CodeBlock'

interface Props {
  tab: ReaderTab
  model: DocumentModel
}

interface HastNode {
  position?: { start?: { line?: number } }
  properties?: Record<string, unknown>
  children?: HastNode[]
  value?: string
}

type MdComponentProps = {
  node?: HastNode
  children?: React.ReactNode
} & Record<string, unknown>

/** 用源码偏移把渲染出来的元素映射回块。 */
function buildBlockIndex(model: DocumentModel): {
  byLine: Map<number, Block>
  ordered: Block[]
} {
  const byLine = new Map<number, Block>()
  for (const block of model.blocks) {
    if (block.locator.kind === 'text') {
      const existing = byLine.get(block.locator.line)
      if (!existing) byLine.set(block.locator.line, block)
    }
  }
  return { byLine, ordered: model.blocks }
}

export function MarkdownReaderView({ tab, model }: Props): JSX.Element {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(typeof tab.view.zoom === 'number' ? tab.view.zoom : 1)
  const [query, setQuery] = useState('')
  const { settings } = useSettings()
  const setSelection = useUiStore((s) => s.setSelection)
  const setActiveReaderTab = useUiStore((s) => s.setActiveReaderTab)
  const setReaderProgress = useUiStore((s) => s.setReaderProgress)

  const { byLine } = useMemo(() => buildBlockIndex(model), [model])
  const source = (model.meta.source as string | undefined) ?? model.blocks.map((block) => block.text).join('\n\n')

  useEffect(() => {
    setActiveReaderTab(tab.id)
    setReaderProgress({ page: 1, total: 1, zoom, percent: 0 })
  }, [tab.id, zoom, setActiveReaderTab, setReaderProgress])

  const blockOf = useCallback(
    (line?: number): Block | undefined => (line == null ? undefined : byLine.get(line)),
    [byLine]
  )

  const attr = useCallback(
    (node: HastNode | undefined) => {
      const block = blockOf(node?.position?.start?.line)
      return {
        'data-block-id': block?.id,
        'data-char-start': block?.charStart,
        'data-char-end': block?.charEnd
      }
    },
    [blockOf]
  )

  /**
   * 选区处理走全阅读器共用的实现（lib/readerSelection）：
   * 监听挂 document、selectionchange 兜底、幂等保护，跨段落/跨元素选择同样可用
   * （旧实现要求"起止落在同一个元素里"，跨段选择直接被清空）。
   */
  useReaderSelection({
    containerRef: scrollRef,
    selector: '.lr-prose [data-char-start]',
    model,
    tabId: tab.id,
    label: (charStart) => {
      const block = model.blocks.find((b) => b.charStart <= charStart && b.charEnd >= charStart)
      const line = block && block.locator.kind === 'text' ? block.locator.line : 1
      return t('common.page') + ' ' + String(line)
    }
  })

  /**
   * 兜底对齐：ReactMarkdown 渲染出的块若拿不到源码行号（表格 / 列表 / 代码块），
   * 按"内容出现的位置"直接对齐到 model.text —— 依据是内容而不是 DOM 结构。
   */
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const elements = Array.from(root.querySelectorAll<HTMLElement>('.lr-prose > *'))
    const result = alignElementsToText(model, elements)
    if (result.failed > 0) {
      void window.logicreader?.log.write(
        'warn',
        'reader',
        'Markdown 选区对齐：成功 ' + result.aligned + ' 个，失败 ' + result.failed + ' 个（失败块内的选区可能不可用）'
      )
    }
  }, [model, source])

  const components = useMemo<Record<string, (props: MdComponentProps) => JSX.Element>>(
    () => ({
      h1: ({ node, children, ...rest }) => <h1 {...attr(node)} {...rest}>{children}</h1>,
      h2: ({ node, children, ...rest }) => <h2 {...attr(node)} {...rest}>{children}</h2>,
      h3: ({ node, children, ...rest }) => <h3 {...attr(node)} {...rest}>{children}</h3>,
      h4: ({ node, children, ...rest }) => <h4 {...attr(node)} {...rest}>{children}</h4>,
      h5: ({ node, children, ...rest }) => <h5 {...attr(node)} {...rest}>{children}</h5>,
      h6: ({ node, children, ...rest }) => <h6 {...attr(node)} {...rest}>{children}</h6>,
      p: ({ node, children, ...rest }) => <p {...attr(node)} {...rest}>{children}</p>,
      li: ({ node, children, ...rest }) => <li {...attr(node)} {...rest}>{children}</li>,
      blockquote: ({ node, children, ...rest }) => <blockquote {...attr(node)} {...rest}>{children}</blockquote>,
      table: ({ node, children, ...rest }) => <table {...attr(node)} {...rest}>{children}</table>,
      pre: ({ node }) => {
        const codeNode = node?.children?.[0] as HastNode | undefined
        const code = (codeNode?.children ?? []).map((child) => child.value ?? '').join('')
        const langClass = (codeNode?.properties?.className ?? []) as string[]
        const lang = langClass.find((value) => value.startsWith('language-'))?.replace('language-', '')
        return (
          <div {...attr(node)}>
            <CodeBlock code={code} lang={lang} />
          </div>
        )
      }
    }),
    [attr]
  )

  /**
   * 外部定位请求（图中跳转 / 目录 / 查找）：滚动到目标块并高亮 1.6 秒。
   *
   * 返回 false = 目标还没出现，交给 `useRevealRequest` 重试。
   * 为什么必须能重试：编辑器区只渲染当前标签页，从关系图跳过来时本视图是**重新挂载**的，
   * 挂载瞬间 DOM 未必已经渲染出目标块 —— 一次性尝试就会静默落空。
   */
  const applyReveal = useCallback(
    (charStart: number, charEnd: number, options: { hold?: boolean; durationMs?: number } = {}): boolean => {
      // 不许圈半个词：边界落在拉丁词内部时补到词边界，并去掉两头空白
      const snapped = expandRevealRange(model.text, charStart, charEnd)
      // 查询限定在本阅读器容器内：分屏时另一个阅读器的元素可能有相同的 char-start
      const root = scrollRef.current
      if (!root) return false
      const element = root.querySelector<HTMLElement>('[data-char-start="' + snapped.charStart + '"]')
      const target = element ?? findBlockElement(snapped.charStart, model, root)
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
  useClearRevealOnReset(scrollRef)

  /**
   * 缩放锚点：跳转高亮 / 用户选区那一段在缩放后**仍然居中、开头可见**。
   * Markdown 按字号缩放 → 上面的内容重排、行高全变；不重新对齐就会漂出视口。
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
      kind: 'markdown',
      zoomIn: () => setZoom((value) => Math.min(3, value + 0.1)),
      zoomOut: () => setZoom((value) => Math.max(0.5, value - 0.1)),
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
        const line = model.blocks.find((b) => b.charStart <= selection.charStart && b.charEnd >= selection.charStart)
        const label = line && line.locator.kind === 'text' ? '第 ' + line.locator.line + ' 行' : ''
        const citation = '《' + model.title + '》' + label + '\n"' + selection.text + '"'
        void navigator.clipboard.writeText(citation)
        return citation
      }
    })
  }, [model, tab.id, applyReveal])

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
        <input
          className="lr-reader__find"
          value={query}
          placeholder={t('reader.findPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="lr-reader__toolbar-spacer" />
        <span className="lr-reader__toolbar-meta">
          Markdown · {model.blocks.length} {t('common.items', { count: model.blocks.length })}
        </span>
      </div>
      <div className="lr-reader__viewport lr-scroll" ref={scrollRef} >
        <article className="lr-prose lr-prose--markdown" style={{ fontSize: 15 * zoom + 'px' }}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeKatex]}
            components={components as never}
          >
            {source}
          </ReactMarkdown>
        </article>
      </div>
      <SelectionToolbar />
    </div>
  )
}

function offsetWithin(root: HTMLElement, node: Node, offset: number): number {
  let count = 0
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let current = walker.nextNode()
  while (current) {
    if (current === node) return count + offset
    count += (current.textContent ?? '').length
    current = walker.nextNode()
  }
  return (root.textContent ?? '').length
}

function findBlockElement(charStart: number, model: DocumentModel, root: ParentNode): HTMLElement | null {
  const block = model.blocks.find((b) => b.charStart <= charStart && b.charEnd >= charStart)
  if (!block) return null
  return root.querySelector<HTMLElement>('[data-block-id="' + block.id + '"]')
}

void pageForChar
void createAnchor
