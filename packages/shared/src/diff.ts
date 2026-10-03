/**
 * 行级差异（纯函数，主进程与渲染进程共用）。
 *
 * 为什么要自己写而不是拉个 diff 库：
 *  1. 需求很窄 —— "给人看的两文件行差异 + 增删计数"，不需要字符级 diff、不需要合并算法；
 *  2. 结果要**可断言**：单测直接喂两个字符串比对输出，比信任第三方输出格式稳；
 *  3. 主进程与渲染进程都要用（前者算差异，后者渲染），放共享包里省一次序列化往返。
 *
 * 算法：Myers 的简化版（只求 LCS 长度矩阵 → 回溯），输入先按行切分并**限长**：
 * 超过 maxLines 的文件不做逐行差异（直接给"整段替换"的摘要），避免大文件把主进程拖住。
 */

export type DiffRowKind = 'context' | 'add' | 'remove'

export interface DiffRow {
  kind: DiffRowKind
  /** 旧文件里的行号（1 基；add 行为 null） */
  oldLine: number | null
  /** 新文件里的行号（1 基；remove 行为 null） */
  newLine: number | null
  text: string
}

export interface DiffHunk {
  /** 旧文件里的起始行（1 基） */
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  rows: DiffRow[]
}

export interface FileDiff {
  additions: number
  deletions: number
  hunks: DiffHunk[]
  /** 行数超过上限时为 true：只给了摘要，没有逐行内容 */
  truncated: boolean
}

const DEFAULT_MAX_LINES = 4000
const DEFAULT_CONTEXT = 3

function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  // 以换行结尾的文件不该多出一条空行
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** LCS 长度矩阵（滚动两行，省内存）。 */
function lcsMatrix(a: string[], b: string[]): Uint32Array[] {
  const width = b.length + 1
  let previous = new Uint32Array(width)
  const rows: Uint32Array[] = [previous]
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Uint32Array(width)
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1])
    }
    rows.push(current)
    previous = current
  }
  return rows
}

/** 把两个文本切成带行号的差异行序列（未分组）。 */
export function diffRows(oldText: string, newText: string, maxLines = DEFAULT_MAX_LINES): DiffRow[] | null {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  if (a.length > maxLines || b.length > maxLines) return null
  const rows = lcsMatrix(a, b)
  const out: DiffRow[] = []
  let i = a.length
  let j = b.length
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push({ kind: 'context', oldLine: i, newLine: j, text: a[i - 1] })
      i -= 1
      j -= 1
    } else if (rows[i - 1][j] > rows[i][j - 1]) {
      out.push({ kind: 'remove', oldLine: i, newLine: null, text: a[i - 1] })
      i -= 1
    } else {
      // 平局时先出 add：回溯后再 reverse，最终顺序就是"先 - 后 +"（与 git diff 一致）
      out.push({ kind: 'add', oldLine: null, newLine: j, text: b[j - 1] })
      j -= 1
    }
  }
  while (i > 0) {
    out.push({ kind: 'remove', oldLine: i, newLine: null, text: a[i - 1] })
    i -= 1
  }
  while (j > 0) {
    out.push({ kind: 'add', oldLine: null, newLine: j, text: b[j - 1] })
    j -= 1
  }
  return out.reverse()
}

/**
 * 生成给人看的差异：只保留变更附近 context 行，并合并相邻块。
 * 返回 null 表示"内容太大，不做逐行差异"。
 */
export function diffTexts(oldText: string, newText: string, options?: { context?: number; maxLines?: number }): FileDiff | null {
  const context = options?.context ?? DEFAULT_CONTEXT
  const rows = diffRows(oldText, newText, options?.maxLines ?? DEFAULT_MAX_LINES)
  if (!rows) return { additions: 0, deletions: 0, hunks: [], truncated: true }
  const additions = rows.filter((row) => row.kind === 'add').length
  const deletions = rows.filter((row) => row.kind === 'remove').length
  const changed = rows.map((row) => row.kind !== 'context')
  // 标记需要保留的行：变更行 + 前后 context 行
  const keep = new Array(rows.length).fill(false)
  for (let index = 0; index < rows.length; index += 1) {
    if (!changed[index]) continue
    for (let k = Math.max(0, index - context); k <= Math.min(rows.length - 1, index + context); k += 1) keep[k] = true
  }
  const hunks: DiffHunk[] = []
  let cursor = 0
  while (cursor < rows.length) {
    if (!keep[cursor]) {
      cursor += 1
      continue
    }
    const start = cursor
    while (cursor < rows.length && keep[cursor]) cursor += 1
    const slice = rows.slice(start, cursor)
    const first = slice[0]
    /**
     * hunk 头的 `-a,b +c,d` 里 b/d 是**该侧实际存在的行数**（含上下文），
     * 不是"变更行数"：起始行取该侧第一行的行号，没有该侧行时退化为 0。
     * 一开始按"变更行数"写，单测立刻抓出来（oldLines 应该是 2 却给了 4）。
     */
    const oldSide = slice.filter((row) => row.kind !== 'add')
    const newSide = slice.filter((row) => row.kind !== 'remove')
    hunks.push({
      oldStart: oldSide[0]?.oldLine ?? 0,
      oldLines: oldSide.length,
      newStart: newSide[0]?.newLine ?? 0,
      newLines: newSide.length,
      rows: slice
    })
  }
  return { additions, deletions, hunks, truncated: false }
}

/** 统一差异文本（用于日志/复制；界面渲染用结构化数据）。 */
export function unifiedDiff(filePath: string, diff: FileDiff): string {
  const head = '--- a/' + filePath + '\n+++ b/' + filePath
  const body = diff.hunks
    .map((hunk) => {
      const header = '@@ -' + hunk.oldStart + ',' + hunk.oldLines + ' +' + hunk.newStart + ',' + hunk.newLines + ' @@'
      const lines = hunk.rows.map((row) => (row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ' ') + row.text)
      return [header, ...lines].join('\n')
    })
    .join('\n')
  return head + '\n' + body
}
