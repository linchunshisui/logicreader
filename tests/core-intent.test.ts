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

/**
 * 回放历史会话时，Agent 的报文日志里那条"用户消息"其实是
 * `systemContext + '\n\n' + 问题`（拼装见 services/agent/sdk.ts 的 prompt）。
 * 如果把开头 80 字当核心诉求，气泡里显示的就是我们**注入的授权模式提醒** ——
 * 用户报的正是这个（"行为与后续回答对应"）。
 */
describe('coreIntentOf：先摘掉我们注入的前导块', () => {
  const reminder =
    '【授权模式：计划】\n- 先判断这个任务**是否真的需要计划**：只是解释、检索、总结、回答这类**只读**请求，就直接给出结论，不要编步骤、也不要为了走流程而写方案；\n- 只有当用户要求你改动文件 / 执行命令，或这件事确实分多步且有取舍时，才先给出简短有序的方案（目标、步骤、会改到哪些文件、风险），然后停下等用户确认；\n- 不要修改文件，也不要执行会改变状态的命令；'

  it('授权模式提醒 + 提问 → 显示提问（不再显示提醒）', () => {
    const sent = reminder + '\n\n' + '解释选中的内容：Maximum Compound Divergence'
    expect(coreIntentOf(sent)).toBe('解释选中的内容：Maximum Compound Divergence')
  })

  it('提醒 + 引用位置 + 引用原文 → 只留提问', () => {
    // 与 contextBuilder 的真实形状一致：每段是"头 + 正文"同一个块（用 '\n' 相连），段与段之间才是 '\n\n'
    const context = ['【引用位置】《survey》第 3 段（全文字符 120–160）', '【引用原文】\n"We adopt the three MCD splits"'].join('\n\n')
    const sent = reminder + '\n\n' + context + '\n\n' + '解释选中的内容：We adopt the three MCD splits'
    expect(coreIntentOf(sent)).toBe('解释选中的内容：We adopt the three MCD splits')
  })

  it('大块（全文）内部有空行 → 取最后一段（提问总在最末尾）', () => {
    const fulltext = '【文档全文】\n第一段\n\n第二段\n\n第三段'
    const sent = reminder + '\n\n' + fulltext + '\n\n' + '请通读这份文档，给我一份总结理解'
    expect(coreIntentOf(sent)).toBe('请通读这份文档，给我一份总结理解')
  })

  it('English 提醒同样被摘掉', () => {
    const sent = '[Permission mode: plan]\n- First judge whether this task actually needs a plan.\n\nSummarize this paper.'
    expect(coreIntentOf(sent)).toBe('Summarize this paper.')
  })

  it('用户自己写的提问原样不动（没有注入头时不做任何裁剪）', () => {
    const plain = '【我的提纲】先看这一节，再回头对照表格'
    expect(coreIntentOf(plain)).toBe(plain.slice(0, 80))
  })

  it('只有提醒、没有提问时返回空串（不把提醒当诉求）', () => {
    expect(coreIntentOf(reminder)).toBe('')
  })
})
