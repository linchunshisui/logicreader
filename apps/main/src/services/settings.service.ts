/** 设置与密钥：非敏感设置存 settings.json，敏感值经 safeStorage 加密存 secrets.bin。 */
import { safeStorage } from 'electron'
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { DEFAULT_SETTINGS, deepMerge, type AppSettings } from '@logicreader/shared'
import { paths } from '../util/paths'
import { logMain } from '../util/ipc'

type Listener = (settings: AppSettings) => void

export class SettingsService {
  private current: AppSettings = { ...DEFAULT_SETTINGS }
  private secrets: Record<string, string> = {}
  private listeners = new Set<Listener>()
  private saveTimer: NodeJS.Timeout | null = null

  load(): AppSettings {
    try {
      const raw = readFileSync(paths.settings(), 'utf8')
      this.current = deepMerge({ ...DEFAULT_SETTINGS }, JSON.parse(raw))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logMain('warn', 'settings', '设置文件读取失败，使用默认值', String(error))
      }
      this.current = { ...DEFAULT_SETTINGS }
    }
    this.loadSecrets()
    return this.current
  }

  all(): AppSettings {
    return this.current
  }

  patch(patch: unknown): AppSettings {
    this.current = deepMerge(this.current, patch)
    this.scheduleSave()
    for (const fn of this.listeners) fn(this.current)
    return this.current
  }

  reset(): AppSettings {
    this.current = { ...DEFAULT_SETTINGS }
    this.scheduleSave()
    for (const fn of this.listeners) fn(this.current)
    return this.current
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  // ------------------------------------------------------------- 密钥
  private loadSecrets(): void {
    try {
      const raw = readFileSync(paths.secrets(), 'utf8')
      const payload = JSON.parse(raw) as Record<string, string>
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(payload)) {
        try {
          out[k] = this.decrypt(v)
        } catch {
          logMain('warn', 'settings', '密钥解密失败，已跳过：' + k)
        }
      }
      this.secrets = out
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logMain('warn', 'settings', '密钥文件读取失败', String(error))
      }
      this.secrets = {}
    }
  }

  private encrypt(plain: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      return 'v1:' + safeStorage.encryptString(plain).toString('base64')
    }
    // 系统不支持加密时的降级：仅做 Base64，避免明文可读（安全提示在 UI 中给出）
    return 'plain:' + Buffer.from(plain, 'utf8').toString('base64')
  }

  private decrypt(stored: string): string {
    if (stored.startsWith('v1:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(3), 'base64'))
    }
    if (stored.startsWith('plain:')) {
      return Buffer.from(stored.slice(6), 'base64').toString('utf8')
    }
    return ''
  }

  setSecret(key: string, value: string): void {
    this.secrets[key] = value
    this.saveSecrets()
  }

  hasSecret(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.secrets, key) && this.secrets[key].length > 0
  }

  getSecret(key: string): string | null {
    return this.secrets[key] ?? null
  }

  deleteSecret(key: string): void {
    delete this.secrets[key]
    this.saveSecrets()
  }

  private saveSecrets(): void {
    const payload: Record<string, string> = {}
    for (const [k, v] of Object.entries(this.secrets)) payload[k] = this.encrypt(v)
    writeFileAtomic(paths.secrets(), JSON.stringify(payload))
  }

  /** 输出给日志前必须经过此函数，避免密钥泄漏。 */
  redact(text: string): string {
    let out = text
    for (const value of Object.values(this.secrets)) {
      if (value.length >= 8) out = out.split(value).join('***')
    }
    out = out.replace(/(sk-[A-Za-z0-9_-]{8,})/g, '***')
    out = out.replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***')
    return out
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.saveNow()
    }, 400)
  }

  saveNow(): void {
    try {
      writeFileAtomic(paths.settings(), JSON.stringify(this.current, null, 2))
    } catch (error) {
      logMain('error', 'settings', '设置写入失败', String(error))
    }
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.saveNow()
  }
}

/** 原子写：先写临时文件 → fsync → 重命名替换。 */
export function writeFileAtomic(target: string, content: string): void {
  const tmp = target + '.tmp'
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, target)
}

export const settingsService = new SettingsService()
