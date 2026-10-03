/**
 * 会话快照服务 —— 规划书 §5.9。
 * 三层持久化中的"会话快照"层：只存界面与位置，覆盖式，保留一份备份。
 */
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import {
  SESSION_SNAPSHOT_VERSION,
  deepMerge,
  type SessionSnapshot,
  type SnapshotReason
} from '@logicreader/shared'
import { paths } from '../util/paths'
import { logMain } from '../util/ipc'
import { writeFileAtomic } from './settings.service'

export interface RestoreReport {
  snapshot: SessionSnapshot
  recoveredFromBackup: boolean
  crashed: boolean
}

export class SessionService {
  private snapshot: SessionSnapshot | null = null
  /** 上次运行是否异常结束（由锁文件判断，比 reason 更可靠） */
  private abnormalExit = false
  private dirty = false
  private timer: NodeJS.Timeout | null = null
  private debounceMs = 15000
  private lastWriteMs = 0
  /** 本次启动读取到的上一次退出原因 */
  private previousReason: SnapshotReason | null = null
  /** 启动时读取的报告，供渲染进程查询（避免二次读盘把状态读丢） */
  private startupReport: RestoreReport | null = null

  setDebounce(ms: number): void {
    this.debounceMs = Math.max(1000, ms)
  }

  /** 读取快照：session.json → session.bak.json → null。 */
  load(): RestoreReport | null {
    // 锁文件存在说明上次没有干净退出（§5.9.3 崩溃恢复）
    try {
      this.abnormalExit = existsSync(paths.sessionLock())
      if (this.abnormalExit) {
        logMain('warn', 'session', '检测到会话锁文件，判定上次为异常退出')
      }
      writeFileSync(paths.sessionLock(), String(process.pid) + '@' + Date.now())
    } catch (error) {
      logMain('warn', 'session', '会话锁文件写入失败', String(error))
    }
    const primary = this.readFile(paths.session())
    if (primary) {
      this.snapshot = primary
      this.previousReason = primary.reason
      this.startupReport = {
        snapshot: primary,
        recoveredFromBackup: false,
        crashed: this.abnormalExit || primary.reason === 'crash'
      }
      return this.startupReport
    }
    const backup = this.readFile(paths.sessionBackup())
    if (backup) {
      this.snapshot = backup
      this.previousReason = backup.reason
      logMain('warn', 'session', '主快照不可用，已回退到备份快照')
      this.startupReport = { snapshot: backup, recoveredFromBackup: true, crashed: this.abnormalExit || backup.reason === 'crash' }
      return this.startupReport
    }
    this.startupReport = null
    return null
  }

  /** 启动时读取到的报告（渲染进程通过 IPC 获取，不再二次读盘）。 */
  report(): RestoreReport | null {
    return this.startupReport
  }

  private readFile(file: string): SessionSnapshot | null {
    try {
      if (!existsSync(file)) return null
      let raw = readFileSync(file, 'utf8')
      // 容忍外部编辑器写入的 BOM
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
      const parsed = JSON.parse(raw) as SessionSnapshot
      if (typeof parsed.version !== 'number') throw new Error('缺少 version')
      if (parsed.version !== SESSION_SNAPSHOT_VERSION) {
        // 版本不兼容：保留旧快照副本便于排查，然后丢弃（只丢界面，不丢内容）
        try {
          copyFileSync(file, paths.sessionVersioned(parsed.version))
        } catch {
          /* 忽略 */
        }
        logMain('warn', 'session', '快照版本不兼容，已丢弃：v' + parsed.version)
        return null
      }
      if (!Array.isArray(parsed.windows)) throw new Error('windows 字段非法')
      return parsed
    } catch (error) {
      logMain('warn', 'session', '快照解析失败：' + file, String(error))
      return null
    }
  }

  current(): SessionSnapshot | null {
    return this.snapshot
  }

  previousExitReason(): SnapshotReason | null {
    return this.previousReason
  }

  /** 增量合并保存（防抖）。windows 数组按下标逐项合并，避免渲染进程只上报 layout 时冲掉窗口几何。 */
  save(patch: unknown, immediate = false): void {
    const base: SessionSnapshot =
      this.snapshot ?? {
        version: SESSION_SNAPSHOT_VERSION,
        savedAt: Date.now(),
        reason: 'interval',
        app: { theme: 'system', locale: 'system', readerThemeOverride: 'inherit' },
        windows: []
      }
    const merged = deepMerge(base, patch) as SessionSnapshot
    const patchWindows = (patch as { windows?: unknown })?.windows
    if (Array.isArray(patchWindows) && Array.isArray(base.windows)) {
      merged.windows = base.windows.map((win, index) => {
        const incoming = patchWindows[index]
        return incoming === undefined ? win : (deepMerge(win, incoming) as typeof win)
      })
      for (let i = base.windows.length; i < patchWindows.length; i += 1) {
        merged.windows.push(patchWindows[i] as (typeof base.windows)[number])
      }
    }
    this.snapshot = merged
    this.dirty = true
    if (immediate) {
      this.write('key-action')
      return
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.write('interval')
    }, this.debounceMs)
  }

  /** 退出前同步落盘，并清除锁文件（干净退出标记）。 */
  flush(reason: SnapshotReason = 'quit'): boolean {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const ok = this.write(reason)
    if (reason === 'quit') {
      try {
        if (existsSync(paths.sessionLock())) unlinkSync(paths.sessionLock())
        this.abnormalExit = false
      } catch {
        /* 忽略 */
      }
    }
    return ok
  }

  private write(reason: SnapshotReason): boolean {
    if (!this.snapshot) return false
    const start = Date.now()
    try {
      const payload: SessionSnapshot = { ...this.snapshot, version: SESSION_SNAPSHOT_VERSION, savedAt: Date.now(), reason }
      if (existsSync(paths.session())) {
        try {
          copyFileSync(paths.session(), paths.sessionBackup())
        } catch {
          /* 备份失败不阻塞主流程 */
        }
      }
      writeFileAtomic(paths.session(), JSON.stringify(payload, null, 2))
      this.dirty = false
      this.lastWriteMs = Date.now() - start
      return true
    } catch (error) {
      logMain('error', 'session', '快照写入失败', String(error))
      return false
    }
  }

  clear(): void {
    this.snapshot = null
    for (const file of [paths.session(), paths.sessionBackup()]) {
      try {
        if (existsSync(file)) unlinkSync(file)
      } catch {
        /* 忽略 */
      }
    }
  }

  metrics(): { lastWriteMs: number; dirty: boolean } {
    return { lastWriteMs: this.lastWriteMs, dirty: this.dirty }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

export const sessionService = new SessionService()
