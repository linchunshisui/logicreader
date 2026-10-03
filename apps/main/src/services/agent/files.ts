/**
 * 工作区文件索引 —— 给界面上的 "@ 文件引用" 用（VS Code 扩展里叫 @-mention）。
 *
 * 为什么放在主进程：
 *  1. 只有主进程能自由遍历磁盘；
 *  2. 要遵守用户自己的 Claude Code 设置里的 \`respectGitIgnore\`（本机是 true）——
 *     用户不希望 node_modules / 构建产物出现在候选里；
 *  3. 结果**内存缓存**（按目录 + TTL），因为输入 @ 的每一次按键都会查。
 *
 * 只做"列文件名"，不读内容：真正读文件是 Agent 的 Read 工具的事（它有权限与行号语义）。
 */
import { readdir, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { logMain } from '../../util/ipc'

/** 永远跳过的目录（无论 gitignore 怎么配）：这些进候选列表只会淹没真正有用的文件。 */
const ALWAYS_SKIP = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'out',
  'build',
  'release',
  'release-staging',
  '.next',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.tmp-build'
])

export interface WorkspaceFileEntry {
  /** 相对工作目录的路径（用 / 分隔，跨平台一致） */
  path: string
  /** 文件名（界面显示用） */
  name: string
  /** 所在子目录（显示用，空串表示根目录） */
  dir: string
  size: number
  modified: number
}

interface CacheEntry {
  dir: string
  at: number
  files: WorkspaceFileEntry[]
}

const TTL_MS = 30_000
const MAX_FILES = 4000
const MAX_DEPTH = 8

let cache: CacheEntry | null = null

/** 读用户 Claude Code 设置里的 respectGitIgnore（读不到就按 true 处理，与扩展默认一致）。 */
export function respectGitIgnore(): boolean {
  try {
    const home = process.env.USERPROFILE ?? process.env.HOME
    if (!home) return true
    const path = join(home, '.claude', 'settings.json')
    if (!existsSync(path)) return true
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { respectGitIgnore?: boolean }
    return parsed.respectGitIgnore !== false
  } catch {
    return true
  }
}

function matchesGitIgnore(dir: string): string[] {
  // 极简 gitignore：只取顶层 .gitignore 的一级模式（够用且不会误伤）
  try {
    const path = join(dir, '.gitignore')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('!'))
      .map((line) => line.replace(/^\//, '').replace(/\/$/, '').replace(/\*\*/g, '').replace(/\*/g, ''))
      .filter((line) => line.length > 1 && !line.includes('/'))
  } catch {
    return []
  }
}

/** 遍历工作目录收集文件（有上限，避免大仓库把界面拖死）。 */
export async function listWorkspaceFiles(dir: string, force = false): Promise<WorkspaceFileEntry[]> {
  if (!force && cache && cache.dir === dir && Date.now() - cache.at < TTL_MS) return cache.files
  const files: WorkspaceFileEntry[] = []
  const ignored = respectGitIgnore() ? matchesGitIgnore(dir) : []
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return
    let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      const name = entry.name
      if (name.startsWith('.')) continue
      if (ALWAYS_SKIP.has(name)) continue
      if (ignored.some((pattern) => name === pattern || name.startsWith(pattern.replace(/\/$/, '')))) continue
      const full = join(current, name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const info = await stat(full)
        // 超大文件不进候选（引用它没有意义，Agent 也读不动）
        if (info.size > 2 * 1024 * 1024) continue
        const rel = relative(dir, full).split(sep).join('/')
        files.push({
          path: rel,
          name,
          dir: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
          size: info.size,
          modified: info.mtimeMs
        })
      } catch {
        /* 单个文件失败不影响整体 */
      }
    }
  }
  const started = Date.now()
  await walk(dir, 0)
  cache = { dir, at: Date.now(), files }
  logMain('debug', 'agent', '工作区文件索引：' + files.length + ' 个（' + (Date.now() - started) + 'ms，目录=' + dir + '）')
  return files
}

/** 前缀/片段匹配（大小写不敏感，路径优先、文件名其次），返回前 limit 条。 */
export function searchWorkspaceFiles(files: WorkspaceFileEntry[], query: string, limit = 12): WorkspaceFileEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) {
    return files.slice().sort((a, b) => b.modified - a.modified).slice(0, limit)
  }
  const scored: { file: WorkspaceFileEntry; score: number }[] = []
  for (const file of files) {
    const path = file.path.toLowerCase()
    const name = file.name.toLowerCase()
    let score = -1
    if (name === needle) score = 0
    else if (name.startsWith(needle)) score = 1
    else if (path.startsWith(needle)) score = 2
    else if (name.includes(needle)) score = 3
    else if (path.includes(needle)) score = 4
    if (score >= 0) scored.push({ file, score })
  }
  return scored
    .sort((a, b) => (a.score === b.score ? b.file.modified - a.file.modified : a.score - b.score))
    .slice(0, limit)
    .map((item) => item.file)
}
