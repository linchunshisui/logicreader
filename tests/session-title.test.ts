import { describe, expect, it } from 'vitest'
import { cleanSessionTitle, resolveSessionTitle, shortSessionId } from '../apps/main/src/services/agent/session-title'

/**
 * 历史会话的"人能看懂的名字"。
 *
 * 用户的原话：历史会话记录应支持总结命名，直观明了的知道内容是什么。
 * 起因是实测发现 dsh 的 ACP `session/list` **只回 sessionId 与 cwd**（没有标题字段），
 * 界面上只能显示一串 UUID。
 */
describe('cleanSessionTitle：把提示词/正文洗成一句标题', () => {
  it('带位置描述头与引用块的提示词，取"问题"那一段', () => {
    const prompt = [
      '【引用原文】（第 4 页）SFT is supervised fine-tuning...',
      '',
      '【问题】这篇文章的 SFT 部分在说什么？'
    ].join('\n')
    expect(cleanSessionTitle(prompt)).toBe('这篇文章的 SFT 部分在说什么？')
  })

  it('去掉 markdown 记号、@文件引用与多余空白', () => {
    expect(cleanSessionTitle('  ## **计划**  \n\n- 读一下 @D:/逻辑阅读器/apps/main/src/foo.ts 再说 ')).toBe(
      '计划 读一下 再说'
    )
  })

  it('代码块整段丢掉，行内代码只留内容', () => {
    expect(cleanSessionTitle('看下 ```ts\nconst a = 1\n``` 和 `graph.service.ts` 这两处')).toBe('看下 和 graph.service.ts 这两处')
  })

  it('超长截断并加省略号；空内容返回 null', () => {
    const long = '一'.repeat(60)
    expect(cleanSessionTitle(long)?.endsWith('…')).toBe(true)
    expect(cleanSessionTitle(long)?.length).toBe(41)
    expect(cleanSessionTitle('   ')).toBeNull()
    expect(cleanSessionTitle(null)).toBeNull()
  })
})

describe('resolveSessionTitle：优先级', () => {
  it('用户/AI 命名 > Agent 给的名字 > 我们的首条提问 > Agent 的首条提问', () => {
    expect(
      resolveSessionTitle({ stored: '我起的名字', agentTitle: 'agent', ourTitle: 'ours', firstPrompt: 'prompt' })
    ).toEqual({ title: '我起的名字', source: 'stored' })
    expect(resolveSessionTitle({ agentTitle: 'agent', ourTitle: 'ours', firstPrompt: 'prompt' })).toEqual({
      title: 'agent',
      source: 'agent'
    })
    expect(resolveSessionTitle({ ourTitle: 'ours', firstPrompt: 'prompt' })).toEqual({ title: 'ours', source: 'ours' })
    expect(resolveSessionTitle({ firstPrompt: 'prompt' })).toEqual({ title: 'prompt', source: 'prompt' })
  })

  it('全都没有名字时给 null（界面显示"未命名会话 + 短 id"，而不是整串 UUID）', () => {
    expect(resolveSessionTitle({})).toEqual({ title: null, source: null })
    expect(resolveSessionTitle({ stored: '   ', firstPrompt: null })).toEqual({ title: null, source: null })
  })

  it('空字符串不会顶掉后面的候选', () => {
    expect(resolveSessionTitle({ stored: '', agentTitle: '', ourTitle: 'ours' })).toEqual({ title: 'ours', source: 'ours' })
  })
})

describe('shortSessionId', () => {
  it('取前 8 位', () => {
    expect(shortSessionId('41144446-3c2d-4d3e-8076-a9d1c9701da8')).toBe('41144446')
    expect(shortSessionId('abc')).toBe('abc')
  })
})
