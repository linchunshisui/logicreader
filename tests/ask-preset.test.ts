/**
 * 送给 Agent 的问题里，**选区文本必须完整**。
 * 用户反馈："选中标题，但提交给 agent 工具的文不全" —— 老实现截断到 60 字，
 * 一整行标题被砍在"…of SQL"上。这组用例把"不许悄悄截断"钉住。
 */
import { describe, expect, it } from 'vitest'
import { MAX_QUESTION_SELECTION_CHARS, buildSelectionQuestion } from '../apps/renderer/src/lib/askPreset'

const title = 'Combinatorial Generalization Ability Evaluation Method of SQL-to-text Model'

describe('buildSelectionQuestion', () => {
  it('整段选区原样进入问题（不再截断到 60 字）', () => {
    const built = buildSelectionQuestion({ label: '翻译选中的内容', text: title, fullQuoteInContext: true })
    expect(built.truncated).toBe(false)
    expect(built.included).toBe(title.length)
    expect(built.question).toContain(title)
    expect(built.question.startsWith('翻译选中的内容：')).toBe(true)
  })

  it('用户原反馈的长度（77 字）必须一字不少', () => {
    const built = buildSelectionQuestion({ label: '翻译', text: title, fullQuoteInContext: true })
    // 老实现是 slice(0, 60)：这里直接比对"问题里确实有整行标题"
    expect(built.question.includes(title)).toBe(true)
    expect(built.question.length).toBeGreaterThan(60)
  })

  it('确实超长时截断，但必须说明截了多少、完整内容在哪', () => {
    const long = 'x'.repeat(MAX_QUESTION_SELECTION_CHARS + 500)
    const built = buildSelectionQuestion({ label: '解释', text: long, fullQuoteInContext: true })
    expect(built.truncated).toBe(true)
    expect(built.included).toBe(MAX_QUESTION_SELECTION_CHARS)
    expect(built.question).toContain('以上为前 ' + MAX_QUESTION_SELECTION_CHARS + ' 字')
    expect(built.question).toContain('完整选区见上文【引用原文】')
  })

  it('上下文没带完整引用时不许撒谎', () => {
    const long = 'y'.repeat(MAX_QUESTION_SELECTION_CHARS + 1)
    const built = buildSelectionQuestion({ label: '解释', text: long, fullQuoteInContext: false })
    expect(built.question).not.toContain('【引用原文】')
    expect(built.question).toContain('建议缩小选区后重试')
  })
})
