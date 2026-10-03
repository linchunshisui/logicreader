/**
 * 读 DeepSeek Harness 自己的会话日志，取出**标题**与**第一句提问**。
 *
 * 为什么必须走它的磁盘日志：ACP 的 `session/list` **只回 sessionId 与 cwd**（实测 0.2.0-rc.2），
 * 而 dsh 其实把标题写在自己的会话日志里（`session/title`，还带一份 LLM 生成的版本），
 * 第一句提问也在同一份日志里（`user/message`，`source.kind === 'user'`）。
 *
 * 日志布局：`~/.dsh/sessions/<按 cwd 编码的目录>/<sessionId|session-<sessionId>>/session.v4.jsonl.zstd`
 * 内容是 **多帧拼接** 的 zstd（每帧一段 JSONL）。Node 的 `zstdDecompressSync` 只解第一帧，
 * 所以这里按 zstd 魔数 `28 B5 2F FD` 切帧逐个解 —— 实测一个 5.8MB 的会话能切出 2853 帧。
 *
 * 性能纪律：**只读开头**（默认 512KB，够拿到第 15~24 条记录），拿到标题 + 第一句就走。
 */
import { existsSync, readdirSync, readSync, openSync, closeSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** zstd 帧魔数（小端 0xFD2FB528） */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export interface DshSessionHint {
  /** dsh 自己记的标题（优先 LLM 生成的 `provider` 来源，其次 `fallback`） */
  title: string | null
  /** 第一句**用户**说的话（跳过"审批策略已变更"这类系统注入） */
  firstUserText: string | null
}

/** dsh 的会话根目录（`$DSH_HOME/sessions`，默认 `~/.dsh/sessions`）。 */
export function dshSessionsRoot(): string {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/**
 * 建一张 `sessionId → 日志文件` 的索引（一次列表只建一次，避免每行都去 stat 一遍）。
 * dsh 会按 cwd 分目录，且目录名有两种：`<uuid>`（ACP 建的）与 `session-<uuid>`（桌面端建的）。
 */
export function indexDshSessionLogs(root = dshSessionsRoot()): Map<string, string> {
  const index = new Map<string, string>()
  let groups: string[] = []
  try {
    groups = readdirSync(root)
  } catch {
    return index
  }
  for (const group of groups) {
    const dir = join(root, group)
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const sessionId = entry.startsWith('session-') ? entry.slice('session-'.length) : entry
      const file = join(dir, entry, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      /**
       * **两种 id 形态都要能查到**：ACP 的 `session/list` 对桌面端建的会话回的是
       * `session-<uuid>`（带前缀），而目录名与 ACP 自己建的会话是裸 `<uuid>`。
       * 只按一种键存，另一类会话就查不到日志、标题永远是空（本轮实测踩到）。
       */
      const keys = entry.startsWith('session-') ? [sessionId, entry] : [sessionId, 'session-' + sessionId]
      for (const key of keys) {
        const previous = index.get(key)
        if (!previous) {
          index.set(key, file)
          continue
        }
        try {
          // 同一个会话 id 若有多处，保留**更大**的那份（内容更全）
          if (statSync(file).size > statSync(previous).size) index.set(key, file)
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  return index
}

/** 把一段（可能是多帧拼接的）zstd 缓冲解出来；解不动的帧跳过。 */
export function decodeZstdFrames(buffer: Buffer): string {
  const offsets: number[] = []
  let cursor = buffer.indexOf(ZSTD_MAGIC, 0)
  while (cursor >= 0) {
    offsets.push(cursor)
    cursor = buffer.indexOf(ZSTD_MAGIC, cursor + 1)
  }
  let text = ''
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    try {
      text += zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
    } catch {
      // 最后一帧可能被截断：忽略即可，前面已经解出来的够用
    }
  }
  return text
}

/** 从 JSONL 文本里挑出标题与第一句用户提问（纯函数，可单测）。 */
export function pickDshSessionHint(jsonl: string): DshSessionHint {
  let fallbackTitle: string | null = null
  let providerTitle: string | null = null
  let firstUserText: string | null = null
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.charCodeAt(0) !== 123 /* '{' */) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    const type = String(record.type ?? '')
    const data = (record.data ?? {}) as Record<string, unknown>
    if (type === 'session/title') {
      const title = typeof data.title === 'string' ? data.title.trim() : ''
      if (title.length === 0) continue
      const kind = String((data.source as { kind?: unknown } | undefined)?.kind ?? '')
      if (kind === 'provider') providerTitle = title
      else if (!fallbackTitle) fallbackTitle = title
      continue
    }
    if (type === 'user/message' && !firstUserText) {
      const source = (data.source ?? {}) as { kind?: unknown }
      // 只认真正由人发出的消息："审批策略变更"这类是系统注入，不能当标题
      if (String(source.kind ?? '') !== 'user') continue
      const parts = Array.isArray(data.content) ? (data.content as { type?: string; text?: string }[]) : []
      const text = parts
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => String(part.text))
        .join('\n')
        .trim()
      if (text.length > 0) firstUserText = text
    }
    if (providerTitle && firstUserText) break
  }
  return { title: providerTitle ?? fallbackTitle, firstUserText }
}

/** 读一个会话日志的开头，取出标题与第一句提问。文件不存在/读不动一律返回空。 */
export function readDshSessionHint(file: string, maxBytes = 512 * 1024): DshSessionHint {
  const empty: DshSessionHint = { title: null, firstUserText: null }
  let fd: number | null = null
  try {
    const size = statSync(file).size
    const length = Math.min(size, maxBytes)
    if (length <= 0) return empty
    const buffer = Buffer.allocUnsafe(length)
    fd = openSync(file, 'r')
    const read = readSync(fd, buffer, 0, length, 0)
    return pickDshSessionHint(decodeZstdFrames(buffer.subarray(0, read)))
  } catch {
    return empty
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* 忽略 */
      }
    }
  }
}
