/** 日志服务：内存环形缓冲 + 文件追加 + 渲染进程订阅。 */
import { app } from 'electron'
import { appendFileSync } from 'node:fs'
import type { LogEntry } from '@logicreader/shared'
import { paths } from '../util/paths'
import { setLogForwarder } from '../util/ipc'

const MAX_ENTRIES = 2000

/**
 * 构建时间戳。由 electron.vite.config.ts 的 `buildStamp()` 在构建时注入到主进程
 * （与渲染进程状态栏用的是同一个值，所以两边对得上）。
 */
declare const __LR_BUILD__: string
const MAIN_BUILD_STAMP = typeof __LR_BUILD__ === 'string' ? __LR_BUILD__ : '未知'

class LogService {
  private entries: LogEntry[] = []
  private listeners = new Set<(e: LogEntry) => void>()
  private fileEnabled = true
  /** 连续落盘失败次数（瞬时失败不该永久关掉文件日志，见 push() 的注释） */
  private fileFailures = 0

  init(): void {
    setLogForwarder((entry) => this.push(entry))
    /**
     * 启动第一行必须能回答"现在跑的是哪次构建"。
     * 排查"改完代码没生效"时，最先要排除的就是"跑的是旧产物"——
     * 之前只能靠日志格式的差异去猜，太绕；现在直接写构建时间戳。
     */
    this.push({
      id: 'log_boot',
      at: Date.now(),
      level: 'info',
      scope: 'app',
      message: 'LogicReader 主进程启动',
      detail: '构建=' + MAIN_BUILD_STAMP + ' · 版本=' + app.getVersion() + ' · Electron=' + process.versions.electron
    })
  }

  push(entry: LogEntry): void {
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    if (this.fileEnabled) {
      try {
        appendFileSync(paths.logFile(), '[' + new Date(entry.at).toISOString() + '] [' + entry.level + '] [' + entry.scope + '] ' + entry.message + (entry.detail ? ' :: ' + entry.detail : '') + '\n')
        this.fileFailures = 0
      } catch {
        /**
         * **单次写入失败不能永久关掉文件日志**。
         *
         * 外部读锁（有人正用编辑器 / 命令行打开日志，Windows 上会挡住 append）、杀软扫描、
         * 句柄瞬时占用都会让它失败一两次 —— 早先的实现一失败就把 `fileEnabled` 置 false 并静默到底，
         * 结果第三十五轮出现"关系图明明在跑、日志却停在几分钟前"，等于把排查的眼睛挖掉了。
         * 现在只在**连续大量失败**（真写不进去：磁盘满 / 无权限）时才停，避免每次日志都抛异常。
         */
        this.fileFailures += 1
        if (this.fileFailures >= 100) this.fileEnabled = false
      }
    }
    for (const fn of this.listeners) fn(entry)
  }

  read(limit = 500): LogEntry[] {
    return this.entries.slice(-limit)
  }

  clear(): void {
    this.entries = []
  }

  onEntry(fn: (e: LogEntry) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

export const logService = new LogService()
