import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

function userData(): string {
  return app.getPath('userData')
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

export const paths = {
  userData,
  db: (): string => join(userData(), 'logicreader.db'),
  settings: (): string => join(userData(), 'settings.json'),
  secrets: (): string => join(userData(), 'secrets.bin'),
  session: (): string => join(userData(), 'session.json'),
  sessionBackup: (): string => join(userData(), 'session.bak.json'),
  sessionTmp: (): string => join(userData(), 'session.json.tmp'),
  sessionLock: (): string => join(userData(), 'session.lock'),
  sessionVersioned: (version: number): string => join(userData(), 'session.v' + version + '.json'),
  cache: (kind?: string): string => ensureDir(kind ? join(userData(), 'cache', kind) : join(userData(), 'cache')),
  exports: (): string => ensureDir(join(userData(), 'exports')),
  recentFile: (): string => join(userData(), 'recent.json'),
  agentWorkspace: (): string => ensureDir(join(userData(), 'agent-workspace')),
  logs: (): string => ensureDir(join(userData(), 'logs')),
  logFile: (): string => join(paths.logs(), 'main.log'),
  /**
   * GPU 降级标记。渲染进程反复启动失败时写下它，
   * 下次启动会在 app ready **之前** 关闭硬件加速 ——
   * 这是唯一能在"GPU 进程完全起不来"的机器上把应用拉起来的时机窗口。
   */
  gpuFallback: (): string => join(userData(), 'render-fallback.json')
}

export const cacheDirs = {
  libreOffice: (): string => paths.cache('lo'),
  graph: (): string => paths.cache('graph'),
  page: (): string => paths.cache('page')
}