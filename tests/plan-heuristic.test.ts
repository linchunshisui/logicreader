import { describe, expect, it } from 'vitest'
import { looksLikePlan, planModeReminder } from '@logicreader/shared'

/**
 * 计划模式的"死板"是用户直接提出来的：计划档下问一句只读问题，回答也被当成方案弹卡片。
 * 这条判定就是那个闸门 —— 只有真的像方案才弹，别把普通回答拦在审批后面。
 */
describe('计划模式：先判断任务是否需要计划', () => {
  it('给模型的约定里写明"先判断"，并且不再要求每条回复都给方案', () => {
    const zh = planModeReminder('zh-CN')
    expect(zh).toContain('先判断这个任务')
    expect(zh).toContain('只读')
    expect(zh).not.toContain('先给出简短有序的方案（目标、步骤、会改到哪些文件、风险），然后停下等用户确认。\n- 不要修改文件')
    const en = planModeReminder('en-US')
    expect(en).toContain('First judge whether this task actually needs a plan')
    expect(en).toContain('Do not modify files')
  })
})

describe('looksLikePlan：只把"真方案"当方案', () => {
  it('短回答不算（"这段在讲什么"这类只读问题直接答）', () => {
    expect(looksLikePlan('这段在讲 SFT 与 RL 的分工：SFT 提供初始策略，RL 做组合泛化修正。')).toBe(false)
    expect(looksLikePlan('')).toBe(false)
  })

  it('带方案小标题的算', () => {
    const text = [
      '## 实施计划',
      '',
      '1. 先读一遍 `graph.service.ts` 里抽取管线的入口，确认分块与重试的边界；',
      '2. 再把校验失败的整批丢弃改成逐块留痕，避免一个坏块带走全篇；',
      '3. 最后补一条单测，覆盖"校验失败但仍要出图"的路径。'
    ].join('\n')
    expect(looksLikePlan(text)).toBe(true)
  })

  it('英文小标题同样认（Plan / Steps）', () => {
    const text = [
      '### Steps',
      '',
      '- Inspect the current resolver and confirm how candidate paths are ordered;',
      '- Add the bundled-command directory to the search list and log which one won;',
      '- Cover the new branch with a unit test that feeds a shim fixture.'
    ].join('\n')
    expect(looksLikePlan(text)).toBe(true)
  })

  it('长回答但只是分点解释（没有方案语义）不算', () => {
    const text = [
      '这篇论文的三条结论分别是：',
      '',
      '- 第一条讲的是 token 级监督只约束单个位置的预测分布，不直接约束整条序列是否符合组合规则；',
      '- 第二条讲的是 teacher forcing 训练时用的是 gold 前缀，推理时用的是自己上一步生成的 token；',
      '- 第三条讲的是在最短的长度的分桶里，SFT 就已经明显落后于基于 outcome 的强化学习方案。'
    ].join('\n')
    expect(looksLikePlan(text)).toBe(false)
  })
})
