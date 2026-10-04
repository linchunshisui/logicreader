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
      const sessionDir = join(dir, entry)
      /**
       * 文件名**至少三种**：`session.jsonl.zstd`（早期）/ `session.v3…` / `session.v4…`（当前）。
       * 只认 v4 时老会话全部"没有日志"，标题永远空 —— 列目录取匹配里最大的那份。
       */
      let candidates: string[] = []
      try {
        candidates = readdirSync(sessionDir).filter((name) => /^session(\.v\d+)?\.jsonl\.zstd$/.test(name))
      } catch {
        continue
      }
      let file: string | null = null
      let bestSize = -1
      for (const name of candidates) {
        const candidate = join(sessionDir, name)
        try {
          const size = statSync(candidate).size
          if (size > bestSize) {
            bestSize = size
            file = candidate
          }
        } catch {
          /* 忽略 */
        }
      }
      if (!file) continue
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

// ------------------------------------------------------------------ 完整回放（历史会话"点开看全部对话"）

export interface DshTranscriptEntry {
  role: 'user' | 'assistant'
  text: string
  /** 思考正文（assistant 的 reasoning 块；没有为空串） */
  thinking: string
  /** 记录时间（毫秒）；日志里是 epoch ms */
  at: number
}

/**
 * 按会话 id 找它的日志文件。
 * 实测文件名**至少有三种**：`session.jsonl.zstd`（早期）、`session.v3.jsonl.zstd`、
 * `session.v4.jsonl.zstd`（当前）——只认 v4 的话，老会话就"没有日志"。
 * 这里列目录取**名字匹配且最大**的那份（同名多份时内容更全的那个赢）。
 */
export function findDshSessionFile(sessionId: string, root = dshSessionsRoot()): string | null {
  let groups: string[] = []
  try {
    groups = readdirSync(root)
  } catch {
    return null
  }
  for (const group of groups) {
    const dir = join(root, group)
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    // 会话目录名有两种形态：裸 <uuid> 与 session-<uuid>（桌面端）
    if (!entries.includes(sessionId) && !entries.includes('session-' + sessionId)) continue
    const sessionDir = join(dir, entries.includes(sessionId) ? sessionId : 'session-' + sessionId)
    let files: string[] = []
    try {
      files = readdirSync(sessionDir).filter((name) => /^session(\.v\d+)?\.jsonl\.zstd$/.test(name))
    } catch {
      continue
    }
    let best: string | null = null
    let bestSize = -1
    for (const name of files) {
      const file = join(sessionDir, name)
      try {
        const size = statSync(file).size
        if (size > bestSize) {
          bestSize = size
          best = file
        }
      } catch {
        /* 忽略 */
      }
    }
    if (best) return best
  }
  return null
}

/**
 * 读一整个会话日志，还原**全部对话**（历史会话点开时的回放数据源）。
 * 记录按 seq 排序（日志顺序即对话顺序）；只取真正由人发出的 `user/message`
 * （`source.kind === 'user'`，"审批策略变更"这类系统注入不要）与 `assistant/message`。
 * 上限 `maxBytes`（默认 4MB）防超大日志把主进程内存吃爆 —— 截断处之后的轮次就看不见了，
 * 但对"回看对话"这个用途，丢最尾巴的几轮远好于进程崩掉。
 */
export function readDshSessionTranscript(sessionId: string, maxBytes = 4 * 1024 * 1024): DshTranscriptEntry[] {
  const file = findDshSessionFile(sessionId)
  if (!file) return []
  let fd: number | null = null
  try {
    const size = statSync(file).size
    const length = Math.min(size, maxBytes)
    if (length <= 0) return []
    const buffer = Buffer.allocUnsafe(length)
    fd = openSync(file, 'r')
    const read = readSync(fd, buffer, 0, length, 0)
    return pickDshTranscript(decodeZstdFrames(buffer.subarray(0, read)))
  } catch {
    return []
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

/** 文本块 → 纯文本（content 数组里挑 text，其余类型丢弃）。 */
function textOf(parts: unknown): string {
  const list = Array.isArray(parts) ? (parts as { type?: string; text?: string }[]) : []
  return list
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => String(part.text))
    .join('\n')
    .trim()
}

/** 从 JSONL 文本里还原对话（纯函数，可单测）。 */
export function pickDshTranscript(jsonl: string): DshTranscriptEntry[] {
  const records: { seq: number; at: number; entry: DshTranscriptEntry }[] = []
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
    const at = Number(record.time ?? 0)
    if (type === 'user/message') {
      const data = (record.data ?? {}) as Record<string, unknown>
      const source = (data.source ?? {}) as { kind?: unknown }
      if (String(source.kind ?? '') !== 'user') continue
      const text = textOf(data.content)
      if (text.length === 0) continue
      records.push({ seq: Number(record.seq ?? 0), at, entry: { role: 'user', text, thinking: '', at } })
      continue
    }
    if (type === 'assistant/message') {
      const data = (record.data ?? {}) as Record<string, unknown>
      const message = (data.message ?? {}) as Record<string, unknown>
      const parts = Array.isArray(message.content) ? (message.content as { type?: string; text?: string }[]) : []
      const text = textOf(parts)
      const thinking = parts
        .filter((part) => part?.type === 'reasoning' && typeof part.text === 'string')
        .map((part) => String(part.text))
        .join('\n')
        .trim()
      if (text.length === 0 && thinking.length === 0) continue
      records.push({ seq: Number(record.seq ?? 0), at, entry: { role: 'assistant', text, thinking, at } })
    }
  }
  // seq 可能重复（多帧拼接），退回"数组顺序"作为次序；只在不破坏时间序的前提下排
  records.sort((a, b) => (a.at !== b.at ? a.at - b.at : a.seq - b.seq))
  return records.map((record) => record.entry)
}
