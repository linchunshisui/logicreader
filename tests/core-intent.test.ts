import { describe, expect, it } from 'vitest'
import { coreIntentOf } from '../apps/renderer/src/state/askFlow'

/**
 * 核心诉求提取（历史回放显示用）。
 *
 * 用户反馈：历史会话回放里显示的不该是"发给 Agent 的完整材料"（引用原文 + 位置头 + 选区全文），
 * 而是"用户真正想问的那句"——比如"解释选中的内容：Maximum Compound Divergence (MCD)"。
 * 实际发给 Agent 的提问**不精简**（一个字也不少），只是历史/图节点显示摘要。
 */
describe('coreIntentOf：从提问提取核心诉求', () => {
  it('带材料前缀的预设提问：保留动作标签 + 选区开头一小段', () => {
    const question = '解释选中的内容：\nWe adopt the three Maximum Compound Divergence (MCD) splits provided in the original dataset, which are specifically designed to induce strong compositional distribution shifts.'
    const intent = coreIntentOf(question)
    expect(intent.startsWith('解释选中的内容：')).toBe(true)
    // 选区被收进一小段（不再整段摆出来）
    expect(intent.length).toBeLessThan(100)
    expect(intent).toContain('MCD')
  })

  it('选区超长时截断并带省略号', () => {
    const question = '解释选中的内容：\n' + 'x'.repeat(500)
    const intent = coreIntentOf(question)
    expect(intent.endsWith('…')).toBe(true)
    expect(intent.length).toBeLessThan(120)
  })

  it('没有材料前缀的普通提问：就是原文（截 80 字）', () => {
    expect(coreIntentOf('这篇论文在讲什么？')).toBe('这篇论文在讲什么？')
    const long = '问'.repeat(200)
    expect(coreIntentOf(long)).toHaveLength(80)
  })

  it('标签后没有内容的极端情况：只给标签', () => {
    expect(coreIntentOf('解释选中的内容：')).toBe('解释选中的内容')
    expect(coreIntentOf('解释选中的内容：   ')).toBe('解释选中的内容')
  })

  it('冒号出现在很靠后的位置（不像"标签："的形态）→ 按普通提问处理', () => {
    const text = '这是一段没有预设标签的普通提问，但里面有一个冒号：后面的内容'
    expect(coreIntentOf(text)).toBe(text.slice(0, 80))
  })
})
