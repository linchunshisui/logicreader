import { describe, expect, it } from 'vitest'
import { diffTexts, unifiedDiff } from '@logicreader/shared'

const text = (...lines: string[]): string => lines.join('\n') + '\n'

describe('行级差异', () => {
  it('识别单行修改（一删一增，不把整段算成变更）', () => {
    const diff = diffTexts(text('a', 'b', 'c'), text('a', 'B', 'c'))
    expect(diff).not.toBeNull()
    expect(diff?.additions).toBe(1)
    expect(diff?.deletions).toBe(1)
    expect(diff?.truncated).toBe(false)
    const kinds = diff?.hunks.flatMap((hunk) => hunk.rows.map((row) => row.kind))
    expect(kinds).toEqual(['context', 'remove', 'add', 'context'])
  })

  it('新增行只算 add，行号连续', () => {
    const diff = diffTexts(text('a', 'c'), text('a', 'b', 'c'))
    expect(diff?.additions).toBe(1)
    expect(diff?.deletions).toBe(0)
    const added = diff?.hunks[0].rows.find((row) => row.kind === 'add')
    expect(added?.newLine).toBe(2)
    expect(added?.oldLine).toBeNull()
  })

  it('删除整段：hunk 头的行数是"该侧含上下文的行数"（与 git diff 一致）', () => {
    const diff = diffTexts(text('keep', 'x', 'y', 'keep2'), text('keep', 'keep2'))
    expect(diff?.deletions).toBe(2)
    expect(diff?.additions).toBe(0)
    const hunk = diff?.hunks[0]
    // 旧侧 4 行（keep + x + y + keep2），新侧 2 行（keep + keep2）
    expect(hunk?.oldStart).toBe(1)
    expect(hunk?.oldLines).toBe(4)
    expect(hunk?.newStart).toBe(1)
    expect(hunk?.newLines).toBe(2)
    expect(hunk?.rows.filter((row) => row.kind === 'remove').map((row) => row.oldLine)).toEqual([2, 3])
  })

  it('相同内容没有差异块', () => {
    const diff = diffTexts(text('same', 'same2'), text('same', 'same2'))
    expect(diff?.hunks).toHaveLength(0)
    expect(diff?.additions).toBe(0)
    expect(diff?.deletions).toBe(0)
  })

  it('相隔很远的改动拆成多个块，且各自带上下文', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']
    const after = before.slice()
    after[0] = 'ONE'
    after[11] = 'TWELVE'
    const diff = diffTexts(text(...before), text(...after), { context: 1 })
    expect(diff?.hunks.length).toBe(2)
    expect(diff?.additions).toBe(2)
    expect(diff?.deletions).toBe(2)
  })

  it('CRLF 与结尾换行不制造假差异', () => {
    const diff = diffTexts('a\r\nb\r\n', 'a\nb\n')
    expect(diff?.hunks).toHaveLength(0)
  })

  it('超长文件退化成摘要（truncated）而不是把主进程拖住', () => {
    const big = Array.from({ length: 30 }, (_, index) => 'line ' + index).join('\n')
    const diff = diffTexts(big, big + '\nextra', { maxLines: 10 })
    expect(diff?.truncated).toBe(true)
    expect(diff?.hunks).toHaveLength(0)
  })

  it('统一差异文本可读且带 hunk 头', () => {
    const diff = diffTexts(text('a', 'b'), text('a', 'c'))!
    const text2 = unifiedDiff('note.txt', diff)
    expect(text2).toContain('--- a/note.txt')
    expect(text2).toContain('@@ -1,2 +1,2 @@')
    expect(text2.split('\n').some((line) => line.startsWith('-b'))).toBe(true)
    expect(text2.split('\n').some((line) => line.startsWith('+c'))).toBe(true)
  })

  it('整文件替换（空 → 有内容）', () => {
    const diff = diffTexts('', text('new'))
    expect(diff?.additions).toBe(1)
    expect(diff?.deletions).toBe(0)
  })
})
