import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { StoreService } from '../apps/main/src/services/store.service'
import type { BlockRecord, DocumentRecord } from '../packages/shared/src/ipc'

/**
 * 跨文档全文检索（store.searchBlocks）的行为测试。
 *
 * 为什么这组测试不可省：检索的三条路径（FTS5 / LIKE / 内存扫描）里，
 * FTS5 那一堆 SQL 细节（MATCH 的别名、bm25 排序、trigram 的最短词长、UNINDEXED 列）
 * 都**只在真正跑起来时**才会暴露问题，而它们坏了通常表现为"搜不到"而不是报错。
 * 这里用真实的 node:sqlite 起一个真库来跑，不做 mock。
 */

const dir = resolve(__dirname, '../.tmp/store-search-test')
mkdirSync(dir, { recursive: true })

let counter = 0
function freshStore(): { store: StoreService; file: string } {
  counter += 1
  const file = resolve(dir, 's' + counter + '.db')
  const store = new StoreService()
  store.open(file)
  return { store, file }
}

function doc(id: string, title: string): DocumentRecord {
  return {
    id,
    path: 'D:/docs/' + id + '.pdf',
    format: 'pdf',
    title,
    docHash: 'hash-' + id,
    sizeBytes: 1024,
    pageCount: 3,
    textLength: 0,
    outlineJson: null,
    openedAt: 1_700_000_000_000,
    lastPage: 1,
    metaJson: null
  }
}

function block(docId: string, seq: number, text: string, charStart: number): BlockRecord {
  return {
    id: docId + '-b' + seq,
    docId,
    seq,
    kind: 'paragraph',
    level: null,
    text,
    charStart,
    charEnd: charStart + text.length,
    locatorJson: '{"kind":"pdf","page":1,"rects":[]}',
    parentId: null
  }
}

/** 两篇文档，中文 + 英文各一段，另有供"短词""通配符"用例的文本。 */
function seed(store: StoreService): void {
  store.upsertDocument(doc('d1', '注意力机制综述'))
  store.upsertDocument(doc('d2', '逻辑阅读器设计稿'))
  store.saveBlocks('d1', [
    block('d1', 0, '注意力机制本质上是对序列依赖建模的结构性简化。', 0),
    block('d1', 1, 'Transformer 用自注意力替换了循环结构。', 40),
    block('d1', 2, '百分之百的实验都用了 dropout。', 80)
  ])
  store.saveBlocks('d2', [
    block('d2', 0, '逻辑阅读器把 PDF 变成可深读的对象。', 0),
    block('d2', 1, '关系图的每个节点都要能指回原文。', 30)
  ])
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('跨文档检索', () => {
  it('中文子串能命中（trigram 分词：不是按整串汉字当一个词）', () => {
    const { store } = freshStore()
    seed(store)
    const hits = store.searchBlocks('注意力')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.docId === 'd1')).toBe(true)
    store.close()
  })

  it('命中带 docId 与字符区间，可直接跳回原文', () => {
    const { store } = freshStore()
    seed(store)
    const hit = store.searchBlocks('循环结构')[0]
    expect(hit).toBeDefined()
    expect(hit!.docId).toBe('d1')
    expect(hit!.docTitle).toBe('注意力机制综述')
    expect(hit!.charEnd).toBeGreaterThan(hit!.charStart)
    expect(hit!.matchStart).toBeGreaterThanOrEqual(0)
    store.close()
  })

  it('跨文档：一次查询能同时命中不同文档', () => {
    const { store } = freshStore()
    seed(store)
    const hits = store.searchBlocks('的')
    const docs = new Set(hits.map((h) => h.docId))
    expect(docs.size).toBe(2)
    store.close()
  })

  it('英文也能命中', () => {
    const { store } = freshStore()
    seed(store)
    expect(store.searchBlocks('Transformer').length).toBeGreaterThan(0)
    store.close()
  })

  it('两个字的短词也搜得到（trigram 索引建不出匹配项，走 LIKE 兜底）', () => {
    const { store } = freshStore()
    seed(store)
    // "自注意"是 3 字走 FTS；"注意"是 2 字，必须由兜底路径接住
    expect(store.searchBlocks('注意').length).toBeGreaterThan(0)
    store.close()
  })

  it('把 % 当普通字符，不当通配符', () => {
    const { store } = freshStore()
    seed(store)
    // 正文里只有"百分之"，没有"百%"
    // 两个字的查询走 LIKE 兜底路径 —— 这条专门验 LIKE 里的 ESCAPE 转义
    expect(store.searchBlocks('百%')).toHaveLength(0)
    // 三个字的走 FTS 路径
    expect(store.searchBlocks('百分之').length).toBe(1)
    store.close()
  })

  it('FTS5 的语法字符不会被当成查询语法（左括号 / 减号 / 星号）', () => {
    const { store } = freshStore()
    seed(store)
    // 这些若是裸着进 MATCH 会抛错；短语化之后只是"搜不到"，不该炸
    expect(() => store.searchBlocks('(未闭合')).not.toThrow()
    expect(() => store.searchBlocks('a - b')).not.toThrow()
    expect(() => store.searchBlocks('***')).not.toThrow()
    store.close()
  })

  it('空查询返回空，不返回全库', () => {
    const { store } = freshStore()
    seed(store)
    expect(store.searchBlocks('')).toEqual([])
    expect(store.searchBlocks('   ')).toEqual([])
    store.close()
  })

  it('limit 生效', () => {
    const { store } = freshStore()
    seed(store)
    expect(store.searchBlocks('的', 1)).toHaveLength(1)
    store.close()
  })
})

describe('索引与正文同源', () => {
  it('重写同一篇文档后，旧文本不再被命中', () => {
    const { store } = freshStore()
    store.upsertDocument(doc('d1', '待重写'))
    store.saveBlocks('d1', [block('d1', 0, '第一版内容：量子纠缠。', 0)])
    expect(store.searchBlocks('量子纠缠').length).toBe(1)

    store.saveBlocks('d1', [block('d1', 0, '第二版内容：光合作用。', 0)])
    expect(store.searchBlocks('量子纠缠')).toHaveLength(0)
    expect(store.searchBlocks('光合作用').length).toBe(1)
    store.close()
  })

  it('删除文档后索引里的分块一起消失', () => {
    const { store } = freshStore()
    store.upsertDocument(doc('d1', '要删掉的'))
    store.saveBlocks('d1', [block('d1', 0, '这段文字随文档一起消失。', 0)])
    expect(store.searchBlocks('随文档一起消失').length).toBe(1)

    store.removeDocument('d1')
    expect(store.searchBlocks('随文档一起消失')).toHaveLength(0)
    store.close()
  })
})

describe('老库升级：索引自证式回填', () => {
  it('索引被清空（模拟老库刚建索引）后重新打开，会整批重建而不是"搜什么都搜不到"', () => {
    const { store, file } = freshStore()
    seed(store)
    store.close()

    // 直接对库动手：把索引清空，正文留着 —— 正是老库升级后的状态
    const raw = new DatabaseSync(file)
    raw.exec('DELETE FROM blocks_fts')
    const indexed = raw.prepare('SELECT count(*) AS n FROM blocks_fts').get() as { n: number }
    const total = raw.prepare('SELECT count(*) AS n FROM blocks').get() as { n: number }
    raw.close()
    expect(indexed.n).toBe(0)
    expect(total.n).toBeGreaterThan(0)

    const reopened = new StoreService()
    reopened.open(file)
    expect(reopened.searchBlocks('注意力').length).toBeGreaterThan(0)
    reopened.close()
  })
})
