/**
 * 跳转高亮的"范围收拾"：不许圈半个词、不许吃空白。
 * 用户反馈的原话是"圈选这半个词表意不明"，这组用例把它钉成回归断言。
 */
import { describe, expect, it } from 'vitest'
import { expandRevealRange } from '../packages/document-model/src'

const paragraph =
  'With SWA Bounded Replay, the persistent KV cache footprint is further reduced to approximately 1/8 of that of DeepSeek-V4-Flash.'

describe('expandRevealRange', () => {
  it('起点落在词中间时补到词首', () => {
    const start = paragraph.indexOf('reduced') + 3 // "red|uced"
    const result = expandRevealRange(paragraph, start, start + 4)
    expect(paragraph.slice(result.charStart, result.charEnd)).toBe('reduced')
  })

  it('终点落在词中间时补到词尾', () => {
    const start = paragraph.indexOf('approximately')
    const end = start + 6 // "approx|imately"
    const result = expandRevealRange(paragraph, start, end)
    expect(paragraph.slice(result.charStart, result.charEnd)).toBe('approximately')
  })

  it('两头都在词中间时整词展开（"半个词"的现场）', () => {
    const start = paragraph.indexOf('footprint') + 4
    const end = paragraph.indexOf('footprint') + 6
    const result = expandRevealRange(paragraph, start, end)
    expect(paragraph.slice(result.charStart, result.charEnd)).toBe('footprint')
  })

  it('不吃两头的空白', () => {
    const start = paragraph.indexOf(' Bounded')
    const end = paragraph.indexOf('Replay') + 'Replay'.length
    const result = expandRevealRange(paragraph, start, end)
    expect(paragraph.slice(result.charStart, result.charEnd)).toBe('Bounded Replay')
  })

  it('本来就是完整词时不动它', () => {
    const start = paragraph.indexOf('cache')
    const result = expandRevealRange(paragraph, start, start + 'cache'.length)
    expect(result).toEqual({ charStart: start, charEnd: start + 5 })
  })

  it('中文不做词边界扩展（没有词间空格，扩了会吃掉整段）', () => {
    const text = '因此，我们可以推断：该结论在长上下文场景下依然成立。'
    const start = text.indexOf('推断') + 1
    const result = expandRevealRange(text, start, start + 4)
    expect(result.charStart).toBe(start)
    expect(text.slice(result.charStart, result.charEnd)).toBe('断：该结')
  })

  it('越界区间被夹回文本范围内', () => {
    expect(expandRevealRange('abc', -5, 99)).toEqual({ charStart: 0, charEnd: 3 })
    expect(expandRevealRange('abc', 99, 120)).toEqual({ charStart: 3, charEnd: 3 })
  })

  it('倒置/塌缩的区间落在词里时，取它所在的那个词（不会返回空区间）', () => {
    // "abc" 的第 2 个字符处塌缩 → 整个词
    expect(expandRevealRange('abc', 2, 1)).toEqual({ charStart: 0, charEnd: 3 })
    // "ab cd" 的第 4 个字符处塌缩 → "cd"
    expect(expandRevealRange('ab cd', 4, 3)).toEqual({ charStart: 3, charEnd: 5 })
  })
})
