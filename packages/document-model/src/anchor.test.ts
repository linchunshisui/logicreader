import { describe, expect, it } from 'vitest'
import {
  createAnchor,
  finalizeDocumentModel,
  relocateAnchor,
  normalizeText,
  quoteHash,
  estimateTokens,
  similarity,
  chunkDocument
} from '../src/index'
import type { Block, DocumentModel } from '../src/types'

function buildModel(lines: string[], hash = 'hash-1'): DocumentModel {
  const blocks: Block[] = lines.map((text, index) => ({
    id: 'blk_' + index,
    docId: 'doc_test',
    seq: index,
    kind: text.startsWith('#') ? 'heading' : 'paragraph',
    level: text.startsWith('#') ? 1 : undefined,
    text,
    charStart: 0,
    charEnd: 0,
    locator: { kind: 'text', line: index + 1, column: 0 }
  }))
  return finalizeDocumentModel({
    docId: 'doc_test',
    docHash: hash,
    format: 'markdown',
    title: 'Fixture',
    filePath: '/tmp/fixture.md',
    blocks,
    text: '',
    outline: [],
    pageCount: null,
    meta: {}
  })
}

describe('块序列与偏移表', () => {
  it('把块文本拼接成归一化全文，并回填全局偏移', () => {
    const model = buildModel(['第一段', '第二段', '第三段'])
    expect(model.text).toBe('第一段\n第二段\n第三段')
    expect(model.blocks[0].charStart).toBe(0)
    expect(model.blocks[0].charEnd).toBe(3)
    expect(model.blocks[1].charStart).toBe(4)
    expect(model.text.slice(model.blocks[1].charStart, model.blocks[1].charEnd)).toBe('第二段')
  })

  it('偏移表可切片还原任意块文本', () => {
    const model = buildModel(['alpha', 'beta', 'gamma', 'delta'])
    for (const block of model.blocks) {
      expect(model.text.slice(block.charStart, block.charEnd)).toBe(block.text)
    }
  })
})

describe('锚点创建', () => {
  it('选区锚点覆盖正确的块并保留原文引文', () => {
    const model = buildModel(['第一段内容', '第二段内容'])
    const start = model.text.indexOf('第二段')
    const anchor = createAnchor({ model, charStart: start, charEnd: start + 3 })
    expect(anchor.quote).toBe('第二段')
    expect(anchor.blockIds).toEqual(['blk_1'])
    expect(anchor.status).toBe('ok')
    expect(anchor.quoteHash).toBe(quoteHash('第二段'))
  })
})

describe('锚点三重重定位', () => {
  const original = buildModel(['注意力机制是对序列建模的结构性简化', '循环网络依赖顺序计算'])

  it('docHash 相同 → 直接命中', () => {
    const anchor = createAnchor({ model: original, charStart: 0, charEnd: 12 })
    const result = relocateAnchor(anchor, original)
    expect(result.method).toBe('hash')
    expect(result.confidence).toBe(1)
  })

  it('内容前插入新段落后 → 精确重定位', () => {
    const anchor = createAnchor({ model: original, charStart: 0, charEnd: 12 })
    const modified = buildModel(['新增的引言段落', '注意力机制是对序列建模的结构性简化', '循环网络依赖顺序计算'], 'hash-2')
    const result = relocateAnchor(anchor, modified)
    expect(result.method).toBe('exact')
    expect(modified.text.slice(result.anchor.charStart, result.anchor.charEnd)).toBe('注意力机制是对序列建模的')
  })

  it('原文小幅改写 → 模糊匹配仍可定位', () => {
    const anchor = createAnchor({ model: original, charStart: 0, charEnd: 12 })
    const modified = buildModel(['注意力机制是对序列建模的一次结构性简化', '循环网络依赖顺序计算'], 'hash-3')
    const result = relocateAnchor(anchor, modified)
    expect(['exact', 'fuzzy']).toContain(result.method)
    expect(result.confidence).toBeGreaterThan(0.6)
  })

  it('内容被完全删除 → 标记 stale', () => {
    const anchor = createAnchor({ model: original, charStart: 0, charEnd: 12 })
    const modified = buildModel(['完全无关的另一篇文档内容', '而且这段话里没有任何相同的字'], 'hash-4')
    const result = relocateAnchor(anchor, modified)
    expect(result.method).toBe('stale')
    expect(result.anchor.status).toBe('stale')
  })

  it('批量 20 个用例：重定位成功率 ≥ 95%', () => {
    const sentences = Array.from({ length: 20 }, (_, index) => '这是第 ' + (index + 1) + ' 条用于验证重定位的测试语句，长度足够触发匹配。')
    const base = buildModel(sentences)
    let ok = 0
    for (let index = 0; index < 20; index += 1) {
      const start = base.text.indexOf(sentences[index])
      const anchor = createAnchor({ model: base, charStart: start, charEnd: start + sentences[index].length })
      // 在文档最前面插入一段，整体后移
      const modified = buildModel(['前置说明段落，用于模拟文档被外部修改。', ...sentences], 'hash-' + index)
      const result = relocateAnchor(anchor, modified)
      if (result.method !== 'stale' && result.confidence >= 0.85) ok += 1
    }
    expect(ok / 20).toBeGreaterThanOrEqual(0.95)
  })
})

describe('归一化与相似度', () => {
  it('折叠连续空白并把 CRLF 统一为 LF（保留换行，避免破坏代码块）', () => {
    expect(normalizeText('a\r\n\r\n   b\t\tc')).toBe('a\n\nb c')
    expect(normalizeText('x\r\ny')).toBe('x\ny')
  })

  it('相似度对相近文本给出高分', () => {
    expect(similarity('attention mechanism', 'attention mechanisms')).toBeGreaterThan(0.85)
    expect(similarity('完全不同的内容', 'another sentence')).toBeLessThan(0.5)
  })

  it('token 估算区分中英文', () => {
    expect(estimateTokens('中文十个字')).toBe(5)
    expect(estimateTokens('abcdefgh')).toBe(2)
  })
})

describe('分块', () => {
  it('按标题切分并记录全局偏移', () => {
    const model = buildModel([
      '# 第一章',
      '章节内容一，'.repeat(40),
      '# 第二章',
      '章节内容二，'.repeat(40)
    ])
    const chunks = chunkDocument(model, { targetTokens: 30, headingLevel: 1 })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (const chunk of chunks) {
      expect(model.text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text)
      expect(chunk.tokens).toBeGreaterThan(0)
    }
  })
})
