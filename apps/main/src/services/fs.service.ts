/** 文件服务：读写、哈希、监听、最近打开列表。 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { promises as fsp, watch, type FSWatcher } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { shell } from 'electron'
import { CH, type FileStat, type RecentEntry } from '@logicreader/shared'
import { paths } from '../util/paths'
import { broadcast, logMain } from '../util/ipc'
import { writeFileAtomic } from './settings.service'

export interface FsChangeEvent {
  path: string
  kind: 'change' | 'rename'
}

class FsService {
  private watchers = new Map<string, { watcher: FSWatcher; timer: NodeJS.Timeout | null; pending: FsChangeEvent['kind'] }>()
  private recentCache: RecentEntry[] = []
  private recentLimit = 30

  init(recentLimit: number): void {
    this.recentLimit = recentLimit
    this.loadRecent()
  }

  async stat(target: string): Promise<FileStat | null> {
    try {
      const s = await fsp.stat(target)
      return { path: target, size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() }
    } catch {
      return null
    }
  }

  async exists(target: string): Promise<boolean> {
    try {
      await fsp.access(target)
      return true
    } catch {
      return false
    }
  }

  async readBinary(target: string): Promise<Uint8Array> {
    const buf = await fsp.readFile(target)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  async readText(target: string): Promise<string> {
    const buf = await fsp.readFile(target)
    const text = buf.toString('utf8')
    // 去掉 BOM，保证偏移计算一致
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  }

  async writeText(target: string, text: string): Promise<void> {
    await fsp.mkdir(dirname(target), { recursive: true })
    writeFileAtomic(target, text)
  }

  async writeBinary(target: string, data: Uint8Array): Promise<void> {
    await fsp.mkdir(dirname(target), { recursive: true })
    await fsp.writeFile(target, data)
  }

  async hash(target: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256')
      const stream = createReadStream(target)
      stream.on('error', reject)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('end', () => resolve(hash.digest('hex')))
    })
  }

  async reveal(target: string): Promise<void> {
    shell.showItemInFolder(target)
  }

  async openPath(target: string): Promise<string> {
    return shell.openPath(target)
  }

  async readDir(target: string): Promise<{ name: string; path: string; isDirectory: boolean }[]> {
    const entries = await fsp.readdir(target, { withFileTypes: true })
    return entries
      .map((e) => ({ name: e.name, path: join(target, e.name), isDirectory: e.isDirectory() }))
      .sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1))
  }

  // ------------------------------------------------------------ 文件监听
  watch(target: string): void {
    if (this.watchers.has(target)) return
    try {
      const watcher = watch(target, { persistent: false }, (eventType) => {
        const entry = this.watchers.get(target)
        if (!entry) return
        entry.pending = eventType === 'rename' ? 'rename' : 'change'
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = setTimeout(() => {
          const kind = entry.pending
          broadcast(CH.fs.changed, { path: target, kind } satisfies FsChangeEvent)
        }, 350)
      })
      watcher.on('error', (error) => {
        logMain('warn', 'fs', '文件监听失败：' + target, String(error))
        this.unwatch(target)
      })
      this.watchers.set(target, { watcher, timer: null, pending: 'change' })
    } catch (error) {
      logMain('warn', 'fs', '无法监听文件：' + target, String(error))
    }
  }

  unwatch(target: string): void {
    const entry = this.watchers.get(target)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    try {
      entry.watcher.close()
    } catch {
      /* 忽略 */
    }
    this.watchers.delete(target)
  }

  unwatchAll(): void {
    for (const key of [...this.watchers.keys()]) this.unwatch(key)
  }

  // -------------------------------------------------------- 最近打开列表
  private loadRecent(): void {
    try {
      if (!existsSync(paths.recentFile())) {
        this.recentCache = []
        return
      }
      const parsed = JSON.parse(readFileSync(paths.recentFile(), 'utf8')) as RecentEntry[]
      this.recentCache = Array.isArray(parsed) ? parsed : []
    } catch {
      this.recentCache = []
    }
  }

  private saveRecent(): void {
    try {
      writeFileAtomic(paths.recentFile(), JSON.stringify(this.recentCache, null, 2))
    } catch (error) {
      logMain('warn', 'fs', '最近打开列表写入失败', String(error))
    }
  }

  recent(): RecentEntry[] {
    return this.recentCache
  }

  pushRecent(entry: Omit<RecentEntry, 'at'>): RecentEntry[] {
    const list = this.recentCache.filter((e) => e.path !== entry.path)
    list.unshift({ ...entry, at: Date.now() })
    this.recentCache = list.slice(0, this.recentLimit)
    this.saveRecent()
    return this.recentCache
  }

  removeRecent(target: string): RecentEntry[] {
    this.recentCache = this.recentCache.filter((e) => e.path !== target)
    this.saveRecent()
    return this.recentCache
  }

  titleFor(target: string): string {
    return basename(target)
  }
}

export const fsService = new FsService()
