import { describe, expect, it } from 'vitest'
import { parseExtraction, validateGraphDocument, normalizeEdgeKind, normalizeNodeKind } from '../src/index'

describe('边类型归一化', () => {
  it('把自由文本映射到受控词表', () => {
    expect(normalizeEdgeKind('causes')).toBe('causes')
    expect(normalizeEdgeKind(' Causal ')).toBe('causes')
    expect(normalizeEdgeKind('支持')).toBe('supports')
    expect(normalizeEdgeKind('unknown-kind')).toBeNull()
  })

  it('节点类型归一化带默认值', () => {
    expect(normalizeNodeKind('论点')).toBe('claim')
    expect(normalizeNodeKind('statistic')).toBe('data')
    expect(normalizeNodeKind('nonsense')).toBe('claim')
  })
})

describe('抽取结果校验（无锚点不入图）', () => {
  const ctx = { charStart: 100, charEnd: 500 }

  it('解析合法 JSON 并保留锚点', () => {
    const raw = JSON.stringify({
      entities: [
        { name: '注意力', type: 'claim', summary: '摘要', evidence: '原文', spans: [{ charStart: 120, charEnd: 130 }] }
      ],
      relations: []
    })
    const result = parseExtraction(raw, ctx)
    expect(result.ok).toBe(true)
    expect(result.value?.entities).toHaveLength(1)
  })

  it('丢弃越界锚点（块内相对解释也不成立时）', () => {
    // 注意：{0,10} 这类小偏移现在会按「块内相对偏移」换算保留（弱模型兜底），
    // 这里用两种解释都不成立的坐标验证丢弃路径
    const raw = JSON.stringify({
      entities: [{ name: '越界', type: 'claim', summary: '', evidence: '', spans: [{ charStart: 600, charEnd: 700 }] }],
      relations: []
    })
    const result = parseExtraction(raw, ctx)
    expect(result.value?.entities).toHaveLength(0)
    expect(result.value?.dropped).toBe(1)
  })

  it('丢弃没有锚点的条目', () => {
    const raw = JSON.stringify({ entities: [{ name: 'A', type: 'claim', summary: '', evidence: '', spans: [] }], relations: [] })
    expect(parseExtraction(raw, ctx).value?.entities).toHaveLength(0)
  })

  it('关系必须指向已知实体', () => {
    const raw = JSON.stringify({
      entities: [{ name: 'A', type: 'claim', summary: '', evidence: '', spans: [{ charStart: 120, charEnd: 130 }] }],
      relations: [{ from: 'A', to: 'B', type: 'supports', label: '', evidence: '', spans: [{ charStart: 120, charEnd: 130 }] }]
    })
    const result = parseExtraction(raw, ctx)
    expect(result.value?.relations).toHaveLength(0)
  })

  it('从代码围栏中抠出 JSON', () => {
    const raw = '\u0060\u0060\u0060json\n{"entities":[],"relations":[]}\n\u0060\u0060\u0060'
    const result = parseExtraction(raw, ctx)
    expect(result.ok).toBe(true)
  })
})

describe('图文档 Schema 校验', () => {
  const valid = {
    version: 1,
    docId: 'doc_1',
    docHash: 'hash',
    nodes: [
      {
        id: 'n1',
        kind: 'claim',
        title: '标题',
        anchors: [{ docId: 'doc_1', docHash: 'hash', charStart: 0, charEnd: 4, quote: '引文' }]
      }
    ],
    edges: []
  }

  it('接受合法图文档', () => {
    expect(validateGraphDocument(valid).ok).toBe(true)
  })

  it('拒绝无锚点节点', () => {
    const bad = { ...valid, nodes: [{ id: 'n1', kind: 'claim', title: '标题', anchors: [] }] }
    const result = validateGraphDocument(bad)
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.message.includes('锚点'))).toBe(true)
  })

  it('拒绝未知边类型与悬空端点', () => {
    const bad = {
      ...valid,
      edges: [{ id: 'e1', from: 'n1', to: 'n404', kind: 'unknown' }]
    }
    const result = validateGraphDocument(bad)
    expect(result.ok).toBe(false)
  })

  it('拒绝版本不匹配', () => {
    expect(validateGraphDocument({ ...valid, version: 2 }).ok).toBe(false)
  })
})

describe('弱模型的块内相对锚点兜底', () => {
  const ctx = { charStart: 1000, charEnd: 2000 }

  it('全局坐标缺失时按块内相对偏移换算', () => {
    const raw = JSON.stringify({
      entities: [{ name: '注意力', type: 'claim', summary: 's', evidence: 'e', spans: [{ charStart: 10, charEnd: 40 }] }],
      relations: []
    })
    const result = parseExtraction(raw, ctx)
    expect(result.ok).toBe(true)
    expect(result.value?.entities[0]?.spans[0]).toEqual({ charStart: 1010, charEnd: 1040 })
    expect(result.issues.some((issue) => issue.message.includes('相对偏移'))).toBe(true)
  })

  it('绝对坐标合法时不走相对换算', () => {
    const raw = JSON.stringify({
      entities: [{ name: '注意力', type: 'claim', summary: 's', evidence: 'e', spans: [{ charStart: 1100, charEnd: 1200 }] }],
      relations: []
    })
    const result = parseExtraction(raw, ctx)
    expect(result.value?.entities[0]?.spans[0]).toEqual({ charStart: 1100, charEnd: 1200 })
  })

  it('两种解释都不合法时仍然丢弃（无锚点不入图）', () => {
    const raw = JSON.stringify({
      entities: [{ name: '注意力', type: 'claim', summary: 's', evidence: 'e', spans: [{ charStart: 5000, charEnd: 6000 }] }],
      relations: []
    })
    const result = parseExtraction(raw, ctx)
    expect(result.value?.entities.length).toBe(0)
    expect(result.value?.dropped).toBe(1)
  })
})

describe('按 evidence 引文重新锚定（弱模型坐标全错但引文是对的）', () => {
  const chunkText = '注意力机制本质上是对序列依赖建模的结构性简化。此前的模型普遍依赖循环结构。'
  const ctx = { charStart: 500, charEnd: 500 + chunkText.length, chunkText }

  it('evidence 在块内唯一命中 → 按命中位置重新锚定', () => {
    const raw = JSON.stringify({
      entities: [
        {
          name: '注意力机制',
          type: 'claim',
          summary: 's',
          evidence: '本质上是对序列依赖建模的结构性简化',
          spans: [{ charStart: 99999, charEnd: 100500 }]
        }
      ],
      relations: []
    })
    const result = parseExtraction(raw, ctx)
    expect(result.value?.entities).toHaveLength(1)
    const span = result.value?.entities[0]?.spans[0]
    expect(span).not.toBeUndefined()
    // 引文从第 6 个字符开始（"注意力机制"之后），锚点应落在 500+6 附近
    expect(span!.charStart).toBeGreaterThanOrEqual(505)
    expect(span!.charEnd).toBeLessThanOrEqual(500 + chunkText.length)
    expect(result.issues.some((issue) => issue.message.includes('重新定位'))).toBe(true)
  })

  it('evidence 带空白差异也能命中（归一化后匹配）', () => {
    const raw = JSON.stringify({
      entities: [
        {
          name: '循环结构',
          type: 'claim',
          summary: 's',
          evidence: '此前的模型 普遍依赖\n循环结构。',
          spans: [{ charStart: 7000, charEnd: 7200 }]
        }
      ],
      relations: []
    })
    const result = parseExtraction(raw, ctx)
    expect(result.value?.entities).toHaveLength(1)
  })

  it('evidence 在块内找不到 → 照旧丢弃（不瞎锚）', () => {
    const raw = JSON.stringify({
      entities: [
        { name: '幻觉', type: 'claim', summary: 's', evidence: '这段话根本不在这块文本里', spans: [{ charStart: 7000, charEnd: 7200 }] }
      ],
      relations: []
    })
    const result = parseExtraction(raw, ctx)
    expect(result.value?.entities).toHaveLength(0)
    expect(result.value?.dropped).toBe(1)
  })
})

describe('片段内相对偏移（源文件切片提交）', () => {
  it('模型给的片段内偏移经翻译回全文坐标后保留', () => {
    const fragment = '甲乙丙丁戊己庚辛壬癸'.repeat(40) // 400 字
    const ctx = {
      charStart: 1000,
      charEnd: 1400,
      chunkText: fragment,
      translateFromChunk: (local: number) => (local >= 0 && local < fragment.length ? 1000 + local : null)
    }
    const raw = JSON.stringify({
      entities: [{ name: '甲', type: 'claim', summary: '', evidence: '', spans: [{ charStart: 10, charEnd: 20 }] }],
      relations: []
    })
    const result = parseExtraction(raw, ctx)
    expect(result.value?.entities).toHaveLength(1)
    // 10 会被翻译成 1010；如果被当成全局偏移就会落进 [1000,1400) 之外/之内都说不通
    expect(result.value?.entities[0].spans[0]).toEqual({ charStart: 1010, charEnd: 1020 })
  })

  it('翻译优先级高于"看起来像全局坐标"的解释（契约变更就落在这里）', () => {
    const fragment = 'x'.repeat(400)
    const ctx = {
      charStart: 50,
      charEnd: 450,
      chunkText: fragment,
      translateFromChunk: (local: number) => (local >= 0 && local < fragment.length ? 50 + local : null)
    }
    const raw = JSON.stringify({
      entities: [{ name: 'A', type: 'claim', summary: '', evidence: '', spans: [{ charStart: 100, charEnd: 120 }] }],
      relations: []
    })
    const spans = parseExtraction(raw, ctx).value?.entities[0].spans[0]
    expect(spans).toEqual({ charStart: 150, charEnd: 170 })
  })

  it('translateFromChunk 越界返回 null → 回落到全局偏移的旧契约', () => {
    const fragment = 'y'.repeat(400)
    const ctx = {
      charStart: 100,
      charEnd: 500,
      chunkText: fragment,
      translateFromChunk: () => null
    }
    const raw = JSON.stringify({
      entities: [{ name: 'A', type: 'claim', summary: '', evidence: '', spans: [{ charStart: 120, charEnd: 130 }] }],
      relations: []
    })
    const entity = parseExtraction(raw, ctx).value?.entities[0]
    expect(entity?.spans[0]).toEqual({ charStart: 120, charEnd: 130 })
  })

  it('evidence 重锚定在片段文本里找到后，也过一遍翻译', () => {
    const fragment = '循环结构在前，之后是结论。'
    const ctx = {
      charStart: 1000,
      charEnd: 1400,
      chunkText: fragment,
      translateFromChunk: (local: number) => (local >= 0 && local < fragment.length ? 1000 + local : null)
    }
    const raw = JSON.stringify({
      entities: [
        { name: '循环', type: 'claim', summary: 's', evidence: '循环结构在前', spans: [{ charStart: 9000, charEnd: 9100 }] }
      ],
      relations: []
    })
    const entity = parseExtraction(raw, ctx).value?.entities[0]
    expect(entity).toBeDefined()
    // 引文落在片段开头 → 映射到 1000 起
    expect(entity?.spans[0].charStart).toBe(1000)
    expect(entity?.spans[0].charEnd).toBe(1006)
  })
})

describe('关系强度', () => {
  const ctx = { charStart: 0, charEnd: 1000 }
  const withStrength = (strength: unknown): number | undefined => {
    const raw = JSON.stringify({
      entities: [
        { name: 'A', type: 'claim', summary: '', evidence: '', spans: [{ charStart: 10, charEnd: 20 }] },
        { name: 'B', type: 'conclusion', summary: '', evidence: '', spans: [{ charStart: 30, charEnd: 40 }] }
      ],
      relations: [
        { from: 'A', to: 'B', type: 'supports', label: '', evidence: '', spans: [{ charStart: 10, charEnd: 20 }], strength }
      ]
    })
    return parseExtraction(raw, ctx).value?.relations[0]?.strength
  }

  it('缺省不写（渲染层按"未给出"处理）', () => {
    expect(withStrength(undefined)).toBeUndefined()
    expect(withStrength('高')).toBeUndefined()
  })

  it('越界夹回 1..10', () => {
    expect(withStrength(99)).toBe(10)
    expect(withStrength(0)).toBe(1)
    expect(withStrength(-5)).toBe(1)
  })

  it('合法值原样保留', () => {
    expect(withStrength(7)).toBe(7)
    expect(withStrength(10)).toBe(10)
  })
})
