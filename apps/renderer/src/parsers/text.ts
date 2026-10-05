/** 纯文本 / Markdown 源码级解析：生成块序列、全局偏移与目录树。 */
import { createId } from '@logicreader/shared'
import { finalizeDocumentModel, type Block, type BlockKind, type DocumentModel } from '@logicreader/document-model'
import { api } from '../lib/api'
import type { ParseContext } from './types'

const HEADING_ATX = /^(#{1,6})\s+(.*)$/
const HEADING_NUMBERED = /^(\d+(?:\.\d+)*)[.、]?\s+(\S.*)$/
const FENCE = /^\s*(```+|~~~+)(.*)$/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/
const QUOTE = /^\s*>\s?/
const TABLE_ROW = /^\s*\|.*\|\s*$/

interface DraftBlock {
  kind: BlockKind
  text: string
  level?: number
  line: number
}

function classify(line: string): { kind: BlockKind; text: string; level?: number } | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  const atx = HEADING_ATX.exec(trimmed)
  if (atx) return { kind: 'heading', text: atx[2].replace(/\s*#+\s*$/, '').trim(), level: atx[1].length }
  const numbered = HEADING_NUMBERED.exec(trimmed)
  if (numbered && numbered[2].length <= 60 && !trimmed.endsWith('。') && !trimmed.endsWith('.')) {
    return { kind: 'heading', text: trimmed, level: Math.min(6, numbered[1].split('.').length) }
  }
  if (QUOTE.test(trimmed)) return { kind: 'quote', text: trimmed.replace(QUOTE, '').trim() }
  if (LIST_ITEM.test(trimmed)) return { kind: 'list-item', text: trimmed }
  if (TABLE_ROW.test(trimmed)) return { kind: 'table', text: trimmed }
  return { kind: 'paragraph', text: trimmed }
}

export async function parseTextDocument(ctx: ParseContext): Promise<DocumentModel> {
  const raw = await api.fs.readText(ctx.filePath)
  const lines = raw.split('\n')
  const drafts: DraftBlock[] = []
  let fence: string | null = null
  let codeBuffer: string[] = []
  let codeStart = 0

  lines.forEach((line, index) => {
    const fenceMatch = FENCE.exec(line)
    if (fenceMatch) {
      if (fence === null) {
        fence = fenceMatch[1][0]
        codeStart = index + 1
        codeBuffer = []
      } else {
        drafts.push({ kind: 'code', text: codeBuffer.join('\n'), line: codeStart })
        fence = null
        codeBuffer = []
      }
      return
    }
    if (fence !== null) {
      codeBuffer.push(line)
      return
    }
    const classified = classify(line)
    if (!classified) return
    drafts.push({ ...classified, line: index })
  })

  if (fence !== null && codeBuffer.length > 0) {
    drafts.push({ kind: 'code', text: codeBuffer.join('\n'), line: codeStart })
  }

  const blocks: Block[] = drafts.map((draft) =>
    ({
      id: createId('blk'),
      docId: ctx.docId,
      seq: 0,
      kind: draft.kind,
      level: draft.level,
      text: draft.text,
      charStart: 0,
      charEnd: 0,
      locator: { kind: 'text', line: draft.line + 1, column: 0 }
    }) satisfies Block
  )

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
    // 保留源码：关系图抽取按**原文切片**提交给 Agent（Markdown 标记 / 列表符号原样保留），
    // 不再用剥掉标记的拼块文本 —— 只留 lineCount 的话纯文本文档会静默退化成拼块文本。
    meta: { lineCount: lines.length, sourceLength: raw.length, source: raw }
  })
}
