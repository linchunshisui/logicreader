import { describe, expect, it } from 'vitest'
import { diffTexts, revertHunks, type TextHunk } from '@logicreader/shared'

const text = (...lines: string[]): string => lines.join('\n') + '\n'
const hunksOf = (before: string, after: string): TextHunk[] => (diffTexts(before, after)?.hunks ?? []) as TextHunk[]

describe('按块回退', () => {
  it('回退唯一一块 = 完全回到改动前', () => {
    const before = text('a', 'b', 'c')
    const after = text('a', 'B', 'c')
    const result = revertHunks(before, after, after, hunksOf(before, after), [0])
    expect(result.ok).toBe(true)
    expect(result.content).toBe(before)
  })

  it('只回退其中一块，另一块保留', () => {
    const before = text('1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12')
    const after = text('ONE', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', 'TWELVE')
    const hunks = hunksOf(before, after)
    expect(hunks.length).toBe(2)
    const first = revertHunks(before, after, after, hunks, [0])
    expect(first.ok).toBe(true)
    expect(first.content.split('\n')[0]).toBe('1')
    expect(first.content).toContain('TWELVE')
    const second = revertHunks(before, after, after, hunks, [1])
    expect(second.content).toContain('ONE')
    expect(second.content).toContain('12')
  })

  it('回退全部块 = 回到改动前（多块）', () => {
    const before = text('1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12')
    const after = text('ONE', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', 'TWELVE')
    const result = revertHunks(before, after, after, hunksOf(before, after), [0, 1])
    expect(result.content).toBe(before)
  })

  it('文件在改动之后又被改过 → 报冲突，绝不覆盖', () => {
    const before = text('a', 'b')
    const after = text('a', 'B')
    const current = text('a', 'B', 'someone else appended')
    const result = revertHunks(before, after, current, hunksOf(before, after), [0])
    expect(result.ok).toBe(false)
    expect(result.conflict).toBeTruthy()
    expect(result.content).toBe(current)
  })

  it('CRLF 差异不算冲突', () => {
    const before = 'a\r\nb\r\n'
    const after = 'a\r\nB\r\n'
    const current = 'a\nB\n'
    const result = revertHunks(before, after, current, hunksOf('a\nb\n', 'a\nB\n'), [0])
    expect(result.ok).toBe(true)
    expect(result.content).toContain('b')
  })

  it('新增行块回退后该行消失', () => {
    const before = text('keep', 'tail')
    const after = text('keep', 'added', 'tail')
    const result = revertHunks(before, after, after, hunksOf(before, after), [0])
    expect(result.ok).toBe(true)
    expect(result.content).toBe(before)
  })

  it('删除行块回退后该行回来', () => {
    const before = text('keep', 'gone', 'tail')
    const after = text('keep', 'tail')
    const result = revertHunks(before, after, after, hunksOf(before, after), [0])
    expect(result.ok).toBe(true)
    expect(result.content).toBe(before)
  })

  it('多行整段替换', () => {
    const before = text('h', 'x', 'y', 'f')
    const after = text('h', 'X', 'Y', 'f')
    const result = revertHunks(before, after, after, hunksOf(before, after), [0])
    expect(result.content).toBe(before)
  })
})
