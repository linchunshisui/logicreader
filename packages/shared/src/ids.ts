/** 跨进程可用的短 ID 生成器（不依赖第三方库）。 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

interface RandomSource {
  getRandomValues?: (array: Uint8Array) => Uint8Array
}

function randomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size)
  const c = (globalThis as { crypto?: RandomSource }).crypto
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(out)
    return out
  }
  for (let i = 0; i < size; i += 1) out[i] = Math.floor(Math.random() * 256)
  return out
}

/** 生成形如 `doc_ab12cd34` 的 ID。 */
export function createId(prefix: string, length = 8): string {
  const bytes = randomBytes(length)
  let s = ''
  for (let i = 0; i < length; i += 1) s += ALPHABET[bytes[i] % ALPHABET.length]
  return prefix + '_' + s
}

/** 由内容哈希派生稳定 ID，保证同一文档重复打开时 ID 不变。 */
export function stableId(prefix: string, seed: string, length = 16): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < seed.length; i += 1) {
    const c = seed.charCodeAt(i)
    h1 = (h1 ^ c) >>> 0
    h1 = Math.imul(h1, 16777619) >>> 0
    h2 = (h2 + c) >>> 0
    h2 = Math.imul(h2, 2246822519) >>> 0
  }
  const a = h1.toString(36).padStart(7, '0')
  const b = h2.toString(36).padStart(7, '0')
  return prefix + '_' + (a + b).slice(0, length)
}
