/**
 * LibreOffice sidecar 调用与缓存 —— 规划书 §5.2 / §4.3。
 * 未安装 LibreOffice 时返回明确的不可用原因，界面据此给出引导页（渐进增强）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { cacheDirs, paths } from '../util/paths'
import { logMain } from '../util/ipc'
import { settingsService } from './settings.service'

export interface ConvertAvailability {
  available: boolean
  path: string | null
  version: string | null
  reason: string | null
}

const CANDIDATE_PATHS = [
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files\\LibreOffice\\program\\soffice.com',
  '/usr/bin/soffice',
  '/usr/local/bin/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice'
]

class ConvertService {
  private availability: ConvertAvailability | null = null
  /** 同一 UserInstallation 不能并发，串行队列 */
  private queue: Promise<unknown> = Promise.resolve()

  async probe(force = false): Promise<ConvertAvailability> {
    if (this.availability && !force) return this.availability
    const configured = settingsService.all().libreOfficePath
    const candidates = configured ? [configured, ...CANDIDATE_PATHS] : CANDIDATE_PATHS
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) {
        const version = await this.readVersion(candidate)
        this.availability = { available: true, path: candidate, version, reason: null }
        return this.availability
      }
    }
    this.availability = {
      available: false,
      path: null,
      version: null,
      reason: configured ? '指定的 LibreOffice 路径不存在' : '未在本机找到 LibreOffice'
    }
    return this.availability
  }

  invalidate(): void {
    this.availability = null
  }

  private readVersion(exe: string): Promise<string | null> {
    return new Promise((resolve) => {
      const child = spawn(exe, ['--version'], { windowsHide: true })
      let out = ''
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString('utf8')
      })
      child.on('error', () => resolve(null))
      child.on('close', () => resolve(out.trim().split('\n')[0] ?? null))
      setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* 忽略 */
        }
        resolve(null)
      }, 8000)
    })
  }

  /** 转 PDF，带内容哈希缓存。 */
  async toPdf(inputPath: string, hash: string, timeoutMs = 60000): Promise<string> {
    const availability = await this.probe()
    if (!availability.available || !availability.path) {
      throw new Error(availability.reason ?? 'LibreOffice 不可用')
    }
    const outFile = join(cacheDirs.libreOffice(), hash + '.pdf')
    if (existsSync(outFile)) return outFile
    const exePath = availability.path
    return this.enqueue(async () => {
      if (existsSync(outFile)) return outFile
      const profileDir = paths.cache('lo-profile')
      await fsp.mkdir(profileDir, { recursive: true })
      const args = [
        '--headless', '--norestore', '--invisible', '--nolockcheck', '--nodefault',
        '-env:UserInstallation=file:///' + profileDir.replace(/\\/g, '/'),
        '--convert-to', 'pdf', '--outdir', cacheDirs.libreOffice(), inputPath
      ]
      await this.run(exePath, args, timeoutMs)
      if (!existsSync(outFile)) {
        // LibreOffice 按输入文件名输出，改名为哈希名
        const produced = join(cacheDirs.libreOffice(), inputPath.replace(/\\/g, '/').split('/').pop()!.replace(/\.[^.]+$/, '') + '.pdf')
        if (existsSync(produced)) {
          await fsp.rename(produced, outFile)
        }
      }
      if (!existsSync(outFile)) throw new Error('转换完成但未找到输出文件')
      return outFile
    })
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job)
    this.queue = next.catch(() => undefined)
    return next as Promise<T>
  }

  private run(exe: string, args: string[], timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(exe, args, { windowsHide: true })
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* 忽略 */
        }
        reject(new Error('LibreOffice 转换超时（' + timeoutMs + 'ms）'))
      }, timeoutMs)
      let stderr = ''
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8')
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else {
          logMain('warn', 'convert', 'LibreOffice 退出码 ' + code, stderr.slice(0, 800))
          reject(new Error('LibreOffice 转换失败（退出码 ' + code + '）'))
        }
      })
    })
  }
}

export const convertService = new ConvertService();
