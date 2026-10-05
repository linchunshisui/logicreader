import { describe, expect, it } from 'vitest'
import { mapPrompt } from './graph.service'
import { EDGE_KINDS } from '@logicreader/graph-schema'

const BASE = {
  chunkText: '## 小节\n自注意力把序列内部对齐。\n',
  headingPath: ['3 方法', '3.2 注意力机制'],
  title: '注意力就是你需要的',
  charStart: 21,
  charEnd: 41,
  nodeKinds: ['claim', 'conclusion', 'evidence', 'definition'],
  edgeKinds: [...EDGE_KINDS],
  locale: 'zh-CN',
  density: 3.5
}

describe('抽取提示词', () => {
  it('逐条给出关系类型的语义与方向（否则模型只能靠猜）', () => {
    const prompt = mapPrompt(BASE)
    expect(prompt).toContain('causes=A 导致 B')
    expect(prompt).toContain('refutes=A 反驳 / 否定 B')
    expect(prompt).toContain('from → to')
    // 九种边类型的语义一个都不能漏
    for (const kind of EDGE_KINDS) expect(prompt).toContain(kind + '=')
  })

  it('spans 要求片段内相对偏移，并说明字符范围仅供定位', () => {
    const prompt = mapPrompt(BASE)
    expect(prompt).toContain('相对本片段文本、从 0 开始')
    expect(prompt).toContain('[ 21, 41 )')
    expect(prompt).toContain('仅供定位参考')
  })

  it('要求给出关系强度，并在输出结构里示例', () => {
    const prompt = mapPrompt(BASE)
    expect(prompt).toContain('strength')
    expect(prompt).toContain('"strength":5')
  })

  it('源文件切片时说明结构是原样的', () => {
    const withSource = mapPrompt({ ...BASE, sourceFormat: true })
    expect(withSource).toContain('保留源文件格式')
    // 不带该标记时退回普通标题，不再宣称保留了结构
    expect(mapPrompt(BASE)).not.toContain('保留源文件格式')
  })

  it('正文标记必须逐字稳定 —— 下游（mock 适配器）是按字面找它的', () => {
    // 回归：曾把说明拼进标记（`【片段原文（…）】`），下游 indexOf 落空后
    // 把提示词头部当成正文抽，静默产出一张烂图。标记不许带任何后缀。
    for (const sourceFormat of [true, false]) {
      expect(mapPrompt({ ...BASE, sourceFormat })).toContain('\n【片段原文】\n')
    }
    expect(mapPrompt({ ...BASE, locale: 'en-US', sourceFormat: true })).toContain('\n[FRAGMENT]\n')
  })

  it('英文提示词同样带语义与相对偏移要求', () => {
    const prompt = mapPrompt({ ...BASE, locale: 'en-US' })
    expect(prompt).toContain('causes=A causes B')
    expect(prompt).toContain('relative to the fragment text')
    expect(prompt).toContain('for orientation only')
  })
})
