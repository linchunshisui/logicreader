/**
 * Windows 子进程启动的全套处理 —— 规划书 §5.4「Windows 进程启动的坑」。
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { delimiter, dirname, join, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { logMain } from '../../util/ipc'

const execFileAsync = promisify(execFile)

/** 打包后 App 的 PATH 往往缺少用户级安装目录，这里补齐。 */
export function augmentedPath(): string {
  const home = homedir()
  const extra = [
    join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm'),
    join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'pnpm'),
    join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Yarn', 'bin'),
    join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Volta', 'bin'),
    join(process.env.APPDATA ?? '', 'Volta', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.nvm', 'current', 'bin'),
    process.env.NVM_SYMLINK ?? '',
    process.env.FNM_MULTISHELL_PATH ?? '',
    process.env.PNPM_HOME ?? ''
  ].filter((value) => value && existsSync(value))
  const current = process.env.PATH ?? ''
  const parts = current.split(delimiter).filter(Boolean)
  for (const dir of extra) if (!parts.includes(dir)) parts.push(dir)
  return parts.join(delimiter)
}

export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: augmentedPath(),
    // 强制 UTF-8，避免中文乱码
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'en_US.UTF-8',
    PYTHONIOENCODING: 'utf-8',
    ...extra
  }
}

export interface ResolvedExecutable {
  /** 实际要启动的可执行文件 */
  command: string
  /** 前置参数（.cmd shim 转换后为脚本路径） */
  prefixArgs: string[]
  /** 命中的原始路径 */
  source: string | null
  error: string | null
}

/**
 * 解析 Agent 可执行文件：
 * 用户配置路径 → where.exe 查询 → .cmd shim 解析为 node <script> → 常见安装目录。
 * 优先使用 node <script> 形式启动，绕开 shell 与黑框。
 */
export async function resolveAgentExecutable(name: string, configured?: string | null): Promise<ResolvedExecutable> {
  const candidates: string[] = []
  const trimmed = configured?.trim() ?? ''
  // 只有在配置项"看起来是路径"时才优先按路径解析；裸命令名继续走 PATH 查询
  const looksLikePath = trimmed.length > 0 && (trimmed.includes('/') || trimmed.includes('\\') || /[.](exe|cmd|bat|ps1)$/i.test(trimmed))
  if (looksLikePath) {
    candidates.push(trimmed)
    if (!isAbsolute(trimmed)) candidates.push(resolve(trimmed))
  }

  {
    for (const probe of [name, name + '.cmd', name + '.exe']) {
      try {
        const { stdout } = await execFileAsync('where.exe', [probe], {
          windowsHide: true,
          env: childEnv(),
          timeout: 8000
        })
        for (const line of stdout.split(/\r?\n/)) {
          const trimmed = line.trim()
          if (trimmed.length > 0) candidates.push(trimmed)
        }
      } catch {
        /* 未找到 */
      }
    }
    const home = homedir()
    const dirs = [
      join(home, '.local', 'bin'),
      join(process.env.APPDATA ?? '', 'npm'),
      join(process.env.LOCALAPPDATA ?? '', 'pnpm'),
      join(home, 'AppData', 'Roaming', 'npm'),
      join(home, '.bun', 'bin'),
      join(home, '.volta', 'bin'),
      '/usr/local/bin',
      '/opt/homebrew/bin'
    ]
    for (const dir of dirs) {
      if (!dir || !existsSync(dir)) continue
      for (const ext of ['', '.exe', '.cmd', '.ps1']) {
        const candidate = join(dir, name + ext)
        if (existsSync(candidate)) candidates.push(candidate)
      }
    }
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const lower = candidate.toLowerCase()
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      const shim = parseCmdShim(candidate)
      if (shim) {
        return { command: shim.node, prefixArgs: [shim.script], source: candidate, error: null }
      }
      return { command: process.env.COMSPEC ?? 'cmd.exe', prefixArgs: ['/d', '/s', '/c', candidate], source: candidate, error: null }
    }
    if (lower.endsWith('.ps1')) {
      return {
        command: 'powershell.exe',
        prefixArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', candidate],
        source: candidate,
        error: null
      }
    }
    return { command: candidate, prefixArgs: [], source: candidate, error: null }
  }

  return {
    command: '',
    prefixArgs: [],
    source: null,
    error: '未找到可执行文件：' + name + '（可在 Agent 管理器中手动指定路径）'
  }
}

/**
 * 解析 npm 生成的 .cmd shim，取出 node 与真实脚本路径。
 * shim 内一般形如："%_prog%" "%dp0%\node_modules\<pkg>\bin\<cli>.js" %*
 */
function parseCmdShim(file: string): { node: string; script: string } | null {
  try {
    const content = readFileSync(file, 'utf8')
    const patterns = [/"%~dp0\\?([^"]+[.](?:js|mjs|cjs))"/i, /"%dp0%\\?([^"]+[.](?:js|mjs|cjs))"/i]
    let relative: string | null = null
    for (const pattern of patterns) {
      const match = pattern.exec(content)
      if (match) {
        relative = match[1]
        break
      }
    }
    if (!relative) return null
    const script = join(dirname(file), relative.split('/').join('\\'))
    if (!existsSync(script)) return null
    const nodeCandidates = [
      process.env.NODE_EXE,
      process.execPath,
      'C:\\Program Files\\nodejs\\node.exe',
      join(dirname(process.execPath), 'node.exe')
    ].filter((value): value is string => Boolean(value))
    for (const node of nodeCandidates) {
      if (node.toLowerCase().includes('electron')) continue
      if (existsSync(node)) return { node, script }
    }
    return { node: 'node', script }
  } catch {
    return null
  }
}

export interface SpawnOptions {
  cwd: string
  env?: Record<string, string>
  /** 超时后强制结束 */
  timeoutMs?: number
}

export function spawnAgent(command: string, args: string[], options: SpawnOptions): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: childEnv(options.env),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false
  })
  if (options.timeoutMs && options.timeoutMs > 0) {
    setTimeout(() => {
      if (child.exitCode === null) killTree(child)
    }, options.timeoutMs)
  }
  return child
}

/** 按进程树结束子进程，避免残留。 */
export function killTree(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null || !child.pid) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, 3000)
    }
  } catch (error) {
    logMain('warn', 'agent', '结束子进程失败', String(error))
  }
}

/** 读取版本号（统一 8s 超时）。 */
export async function readVersion(command: string, args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 8000, windowsHide: true, cwd, env: childEnv() })
    return stdout.trim().split(/\r?\n/)[0] ?? null
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout
    if (stdout) return stdout.trim().split(/\r?\n/)[0] ?? null
    return null
  }
}

export function listDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
