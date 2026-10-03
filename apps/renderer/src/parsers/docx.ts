/**
 * DOCX 解析管线（规划书 §5.2）：
 * 轻量 OOXML 解析（jszip + fast-xml-parser 读 word/document.xml）得到 w:p 段落序列，
 * 建立 paraIndex ↔ 单元格/段落映射，渲染交给 docx-preview。
 */
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { createId } from '@logicreader/shared'
import { finalizeDocumentModel, type Block, type DocumentModel } from '@logicreader/document-model'
import { api } from '../lib/api'
import type { ParseContext } from './types'

interface OrderedNode {
  [key: string]: unknown
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false
})

function tagName(node: OrderedNode): string | null {
  for (const key of Object.keys(node)) {
    if (key === ':@') continue
    return key
  }
  return null
}

function childrenOf(node: OrderedNode): OrderedNode[] {
  const tag = tagName(node)
  if (!tag) return []
  const value = node[tag]
  return Array.isArray(value) ? (value as OrderedNode[]) : []
}

function attrsOf(node: OrderedNode): Record<string, string> {
  const raw = node[':@'] as Record<string, string> | undefined
  const out: Record<string, string> = {}
  if (!raw) return out
  for (const [key, value] of Object.entries(raw)) out[key.replace('@_', '')] = String(value)
  return out
}

function collectText(nodes: OrderedNode[]): string {
  let out = ''
  for (const node of nodes) {
    const tag = tagName(node)
    if (!tag) continue
    if (tag === '#text') {
      out += String(node['#text'] ?? '')
      continue
    }
    if (tag === 'w:t') {
      out += collectText(childrenOf(node))
      continue
    }
    if (tag === 'w:tab') {
      out += '\t'
      continue
    }
    if (tag === 'w:br') {
      out += '\n'
      continue
    }
    out += collectText(childrenOf(node))
  }
  return out
}

function findChild(nodes: OrderedNode[], tag: string): OrderedNode | null {
  for (const node of nodes) if (tagName(node) === tag) return node
  return null
}

function headingLevel(paragraph: OrderedNode): number | undefined {
  const properties = findChild(childrenOf(paragraph), 'w:pPr')
  if (!properties) return undefined
  const pPrChildren = childrenOf(properties)
  const style = findChild(pPrChildren, 'w:pStyle')
  if (style) {
    const val = attrsOf(style)['w:val'] ?? ''
    const match = /^Heading(\d)$/i.exec(val) ?? /^(\d)$/.exec(val)
    if (match) return Number(match[1])
  }
  const outline = findChild(pPrChildren, 'w:outlineLvl')
  if (outline) {
    const val = Number(attrsOf(outline)['w:val'] ?? '0')
    if (Number.isFinite(val)) return Math.min(6, val + 1)
  }
  return undefined
}

export async function parseDocxDocument(ctx: ParseContext): Promise<DocumentModel> {
  const bytes = await api.fs.readBinary(ctx.filePath)
  const zip = await JSZip.loadAsync(bytes)
  const documentXml = await zip.file('word/document.xml')?.async('string')
  if (!documentXml) throw new Error('不是有效的 .docx 文件（缺少 word/document.xml）')

  const parsed = parser.parse(documentXml) as OrderedNode[]
  const bodyWrapper = parsed.find((node) => tagName(node) === 'w:document')
  const body = bodyWrapper ? findChild(childrenOf(bodyWrapper), 'w:body') : null
  const bodyChildren = body ? childrenOf(body) : []

  const blocks: Block[] = []
  let paraIndex = 0

  const walk = (nodes: OrderedNode[]): void => {
    for (const node of nodes) {
      const tag = tagName(node)
      if (!tag) continue
      if (tag === 'w:p') {
        const text = collectText(childrenOf(node)).replace(/[ \t]+/g, ' ').trim()
        const level = headingLevel(node)
        const hasImage = JSON.stringify(node).includes('w:drawing')
        if (text.length > 0) {
          blocks.push({
            id: createId('blk'),
            docId: ctx.docId,
            seq: 0,
            kind: level ? 'heading' : 'paragraph',
            level,
            text,
            charStart: 0,
            charEnd: 0,
            locator: { kind: 'docx', paraIndex }
          })
        } else if (hasImage) {
          blocks.push({
            id: createId('blk'),
            docId: ctx.docId,
            seq: 0,
            kind: 'image',
            text: '',
            charStart: 0,
            charEnd: 0,
            locator: { kind: 'docx', paraIndex }
          })
        }
        paraIndex += 1
        continue
      }
      if (tag === 'w:tbl') {
        const rows = childrenOf(node).filter((child) => tagName(child) === 'w:tr')
        const text = rows
          .map((row) =>
            childrenOf(row)
              .filter((cell) => tagName(cell) === 'w:tc')
              .map((cell) => collectText(childrenOf(cell)).replace(/\s+/g, ' ').trim())
              .join(' | ')
          )
          .join('\n')
        blocks.push({
          id: createId('blk'),
          docId: ctx.docId,
          seq: 0,
          kind: 'table',
          text,
          charStart: 0,
          charEnd: 0,
          locator: { kind: 'docx', paraIndex },
          meta: { rows: rows.length }
        })
        paraIndex += 1
        continue
      }
      walk(childrenOf(node))
    }
  }

  walk(bodyChildren)

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
    meta: { paragraphCount: paraIndex }
  })
}
