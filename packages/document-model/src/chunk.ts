/** 分块（Chunking）—— 规划书 §5.5.2 步骤 2。 */
import { createId } from '@logicreader/shared'
import { estimateTokens } from './normalize'
import type { Block, DocumentModel } from './types'
import { flattenOutline } from './blocks'

export interface Chunk {
  id: string
  index: number
  charStart: number
  charEnd: number
  blockIds: string[]
  text: string
  /** 该块所处的标题路径，供 Map 阶段注入上下文 */
  headingPath: string[]
  tokens: number
  /** 所属章节 id（目录节点 id），用于按章节生成子图 */
  sectionId: string | null
  pageStart: number | null
  pageEnd: number | null
}

export interface ChunkOptions {
  /** 目标 token 数 */
  targetTokens?: number
  /** 硬上限 token 数 */
  maxTokens?: number
  /** 相邻块重叠比例 0..1 */
  overlap?: number
  /** 按几级标题切分（1 = 一级标题） */
  headingLevel?: number
  /** 按段落聚合切分（全景图档位） */
  byParagraph?: boolean
}

function pageOf(block: Block): number | null {
  if (block.locator.kind === 'pdf') return block.locator.page
  if (block.locator.kind === 'slide') return block.locator.slide
  return null
}

/** 计算每个块所属的标题路径与章节 id。 */
export function annotateSections(blocks: Block[], outline: DocumentModel['outline']): Map<string, { path: string[]; sectionId: string | null }> {
  const flat = flattenOutline(outline)
  const map = new Map<string, { path: string[]; sectionId: string | null }>()
  let current: { path: string[]; sectionId: string | null } = { path: [], sectionId: null }
  let flatIndex = 0
  for (const b of blocks) {
    while (flatIndex < flat.length && flat[flatIndex].blockId === b.id) {
      const node = flat[flatIndex]
      const path: string[] = []
      let level = 0
      for (let i = flatIndex; i >= 0; i -= 1) {
        const n = flat[i]
        if (n.level <= node.level) {
          path.unshift(n.title)
          level = n.level
          if (n.level < node.level) break
        }
      }
      void level
      current = { path: path.length > 0 ? path : [node.title], sectionId: node.id }
      flatIndex += 1
    }
    map.set(b.id, current)
  }
  return map
}

/** 章节根 id：把目录节点向上折叠到指定层级。 */
function sectionRootId(pathNodes: { id: string; level: number }[], headingLevel: number): string | null {
  let best: string | null = null
  for (const node of pathNodes) if (node.level <= headingLevel) best = node.id
  return best
}

/**
 * 分块（规划书 §5.5.2 步骤 2）：
 * 先按标题切分为章节，再在章节内按目标 token 贪心打包，相邻块保留一定重叠。
 * 算法保证下标单调前进，不会出现死循环。
 */
export function chunkDocument(model: DocumentModel, options: ChunkOptions = {}): Chunk[] {
  const target = options.targetTokens ?? 3000
  const max = options.maxTokens ?? Math.round(target * 2)
  const overlap = options.overlap ?? 0.15
  const headingLevel = options.headingLevel ?? 1
  const blocks = model.blocks.filter((block) => block.kind !== 'page-break' && block.text.trim().length > 0)
  if (blocks.length === 0) return []

  const tokenOf = (index: number): number => estimateTokens(blocks[index].text)
  const sectionInfo = annotateSections(blocks, model.outline)
  const flatOutline = flattenOutline(model.outline)
  const outlineById = new Map(flatOutline.map((node) => [node.id, node]))

  // 1) 章节边界
  const boundaries: number[] = []
  blocks.forEach((block, index) => {
    if (block.kind === 'heading' && (block.level ?? 1) <= headingLevel) boundaries.push(index)
  })
  if (boundaries.length === 0 || boundaries[0] !== 0) boundaries.unshift(0)
  const sections: [number, number][] = []
  for (let index = 0; index < boundaries.length; index += 1) {
    const from = boundaries[index]
    const to = (index + 1 < boundaries.length ? boundaries[index + 1] : blocks.length) - 1
    if (to >= from) sections.push([from, to])
  }
  if (sections.length === 0) sections.push([0, blocks.length - 1])

  const chunks: Chunk[] = []
  let chunkIndex = 0

  const pushChunk = (from: number, to: number): void => {
    if (to < from) return
    const slice = blocks.slice(from, to + 1)
    if (slice.length === 0) return
    const text = slice.map((block) => block.text).join('\n')
    const info = sectionInfo.get(slice[0].id)
    const path = info?.path ?? []
    let sectionId = info?.sectionId ?? null
    if (sectionId) {
      const chain: { id: string; level: number }[] = []
      let node = outlineById.get(sectionId)
      while (node) {
        chain.unshift({ id: node.id, level: node.level })
        const parent = flatOutline.find((item) => item.children.some((child) => child.id === node?.id))
        node = parent
      }
      sectionId = sectionRootId(chain, headingLevel) ?? sectionId
    }
    const pages = slice
      .map((block) => (block.locator.kind === 'pdf' ? block.locator.page : block.locator.kind === 'slide' ? block.locator.slide : null))
      .filter((page): page is number => page != null)
    chunks.push({
      id: createId('chunk'),
      index: chunkIndex,
      charStart: slice[0].charStart,
      charEnd: slice[slice.length - 1].charEnd,
      blockIds: slice.map((block) => block.id),
      text,
      headingPath: path,
      tokens: estimateTokens(text),
      sectionId,
      pageStart: pages.length > 0 ? Math.min(...pages) : null,
      pageEnd: pages.length > 0 ? Math.max(...pages) : null
    })
    chunkIndex += 1
  }

  for (const [from, to] of sections) {
    let start = from
    let tokens = 0
    const overlapTokens = Math.floor(target * overlap)

    const flush = (end: number): void => {
      if (end < start) return
      pushChunk(start, end)
      // 计算重叠起点：从末尾回退到约 overlapTokens
      let accumulated = 0
      let back = end
      while (back > start && accumulated < overlapTokens) {
        accumulated += tokenOf(back)
        back -= 1
      }
      const nextStart = Math.min(end + 1, Math.max(start + 1, back + 1))
      start = nextStart
      tokens = 0
      for (let cursor = start; cursor <= end; cursor += 1) tokens += tokenOf(cursor)
    }

    for (let index = from; index <= to; index += 1) {
      const tokensHere = tokenOf(index)
      if (tokens > 0 && tokens + tokensHere > target) flush(index - 1)
      tokens += tokensHere
      if (tokens >= max) flush(index)
    }
    if (tokens > 0 && start <= to) pushChunk(start, to)
  }

  return chunks
}

/** 按目录节点切分章节，供"指定章节生成子图"与增量补抽使用。 */
export function chunksOfSection(chunks: Chunk[], sectionId: string): Chunk[] {
  return chunks.filter((c) => c.sectionId === sectionId)
}