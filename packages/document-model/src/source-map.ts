/**
 * 源文件切片与偏移映射 —— 把"分块在源文件里的原文"提交给 Agent，同时保住锚点。
 *
 * 背景：`chunkDocument` 拼出来的 `Chunk.text` 是 `blocks.map(b => b.text).join('\n')`，
 * 而 `block.text` 在解析阶段已被剥掉 Markdown 标记（`## `、表格竖线、列表符号）。
 * 送进抽取提示词的就是这种**无结构流水文本**，模型分不清"这是标题还是正文"。
 *
 * 这里做的是：有文本源文件时（Markdown / 纯文本解析器会留 `meta.source`），
 * 取该分块覆盖的**原文行区间**作为提交文本，并给出
 * "提交文本下标 → 全文 `model.text` 偏移"的映射，供模型返回的 spans 换算回锚点坐标。
 *
 * 两条硬约束：
 * 1. `Block.charStart/charEnd` 是 `model.text`（拼块文本）里的坐标，**不是源文件坐标** ——
 *    源文件坐标只能由 `locator.line` 推出来。
 * 2. 映射必须**非递减**，否则 `charEnd > charStart` 的合法性会被破坏、锚点被整条丢弃。
 */
import type { Block } from './types'

export interface ChunkSourceMap {
  /** 实际提交给模型的片段文本 */
  text: string
  /** `text` 下标 → 全文 `model.text` 偏移；长度恒等于 `text.length`，且非递减 */
  offsets: number[]
  /** true = 这段文本是**源文件原文切片**（保留了标题/表格/列表标记）；false = 拼块文本 */
  fromSource: boolean
}

/** 每行的起始偏移（0-based 行号 → 偏移）。 */
function lineStartsOf(source: string): number[] {
  const starts = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1)
  }
  return starts
}

/** 文本格式的块才带源文件行号；PDF / DOCX / 表格没有。 */
function sourceLineOf(block: Block): number | null {
  return block.locator.kind === 'text' ? block.locator.line : null
}

function offsetOfLine(lineStarts: number[], sourceLength: number, line: number): number {
  const index = Math.max(0, Math.min(line - 1, lineStarts.length - 1))
  return lineStarts[index] ?? sourceLength
}

/**
 * 无源文件时的映射：片段文本就是拼块文本，逐块给出字符归属。
 *
 * 不能图省事写成"`chunkStart + i` 恒等"：`chunkDocument` 会滤掉空白块与分页块，
 * 被滤掉的块在 `model.text` 里仍占字符，恒等映射会随文档往后**越错越多**。
 */
function offsetsFromBlocks(chunkBlocks: Block[], text: string): number[] | null {
  const offsets: number[] = []
  chunkBlocks.forEach((block, index) => {
    // 块间分隔符 '\n' 在 model.text 里的位置就是上一块的 charEnd
    if (index > 0) offsets.push(Math.max(0, block.charStart - 1))
    for (let i = 0; i < block.text.length; i += 1) offsets.push(block.charStart + i)
  })
  return offsets.length === text.length ? offsets : null
}

/**
 * 构建一个分块的"提交文本 + 偏移映射"。
 *
 * @param source      `model.meta.source`（没有则传 null）
 * @param blocks      全文块序列 —— 用来找"本分块末块之后的下一个块"，据此确定末块的源码区间终点
 * @param chunkBlocks 本分块覆盖的块
 * @param chunkText   `Chunk.text`（拼块文本），无源文件时就是提交文本
 * @returns 建不出可靠映射时返回 null，调用方退回旧路径（模型给全局坐标）
 */
export function buildChunkSourceMap(options: {
  source: string | null
  blocks: Block[]
  chunkBlocks: Block[]
  chunkText: string
}): ChunkSourceMap | null {
  const { source, blocks, chunkBlocks, chunkText } = options
  if (chunkBlocks.length === 0) return null

  const hasSource = typeof source === 'string' && source.length > 0
  const allTextLocators = chunkBlocks.every((block) => sourceLineOf(block) != null)
  if (!hasSource || !allTextLocators) {
    const offsets = offsetsFromBlocks(chunkBlocks, chunkText)
    return offsets ? { text: chunkText, offsets, fromSource: false } : null
  }

  const lineStarts = lineStartsOf(source as string)
  const firstLine = sourceLineOf(chunkBlocks[0]) as number
  const startOffset = offsetOfLine(lineStarts, source.length, firstLine)

  /**
   * 末块的源码终点 = 全文里紧随其后那一个**文本块**的行首。
   * 用全文的块序列而不是分块内部：末块可能是个多行段落，只看分块内部会把它截断。
   */
  const lastChunkBlock = chunkBlocks[chunkBlocks.length - 1]
  const lastIndex = blocks.findIndex((block) => block.id === lastChunkBlock.id)
  let endOffset = source.length
  for (let index = lastIndex + 1; index >= 0 && index < blocks.length; index += 1) {
    const line = sourceLineOf(blocks[index])
    if (line != null) {
      endOffset = offsetOfLine(lineStarts, source.length, line)
      break
    }
  }
  if (endOffset <= startOffset) return null

  const text = source.slice(startOffset, endOffset)

  // 逐块把源码区间摊到 model.text 坐标上（块内线性、到界即止，不越出该块的 charStart..charEnd）
  const bounds = chunkBlocks.map((block, index) => {
    const line = sourceLineOf(block) as number
    const rawStart = offsetOfLine(lineStarts, source.length, line)
    let rawEnd = endOffset
    if (index + 1 < chunkBlocks.length) {
      const nextLine = sourceLineOf(chunkBlocks[index + 1]) as number
      rawEnd = offsetOfLine(lineStarts, source.length, nextLine)
    }
    return { block, rawStart, rawEnd: Math.max(rawStart, rawEnd) }
  })

  const offsets: number[] = []
  let cursor = 0
  for (let index = 0; index < text.length; index += 1) {
    const position = startOffset + index
    while (cursor < bounds.length - 1 && position >= bounds[cursor].rawEnd) cursor += 1
    const bound = bounds[cursor]
    const within = position - bound.rawStart
    const last = Math.max(0, bound.block.text.length - 1)
    offsets.push(bound.block.charStart + Math.min(Math.max(0, within), last))
  }
  // 兜底单调化：块顺序 / 行号万一有重复或倒序，也不能让映射回头
  for (let index = 1; index < offsets.length; index += 1) {
    if (offsets[index] < offsets[index - 1]) offsets[index] = offsets[index - 1]
  }
  if (offsets.length !== text.length) return null
  return { text, offsets, fromSource: true }
}

/**
 * 片段内偏移 → 全文偏移。**越界返回 null，不做夹取**：
 * 调用方（`parseExtraction`）靠"null = 这不是片段内偏移"来回落到"全局偏移"的旧契约 ——
 * 夹取会把一个越界的**全局**坐标静默当成片段内坐标，锚点就指到别处去了。
 */
export function mapChunkOffset(map: ChunkSourceMap, local: number): number | null {
  if (!Number.isInteger(local)) return null
  if (local < 0 || local >= map.offsets.length) return null
  return map.offsets[local] ?? null
}

/** 片段内区间 → 全文区间；映射不出比空区间更大的范围时返回 null。 */
export function mapChunkSpan(
  map: ChunkSourceMap,
  start: number,
  end: number
): { charStart: number; charEnd: number } | null {
  const from = mapChunkOffset(map, start)
  const to = mapChunkOffset(map, end - 1)
  if (from == null || to == null) return null
  const charStart = Math.min(from, to)
  const charEnd = Math.max(from, to) + 1
  return charEnd > charStart ? { charStart, charEnd } : null
}
