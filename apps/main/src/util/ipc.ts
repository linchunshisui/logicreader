/** IPC 注册与参数校验的小工具，保证主进程不信任任何渲染进程输入。 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { CH } from '@logicreader/shared'
import type { LogEntry } from '@logicreader/shared'

type Handler<TArgs extends unknown[], TResult> = (event: IpcMainInvokeEvent, ...args: TArgs) => TResult | Promise<TResult>

const registered = new Set<string>()

export function handle<TArgs extends unknown[], TResult>(channel: string, handler: Handler<TArgs, TResult>): void {
  if (registered.has(channel)) {
    throw new Error('IPC 通道重复注册：' + channel)
  }
  registered.add(channel)
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...(args as TArgs))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logMain('error', 'ipc', '通道 ' + channel + ' 执行失败：' + message)
      throw new Error(message)
    }
  })
}

export function assertString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(name + ' 必须是字符串')
  return value
}

export function assertNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) throw new TypeError(name + ' 必须是数字')
  return value
}

export function assertObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(name + ' 必须是对象')
  }
  return value as Record<string, unknown>
}

export function assertArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(name + ' 必须是数组')
  return value
}

export function assertPath(value: unknown, name = 'path'): string {
  const p = assertString(value, name)
  if (p.includes('\0')) throw new TypeError(name + ' 含非法字符')
  return p
}

// -------------------------------------------------------------- 日志转发
let logForwarder: ((entry: LogEntry) => void) | null = null

export function setLogForwarder(fn: (entry: LogEntry) => void): void {
  logForwarder = fn
}

export function logMain(level: LogEntry['level'], scope: string, message: string, detail?: string): void {
  const entry: LogEntry = {
    id: 'log_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    at: Date.now(),
    level,
    scope,
    message,
    detail
  }
  const line = '[' + new Date(entry.at).toISOString() + '] [' + level.toUpperCase() + '] [' + scope + '] ' + message + (detail ? ' :: ' + detail : '')
  try {
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  } catch {
    // 控制台管道断开（EPIPE）不应影响主流程
  }
  try {
    logForwarder?.(entry)
  } catch {
    /* 忽略转发失败 */
  }
}

/** 向所有窗口广播事件。 */
export function broadcast(channel: string, payload?: unknown): void {
  const { BrowserWindow } = requireElectron()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function requireElectron(): typeof import('electron') {
  // 延迟 require，避免在非 Electron 环境（单测）下导入失败
  return require('electron') as typeof import('electron')
}

export const IPC_CH = CH
