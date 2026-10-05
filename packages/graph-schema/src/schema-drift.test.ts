import { describe, expect, it } from 'vitest'
import { EDGE_KINDS, GRAPH_JSON_SCHEMA, NODE_KINDS, validateGraphDocument } from './index'

/**
 * JSON Schema 与实现之间的**漂移闸门**。
 *
 * 为什么需要它：`GRAPH_JSON_SCHEMA`（对外承诺的结构）与 `validateGraphDocument`（真正执行的校验）
 * 是两处独立维护的真相。加了节点类型忘了改 schema 枚举、把 title 上限从 40 调到 60 只改了一边 ——
 * 这两种漂移都不会让任何测试变红，只会让"导出的 JSON 与文档里写的结构"慢慢对不上。
 *
 * 所以这里把两者**逐条对齐**：schema 声明了哪条约束，实现就必须真的执行它。
 * 判据是可执行的行为（拿违规样本喂进去看拒没拒），不是比对文本。
 */

const nodeItem = GRAPH_JSON_SCHEMA.properties.nodes.items
const nodeProps = nodeItem.properties
const edgeItem = GRAPH_JSON_SCHEMA.properties.edges.items
const edgeProps = edgeItem.properties

function anchor(): Record<string, unknown> {
  return { docId: 'doc_1', docHash: 'hash', charStart: 0, charEnd: 4, quote: '引文' }
}

function baseGraph(): Record<string, unknown> {
  return {
    version: 1,
    docId: 'doc_1',
    docHash: 'hash',
    nodes: [{ id: 'n1', kind: 'claim', title: '标题', anchors: [anchor()] }],
    edges: []
  }
}

function withNode(patch: Record<string, unknown>): Record<string, unknown> {
  const graph = baseGraph()
  const nodes = graph.nodes as Record<string, unknown>[]
  return { ...graph, nodes: [{ ...nodes[0], ...patch }] }
}

function withEdge(edge: Record<string, unknown>): Record<string, unknown> {
  return { ...baseGraph(), edges: [{ id: 'e1', from: 'n1', to: 'n1', kind: 'supports', ...edge }] }
}

describe('受控词表与 schema 枚举一致', () => {
  it('节点类型：vocab 新增一种就必须进 schema', () => {
    expect([...nodeProps.kind.enum].sort()).toEqual([...NODE_KINDS].sort())
  })

  it('边类型：vocab 新增一种就必须进 schema', () => {
    expect([...edgeProps.kind.enum].sort()).toEqual([...EDGE_KINDS].sort())
  })
})

describe('schema 声明的长度上限，实现必须真的执行', () => {
  it('title：40 通过、41 拒绝', () => {
    const limit = nodeProps.title.maxLength
    expect(validateGraphDocument(withNode({ title: '标'.repeat(limit) })).ok).toBe(true)
    expect(validateGraphDocument(withNode({ title: '标'.repeat(limit + 1) })).ok).toBe(false)
  })

  it('summary：上限通过、上限 +1 拒绝', () => {
    const limit = nodeProps.summary.maxLength
    expect(validateGraphDocument(withNode({ summary: '摘'.repeat(limit) })).ok).toBe(true)
    expect(validateGraphDocument(withNode({ summary: '摘'.repeat(limit + 1) })).ok).toBe(false)
  })

  it('label：上限通过、上限 +1 拒绝', () => {
    const limit = edgeProps.label.maxLength
    expect(validateGraphDocument(withEdge({ label: '关'.repeat(limit) })).ok).toBe(true)
    expect(validateGraphDocument(withEdge({ label: '关'.repeat(limit + 1) })).ok).toBe(false)
  })
})

describe('schema 声明的必填与下限，实现必须真的执行', () => {
  it('节点必填字段：删掉任何一个都要被拒', () => {
    for (const field of nodeItem.required) {
      const graph = withNode({})
      const nodes = graph.nodes as Record<string, unknown>[]
      const patched = { ...nodes[0] }
      delete patched[field]
      expect(
        validateGraphDocument({ ...graph, nodes: [patched] }).ok,
        '删掉节点必填字段 ' + field + ' 之后居然通过了'
      ).toBe(false)
    }
  })

  it('边必填字段：删掉任何一个都要被拒', () => {
    // `id` 除外 —— schema 要求它，但实现目前不校验，属于**已记录的缺口**，
    // 由下面的"已知缺口"一节单独钉住。收紧它会让过去能导入的 JSON 变成不能导入。
    for (const field of edgeItem.required.filter((name) => name !== 'id')) {
      const graph = withEdge({})
      const edges = graph.edges as Record<string, unknown>[]
      const patched = { ...edges[0] }
      delete patched[field]
      expect(
        validateGraphDocument({ ...graph, edges: [patched] }).ok,
        '删掉边必填字段 ' + field + ' 之后居然通过了'
      ).toBe(false)
    }
  })

  it('anchors 的 minItems：空数组要被拒（无锚点不入图）', () => {
    expect(nodeProps.anchors.minItems).toBe(1)
    expect(validateGraphDocument(withNode({ anchors: [] })).ok).toBe(false)
  })

  it('顶层必填字段：删掉任何一个都要被拒', () => {
    for (const field of GRAPH_JSON_SCHEMA.required) {
      const graph = baseGraph()
      delete graph[field]
      expect(
        validateGraphDocument(graph).ok,
        '删掉顶层必填字段 ' + field + ' 之后居然通过了'
      ).toBe(false)
    }
  })

  it('version 是常量 1：其它值一律拒绝', () => {
    expect(GRAPH_JSON_SCHEMA.properties.version.const).toBe(1)
    expect(validateGraphDocument({ ...baseGraph(), version: 2 }).ok).toBe(false)
    expect(validateGraphDocument({ ...baseGraph(), version: '1' }).ok).toBe(false)
  })
})

describe('已知缺口（记录下来，别让它悄悄漂）', () => {
  /**
   * schema 把 `id` 列为**边**的必填字段，但 `validateGraphDocument` 只校验 from/to/kind/label，
   * 不校验边的 id（节点 id 是校验的）。这条断言把**当前行为**钉住：
   *
   * 之所以不在这里顺手收紧：收紧会让"过去能导入的 JSON"变成不能导入，属于改变既有功能。
   * 真要收紧，应当是单独一轮，同时改 schema 与实现、并确认旧导出的兼容策略。
   */
  it('边的 id 目前不被校验（与 schema 的 required 不一致）', () => {
    const graph = withEdge({})
    const edges = graph.edges as Record<string, unknown>[]
    const withoutId = { ...edges[0] }
    delete withoutId.id
    expect(edgeItem.required).toContain('id')
    expect(validateGraphDocument({ ...graph, edges: [withoutId] }).ok).toBe(true)
  })
})
