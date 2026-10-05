import { describe, expect, it } from 'vitest'
import { buildChunkSourceMap, finalizeDocumentModel, mapChunkSpan } from '../src/index'
import type { Block, DocumentModel } from '../src/types'

/**
 * 造一篇"解析后"的模型：块文本是**剥掉标记**的（与真实解析器一致），
 * 整份源码留在 meta.source —— 这正是关系图抽取要面对的形状。
 */
const SOURCE = [
  '# 标题一', //        行 1
  '段落甲', //          行 2
  '', //                行 3
  '## 小节', //         行 4
  '| a | b |', //       行 5
  '| --- | --- |', //   行 6
  '| 1 | 2 |', //       行 7
  '', //                行 8
  '- 列表项' //         行 9
].join('\n')

function blockOf(id: string, text: string, line: number, kind: Block['kind'], level?: number): Block {
  return {
    id,
    docId: 'doc_test',
    seq: 0,
    kind,
    level,
    text,
    charStart: 0,
    charEnd: 0,
    locator: { kind: 'text', line, column: 0 }
  }
}

const STRIPPED_BLOCKS = [
  blockOf('blk_0', '标题一', 1, 'heading', 1),
  blockOf('blk_1', '段落甲', 2, 'paragraph'),
  blockOf('blk_2', '小节', 4, 'heading', 2),
  blockOf('blk_3', 'a | b\n1 | 2', 5, 'table'),
  blockOf('blk_4', '列表项', 9, 'list-item')
]

function buildModel(blocks: Block[], source: string | null): DocumentModel {
  return finalizeDocumentModel({
    docId: 'doc_test',
    docHash: 'hash-1',
    format: 'markdown',
    title: 'Fixture',
    filePath: '/tmp/fixture.md',
    blocks,
    text: '',
    outline: [],
    pageCount: null,
    meta: source == null ? {} : { source }
  })
}

function chunkTextOf(blocks: Block[]): string {
  return blocks.map((block) => block.text).join('\n')
}

describe('源文件切片', () => {
  it('提交的是原文切片：标题标记与表格竖线原样保留', () => {
    const model = buildModel(STRIPPED_BLOCKS, SOURCE)
    const chunkBlocks = model.blocks.slice(2, 4)
    const map = buildChunkSourceMap({
      source: SOURCE,
      blocks: model.blocks,
      chunkBlocks,
      chunkText: chunkTextOf(chunkBlocks)
    })
    expect(map).not.toBeNull()
    expect(map?.text).toContain('## 小节')
    expect(map?.text).toContain('| --- | --- |')
    // 剥掉标记的拼块文本仍然不含标记 —— 两者的差别正是这一轮要修的东西
    expect(chunkTextOf(chunkBlocks)).not.toContain('##')
  })

  it('映射非递减，且落在本分块块的坐标范围内', () => {
    const model = buildModel(STRIPPED_BLOCKS, SOURCE)
    const chunkBlocks = model.blocks.slice(2, 4)
    const map = buildChunkSourceMap({
      source: SOURCE,
      blocks: model.blocks,
      chunkBlocks,
      chunkText: chunkTextOf(chunkBlocks)
    })!
    for (let index = 1; index < map.offsets.length; index += 1) {
      expect(map.offsets[index]).toBeGreaterThanOrEqual(map.offsets[index - 1])
    }
    expect(map.offsets.length).toBe(map.text.length)
    const low = chunkBlocks[0].charStart
    const high = chunkBlocks[chunkBlocks.length - 1].charEnd
    for (const offset of map.offsets) {
      expect(offset).toBeGreaterThanOrEqual(low)
      expect(offset).toBeLessThanOrEqual(high)
    }
  })

  it('指向标题文字的片段内区间，能换算回标题块本身', () => {
    const model = buildModel(STRIPPED_BLOCKS, SOURCE)
    const chunkBlocks = model.blocks.slice(2, 4)
    const map = buildChunkSourceMap({
      source: SOURCE,
      blocks: model.blocks,
      chunkBlocks,
      chunkText: chunkTextOf(chunkBlocks)
    })!
    const heading = chunkBlocks[0]
    const start = map.text.indexOf('## 小节')
    const span = mapChunkSpan(map, start, start + '## 小节'.length)
    expect(span).not.toBeNull()
    // 落回标题块（createAnchor 之后会自然扩到块边界）
    expect(span!.charStart).toBeGreaterThanOrEqual(heading.charStart)
    expect(span!.charEnd).toBeLessThanOrEqual(heading.charEnd)
  })

  it('末块切片一直取到文件末尾', () => {
    const model = buildModel(STRIPPED_BLOCKS, SOURCE)
    const chunkBlocks = model.blocks.slice(4)
    const map = buildChunkSourceMap({
      source: SOURCE,
      blocks: model.blocks,
      chunkBlocks,
      chunkText: chunkTextOf(chunkBlocks)
    })!
    expect(map.text.endsWith('- 列表项')).toBe(true)
  })

  it('中间块的切片终点由全文块序列决定，不会被分块内部截断', () => {
    const model = buildModel(STRIPPED_BLOCKS, SOURCE)
    // 只取标题块：它的源码区间要到下一块（第 4 行）为止
    const chunkBlocks = model.blocks.slice(2, 3)
    const map = buildChunkSourceMap({
      source: SOURCE,
      blocks: model.blocks,
      chunkBlocks,
      chunkText: chunkTextOf(chunkBlocks)
    })!
    expect(map.text).toBe('## 小节\n')
  })
})

describe('无源文件时的退化', () => {
  it('没有 meta.source → 提交文本就是拼块文本，映射按块归属', () => {
    const blocks = [
      blockOf('blk_0', '第一段', 1, 'paragraph'),
      blockOf('blk_1', '第二段', 2, 'paragraph')
    ]
    const model = buildModel(blocks, null)
    const chunkBlocks = model.blocks
    const chunkText = chunkTextOf(chunkBlocks)
    const map = buildChunkSourceMap({ source: null, blocks: model.blocks, chunkBlocks, chunkText })!
    expect(map.text).toBe(chunkText)
    expect(map.offsets.length).toBe(chunkText.length)
    // 首块首字符 → 首块起始；分隔符 → 上一块末字符之后
    expect(map.offsets[0]).toBe(chunkBlocks[0].charStart)
    const separatorIndex = chunkBlocks[0].text.length
    expect(map.offsets[separatorIndex]).toBe(chunkBlocks[1].charStart - 1)
    expect(map.offsets[separatorIndex + 1]).toBe(chunkBlocks[1].charStart)
  })

  it('块不是文本定位（PDF / 表格）时也退化为按块映射，而不是返回 null', () => {
    const pdfBlock: Block = {
      id: 'blk_pdf',
      docId: 'doc_test',
      seq: 0,
      kind: 'paragraph',
      text: 'PDF 段落',
      charStart: 0,
      charEnd: 0,
      locator: { kind: 'pdf', page: 1, rects: [] }
    }
    const model = buildModel([pdfBlock], '不该被用到的源码')
    const chunkBlocks = model.blocks
    const chunkText = chunkTextOf(chunkBlocks)
    const map = buildChunkSourceMap({ source: '不该被用到的源码', blocks: model.blocks, chunkBlocks, chunkText })
    expect(map).not.toBeNull()
    expect(map!.text).toBe('PDF 段落')
  })

  it('空分块返回 null，调用方退回旧路径', () => {
    const model = buildModel(STRIPPED_BLOCKS, SOURCE)
    expect(buildChunkSourceMap({ source: SOURCE, blocks: model.blocks, chunkBlocks: [], chunkText: '' })).toBeNull()
  })
})
