/**
 * 按块（hunk）回退文件改动 —— 纯函数，主进程与渲染进程共用。
 *
 * 背景：VS Code 的 Claude Code 扩展能把 AI 的改动**逐块**接受/拒绝。
 * 我们的形态是在对话框里做后置审阅，所以实现的是"**反向打补丁**"：
 * 手里有改动前的基线（PreToolUse 抓的）与改动后的内容，就能重建出
 * "只保留用户勾选的那几块"的版本。
 *
 * 为什么不直接写回基线：一次 Write/Edit 可能带来多块改动，用户只想撤其中一块。
 * 重建规则 = "改动后的内容，但把**被选中的那些块**换成基线里的对应行"；
 * 没被选中的块保持改动后的样子（也就是"只回退这一块"）。
 *
 * 安全前提（调用方必须满足）：当前磁盘内容仍等于"改动后"的内容。
 * 否则说明之后又有人改过，硬写会**静默覆盖**别人的改动 —— 这种情况必须报冲突。
 */

export interface TextHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  rows: { kind: string; oldLine: number | null; newLine: number | null; text: string }[]
}

export interface RevertResult {
  ok: boolean
  /** 重建后的内容（ok=false 时为原样返回的当前内容） */
  content: string
  /** 失败原因：文件与预期不一致（说明之后又被改过） */
  conflict?: string
}

function splitKeepEnd(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text.length === 0) return { lines: [], trailingNewline: false }
  const trailingNewline = text.endsWith('\n')
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (trailingNewline) lines.pop()
  return { lines, trailingNewline }
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return ''
  return lines.join('\n') + (trailingNewline ? '\n' : '')
}

/**
 * 把 `after` 内容按块回退：`revertIndices` 里的块恢复成 `before` 的对应行，其余保持 `after`。
 *
 * @param before 改动前的内容（基线）
 * @param after  改动后的内容（同一时刻读到的）
 * @param current 当前磁盘内容（用于冲突检测）
 * @param hunks  差异块（来自 diffTexts）
 * @param revertIndices 要回退的块下标
 */
export function revertHunks(
  before: string,
  after: string,
  current: string,
  hunks: TextHunk[],
  revertIndices: number[]
): RevertResult {
  const normalize = (value: string): string => value.replace(/\r\n/g, '\n')
  if (normalize(current) !== normalize(after)) {
    return { ok: false, content: current, conflict: '文件在本次改动之后又被修改过，已放弃回退' }
  }
  const beforeDoc = splitKeepEnd(before)
  const afterDoc = splitKeepEnd(after)
  const revert = new Set(revertIndices)
  const out: string[] = []
  // 按 after 的行号推进；被回退的块用 before 的对应行替换
  const hunksByNewStart = hunks
    .map((hunk, index) => ({ hunk, index }))
    .sort((a, b) => a.hunk.newStart - b.hunk.newStart)
  let cursor = 1 // after 的 1 基行号
  for (const { hunk, index } of hunksByNewStart) {
    // 复制该块之前的未改动行
    while (cursor < hunk.newStart) {
      out.push(afterDoc.lines[cursor - 1] ?? '')
      cursor += 1
    }
    const newRows = hunk.rows.filter((row) => row.kind !== 'remove')
    const oldRows = hunk.rows.filter((row) => row.kind !== 'add')
    if (revert.has(index)) {
      for (const row of oldRows) out.push(row.text)
    } else {
      for (const row of newRows) out.push(row.text)
    }
    cursor = hunk.newStart + Math.max(newRows.length, 1)
    if (newRows.length === 0) cursor = hunk.newStart // 纯删除块：after 侧没有行可跳
  }
  while (cursor <= afterDoc.lines.length) {
    out.push(afterDoc.lines[cursor - 1] ?? '')
    cursor += 1
  }
  // 尾部空行为 0 时保留 after 的结尾风格
  return { ok: true, content: joinLines(out, afterDoc.trailingNewline) }
}
