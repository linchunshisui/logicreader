/**
 * 选区内容对齐测试。
 *
 * 这一组测试对应一个真实故障：截图里高亮只有 `input-`（8 个字符），
 * 状态栏却显示"已选中 8 字"、记录的区间还多带了下几个字符 ——
 * 根因是"用 span 端点算区间"，而一个 span 未必等于一个逻辑单元。
 * 现在改为按内容在文档文本里唯一定位，判据不再依赖 DOM 结构。
 */
import { describe, expect, it } from 'vitest'
import { confirmFragments, locateSelectedText, type SelectionResolution } from '../apps/renderer/src/lib/selection'

const model = 'The widespread adoption of long-horizon agents has made model workloads increasingly input-heavy.'

describe('选区内容对齐', () => {
  it('在文档文本里唯一定位选中文字（忽略空白）', () => {
    const located = locateSelectedText(model, 'increasingly input-')
    expect(located).not.toBeNull()
    expect(located?.unique).toBe(true)
    expect(model.slice(located?.charStart, located?.charEnd)).toBe('increasingly input-')
  })

  it('DOM 文本与文档文本空白不一致时仍能命中', () => {
    const located = locateSelectedText(model, 'model  workloads\nincreasingly')
    expect(located).not.toBeNull()
    expect(model.slice(located?.charStart, located?.charEnd)).toBe('model workloads increasingly')
  })

  it('同一句出现多次时，用搜索起点避免定位到第一处', () => {
    const text = 'alpha beta alpha beta'
    const first = locateSelectedText(text, 'alpha beta', 0)
    const second = locateSelectedText(text, 'alpha beta', 6)
    expect(first?.charStart).toBe(0)
    expect(second?.charStart).toBe(11)
  })

  it('span 端点会多算字符时，以内容对齐为准', () => {
    // 模拟"端点所在 span 还包含后面几个词"的情况
    const resolution: SelectionResolution = {
      text: 'input-heavy.',
      charStart: 97,
      charEnd: 118, // 多算了后面 8 个字符
      fragments: [{ start: 97, end: 118 }],
      exact: true
    }
    const confirmed = confirmFragments(model, resolution)
    expect(confirmed.method).toBe('content')
    expect(model.slice(confirmed.charStart, confirmed.charEnd)).toBe('input-heavy.')
  })

  it('内容无法唯一定位时退回片段，再退回端点', () => {
    const ambiguous = 'x x x x x'
    const resolution: SelectionResolution = {
      text: 'x x',
      charStart: 2,
      charEnd: 6,
      fragments: [{ start: 2, end: 6 }],
      exact: false
    }
    const confirmed = confirmFragments(ambiguous, resolution)
    expect(['fragments', 'dom-endpoints']).toContain(confirmed.method)
    expect(confirmed.charStart).toBeGreaterThanOrEqual(0)
    expect(confirmed.charEnd).toBeGreaterThan(confirmed.charStart)
  })
})
