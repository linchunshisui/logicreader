/**
 * Markdown 解析管线（规划书 §5.2）：
 * remark-parse → mdast → 遍历生成块序列，每块的 position 提供源码行/列。
 */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { visit } from 'unist-util-visit'
import { createId } from '@logicreader/shared'
import { finalizeDocumentModel, type Block, type BlockKind, type DocumentModel } from '@logicreader/document-model'
import { api } from '../lib/api'
import type { ParseContext } from './types'

interface MdNode {
  type: string
  depth?: number
  value?: string
  lang?: string | null
  alt?: string | null
  url?: string
  children?: MdNode[]
  position?: {
    start: { line: number; column: number; offset?: number }
    end: { line: number; column: number; offset?: number }
  }
}

/** 提取节点的纯文本（用于块文本与摘要）。 */
export function nodeText(node: MdNode): string {
  if (typeof node.value === 'string') return node.value
  if (node.type === 'image') return node.alt ?? ''
  if (node.type === 'code') return node.value ?? ''
  if (node.type === 'tableCell' || node.type === 'tableRow') {
    return (node.children ?? []).map(nodeText).join(' | ')
  }
  if (node.children) {
    const parts: string[] = []
    for (const child of node.children) {
      const text = nodeText(child)
      if (text) parts.push(text)
    }
    const joined = parts.join(node.type === 'paragraph' || node.type === 'heading' ? '' : '\n')
    return joined
  }
  return ''
}

const KIND_BY_TYPE: Record<string, BlockKind> = {
  heading: 'heading',
  paragraph: 'paragraph',
  listItem: 'list-item',
  code: 'code',
  blockquote: 'quote',
  table: 'table',
  image: 'image',
  math: 'formula',
  html: 'paragraph',
  thematicBreak: 'page-break'
}

export async function parseMarkdownDocument(ctx: ParseContext): Promise<DocumentModel> {
  const raw = await api.fs.readText(ctx.filePath)
  const processor = unified().use(remarkParse).use(remarkGfm)
  const tree = processor.parse(raw) as unknown as MdNode

  const blocks: Block[] = []
  const seen = new Set<string>()

  const pushBlock = (node: MdNode): void => {
    const kind = KIND_BY_TYPE[node.type]
    if (!kind || kind === 'page-break') return
    const text = nodeText(node)
    if (node.type !== 'image' && text.trim().length === 0) return
    const start = node.position?.start
    if (!start) return
    const key = start.line + ':' + start.column + ':' + node.type
    if (seen.has(key)) return
    seen.add(key)
    blocks.push({
      id: createId('blk'),
      docId: ctx.docId,
      seq: 0,
      kind,
      level: node.depth,
      text: kind === 'code' ? text : text.replace(/\n{2,}/g, '\n').trim(),
      charStart: 0,
      charEnd: 0,
      locator: { kind: 'text', line: start.line, column: start.column },
      meta: {
        mdType: node.type,
        lang: node.lang ?? undefined,
        url: node.url ?? undefined
      }
    })
  }

  visit(tree as never, (node: MdNode) => {
    if (node.type === 'list') return
    if (node.type === 'listItem') {
      // 列表项：把其中的段落折叠进 list-item 块
      const text = nodeText(node)
      const start = node.position?.start
      if (text.trim().length === 0 || !start) return
      const key = start.line + ':' + start.column + ':listItem'
      if (seen.has(key)) return
      seen.add(key)
      blocks.push({
        id: createId('blk'),
        docId: ctx.docId,
        seq: 0,
        kind: 'list-item',
        text: text.replace(/\n+/g, ' ').trim(),
        charStart: 0,
        charEnd: 0,
        locator: { kind: 'text', line: start.line, column: start.column },
        meta: { mdType: 'listItem' }
      })
      return 'skip' as never
    }
    pushBlock(node)
    return undefined as never
  })

  // 按源码位置排序，保证块顺序与文档一致
  blocks.sort((a, b) => {
    const la = a.locator.kind === 'text' ? a.locator.line : 0
    const lb = b.locator.kind === 'text' ? b.locator.line : 0
    if (la !== lb) return la - lb
    const ca = a.locator.kind === 'text' ? a.locator.column : 0
    const cb = b.locator.kind === 'text' ? b.locator.column : 0
    return ca - cb
  })

  return finalizeDocumentModel({
    docId: ctx.docId,
    docHash: ctx.docHash,
    format: ctx.format,
    title: ctx.title,
    filePath: ctx.filePath,
    blocks,
    text: '',
    outline: [],
    pageCount: null,
    // 保留源码：渲染时直接交给 react-markdown，保证渲染位置与块位置一致
    meta: { lineCount: raw.split('\n').length, sourceLength: raw.length, source: raw }
  })
}
