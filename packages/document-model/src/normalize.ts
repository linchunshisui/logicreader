/**
 * 归一化规则（规划书 §5.1）：
 * 统一换行符；折叠连续空白；不改变大小写；保留标点；中文不做分词。
 */

export interface NormalizedText {
  /** 归一化后的文本 */
  text: string
  /** map[i] = 归一化文本第 i 个字符在原始文本中的下标 */
  map: number[]
}

const WHITESPACE = /\s/

/** 是否 CJK 字符（用于 token 估算与分块，不做分词） */
export function isCjk(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0
  return (
    (c >= 0x3000 && c <= 0x303f) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xff00 && c <= 0xffef) ||
    (c >= 0x20000 && c <= 0x2fa1f)
  )
}

/**
 * 归一化并同时产出偏移映射表。
 * 折叠规则：连续空白折叠为单个空格；\r\n / \r 归一为 \n；行首行尾空白去除。
 */
export function normalizeWithMap(raw: string, options: { collapseWhitespace?: boolean } = {}): NormalizedText {
  const collapse = options.collapseWhitespace !== false
  const out: string[] = []
  const map: number[] = []
  let i = 0
  let pendingSpace = false
  let pendingSpaceIndex = -1

  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '\r') {
      // \r\n → \n，单独 \r → \n
      if (raw[i + 1] === '\n') i += 1
      pendingSpace = false
      out.push('\n')
      map.push(i)
      i += 1
      continue
    }
    if (ch === '\n') {
      pendingSpace = false
      out.push('\n')
      map.push(i)
      i += 1
      continue
    }
    if (collapse && WHITESPACE.test(ch)) {
      if (!pendingSpace && out.length > 0 && out[out.length - 1] !== '\n') {
        pendingSpace = true
        pendingSpaceIndex = i
      }
      i += 1
      continue
    }
    if (pendingSpace) {
      // 只有当后面确实还有非空白内容时才落一个空格
      out.push(' ')
      map.push(pendingSpaceIndex)
      pendingSpace = false
    }
    out.push(ch)
    map.push(i)
    i += 1
  }
  return { text: out.join(''), map }
}

/** 仅归一化文本（不需要映射时使用）。 */
export function normalizeText(raw: string): string {
  return normalizeWithMap(raw).text
}

/** 归一化后用于快速比对的哈希（FNV-1a 变体，输出 16 位十六进制）。 */
export function quoteHash(raw: string): string {
  const t = normalizeText(raw)
  let h1 = 0x811c9dc5
  let h2 = 0x1000193
  for (let i = 0; i < t.length; i += 1) {
    const c = t.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0
    h2 = Math.imul(h2 + c + i, 2246822519) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

/** 粗略 token 估算：CJK 约 1 token/字，拉丁约 1 token/4 字符。 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (isCjk(ch)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk + other / 4)
}

/** Levenshtein 距离（带滚动数组与上界剪枝）。 */
export function levenshtein(a: string, b: string, maxDistance = Number.MAX_SAFE_INTEGER): number {
  const n = a.length
  const m = b.length
  if (n === 0) return m
  if (m === 0) return n
  if (Math.abs(n - m) > maxDistance) return maxDistance + 1
  let prev = new Array<number>(m + 1)
  let cur = new Array<number>(m + 1)
  for (let j = 0; j <= m; j += 1) prev[j] = j
  for (let i = 1; i <= n; i += 1) {
    cur[0] = i
    let rowMin = cur[0]
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= m; j += 1) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (cur[j] < rowMin) rowMin = cur[j]
    }
    if (rowMin > maxDistance) return maxDistance + 1
    const tmp = prev
    prev = cur
    cur = tmp
  }
  return prev[m]
}

/**
 * 相似度 0..1。
 * 为控制开销，距离超过 `(1 - threshold) * max` 时不再精算，直接返回低于阈值的保守值。
 */
export function similarity(a: string, b: string, threshold = 0.5): number {
  const max = Math.max(a.length, b.length)
  if (max === 0) return 1
  const allowed = Math.max(1, Math.floor(max * (1 - threshold)))
  const d = levenshtein(a, b, allowed)
  if (d > allowed) return Math.max(0, 1 - (allowed + 1) / max)
  return 1 - d / max
}
