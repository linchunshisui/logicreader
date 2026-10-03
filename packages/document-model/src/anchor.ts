/** 锚点创建与三重重定位 —— 规划书 §5.1。 */
import { createId, type DocumentFormat } from '@logicreader/shared'
import { blockIndexAtChar, blockRangeForChars, locatorKey } from './blocks'
import { normalizeText, quoteHash, similarity } from './normalize'
import type { Anchor, Block, DocumentModel, Locator } from './types'

export interface CreateAnchorInput {
  model: DocumentModel
  charStart: number
  charEnd: number
  /** 渲染层可提供更精确的主定位（如 PDF 的选中矩形） */
  primary?: Locator
  extras?: Locator[]
  origin?: Anchor['origin']
  id?: string
}

export function createAnchor(input: CreateAnchorInput): Anchor {
  const { model } = input
  const max = model.text.length
  const charStart = Math.max(0, Math.min(input.charStart, max))
  const charEnd = Math.max(charStart, Math.min(input.charEnd, max))
  const [from, to] = blockRangeForChars(model.blocks, charStart, charEnd)
  const covered = model.blocks.slice(from, to + 1)
  // 有片段时，引文严格按片段拼接：这才是用户实际选中的连续文字，
  // 也保证"选区文本 == 片段拼接结果"这条断言可以精确成立。
  const fragments = input.primary?.kind === 'pdf' ? input.primary.fragments : undefined
  const quote =
    fragments && fragments.length > 0
      ? fragments.map((fragment) => model.text.slice(fragment.start, fragment.end)).join('')
      : model.text.slice(charStart, charEnd)
  const locators: Locator[] = []
  const push = (l: Locator | undefined): void => {
    if (!l) return
    const key = locatorKey(l)
    if (!locators.some((x) => locatorKey(x) === key)) locators.push(l)
  }
  if (input.primary) push(input.primary)
  for (const b of covered) push(b.locator)
  for (const e of input.extras ?? []) push(e)
  const primary: Locator = locators.shift() ?? { kind: 'text', line: 1, column: 0 }
  return {
    id: input.id ?? createId('anc'),
    docId: model.docId,
    docHash: model.docHash,
    blockIds: covered.map((b) => b.id),
    charStart,
    charEnd,
    quote,
    quoteHash: quoteHash(quote),
    primary,
    extras: locators,
    status: 'ok',
    origin: input.origin ?? 'selection',
    createdAt: Date.now()
  }
}

export type RelocateMethod = 'hash' | 'exact' | 'fuzzy' | 'stale'

export interface RelocateResult {
  anchor: Anchor
  method: RelocateMethod
  confidence: number
}

export interface RelocateOptions {
  /** 模糊匹配阈值，默认 0.85 */
  threshold?: number
  /** 归一化后最大扫描窗口数，避免超大文档卡顿 */
  maxScanWindows?: number
}

/** 在归一化全文里查找所有出现位置。 */
function findAll(haystack: string, needle: string, limit = 64): number[] {
  const out: number[] = []
  if (needle.length === 0) return out
  let idx = haystack.indexOf(needle)
  while (idx >= 0 && out.length < limit) {
    out.push(idx)
    idx = haystack.indexOf(needle, idx + Math.max(1, needle.length))
  }
  return out
}

/**
 * 文档被外部修改后的锚点重定位：
 * 1. docHash 相同 → 直接命中
 * 2. 引文精确查找
 * 3. 模糊匹配（相似度 ≥ 阈值）
 * 4. 全部失败 → stale
 */
export function relocateAnchor(anchor: Anchor, model: DocumentModel, options: RelocateOptions = {}): RelocateResult {
  const threshold = options.threshold ?? 0.85
  if (anchor.docHash === model.docHash) {
    return { anchor: { ...anchor, status: 'ok' }, method: 'hash', confidence: 1 }
  }
  const text = model.text
  const needle = normalizeText(anchor.quote)
  if (needle.length === 0) {
    return { anchor: { ...anchor, status: 'stale' }, method: 'stale', confidence: 0 }
  }

  const exact = findAll(text, needle)
  if (exact.length > 0) {
    const best = pickNearest(exact, anchor.charStart)
    return {
      anchor: rebase(anchor, model, best, best + needle.length),
      method: 'exact',
      confidence: 1
    }
  }

  // 模糊：用逐步缩短的前缀找候选窗口
  const candidates = new Set<number>()
  for (const len of [24, 16, 10, 6]) {
    if (needle.length < len) continue
    const prefix = needle.slice(0, len)
    let idx = text.indexOf(prefix)
    while (idx >= 0 && candidates.size < 128) {
      candidates.add(idx)
      idx = text.indexOf(prefix, idx + 1)
    }
    if (candidates.size > 0) break
  }
  let best = -1
  let bestScore = 0
  const window = needle.length
  for (const start of candidates) {
    const slice = text.slice(start, start + window)
    const score = similarity(needle, slice)
    if (score > bestScore) {
      bestScore = score
      best = start
    }
  }
  if (best < 0 || bestScore < threshold) {
    return { anchor: { ...anchor, status: 'stale' }, method: 'stale', confidence: bestScore }
  }
  // 收缩到实际匹配长度
  let end = best + window
  while (end > best && text[end - 1] !== needle[needle.length - 1]) end -= 1
  return { anchor: rebase(anchor, model, best, end), method: 'fuzzy', confidence: bestScore }
}

function pickNearest(positions: number[], target: number): number {
  let best = positions[0]
  let bestDist = Math.abs(best - target)
  for (const p of positions) {
    const d = Math.abs(p - target)
    if (d < bestDist) {
      best = p
      bestDist = d
    }
  }
  return best
}

function rebase(anchor: Anchor, model: DocumentModel, charStart: number, charEnd: number): Anchor {
  const [from, to] = blockRangeForChars(model.blocks, charStart, charEnd)
  const covered = model.blocks.slice(from, to + 1)
  const locators: Locator[] = []
  const push = (l: Locator | undefined): void => {
    if (!l) return
    const key = locatorKey(l)
    if (!locators.some((x) => locatorKey(x) === key)) locators.push(l)
  }
  // 主定位优先沿用原锚点类型
  if (anchor.primary.kind !== 'text') push(anchor.primary)
  for (const b of covered) push(b.locator)
  for (const e of anchor.extras) push(e)
  const primary = locators.shift()
  return {
    ...anchor,
    docHash: model.docHash,
    blockIds: covered.map((b) => b.id),
    charStart,
    charEnd,
    quote: model.text.slice(charStart, charEnd),
    quoteHash: quoteHash(model.text.slice(charStart, charEnd)),
    ...(primary ? { primary } : {}),
    extras: locators,
    status: 'ok'
  }
}

/** 锚点是否覆盖连续的单一块。 */
export function anchorIsSingleBlock(anchor: Anchor): boolean {
  return anchor.blockIds.length <= 1
}

/** 锚点覆盖的块对象。 */
export function anchorBlocks(anchor: Anchor, blocks: Block[]): Block[] {
  const ids = new Set(anchor.blockIds)
  return blocks.filter((b) => ids.has(b.id))
}

/** 锚点所在块下标（用于 PDF 页码换算）。 */
export function anchorBlockIndex(anchor: Anchor, blocks: Block[]): number {
  return blockIndexAtChar(blocks, anchor.charStart)
}

/** 由块序列反查锚点（同一句话可能在文中出现多次）。 */
export function findAnchorOccurrences(quote: string, model: DocumentModel, limit = 32): Anchor[] {
  const needle = normalizeText(quote)
  const out: Anchor[] = []
  if (needle.length === 0) return out
  let idx = model.text.indexOf(needle)
  while (idx >= 0 && out.length < limit) {
    out.push(createAnchor({ model, charStart: idx, charEnd: idx + needle.length, origin: 'graph' }))
    idx = model.text.indexOf(needle, idx + Math.max(1, needle.length))
  }
  return out
}

/** 文档格式 → 锚点主定位种类（用于 UI 图标与选择器文案）。 */
export function locatorKindForFormat(format: DocumentFormat): Locator['kind'] {
  switch (format) {
    case 'pdf':
    case 'doc':
    case 'slide':
      return 'pdf'
    case 'docx':
      return 'docx'
    case 'sheet':
      return 'sheet'
    default:
      return 'text'
  }
}
