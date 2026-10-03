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

/** 同步跑一小段系统命令（只在探测/解析路径时用，带超时，失败一律吞掉）。 */
function runSync(command: string, args: string[], timeout = 4000): string {
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    // stderr 丢掉：'reg query' 找不到键时的报错是**预期**的（用户没装/没登记），不该污染日志
    return execFileSync(command, args, {
      timeout,
      windowsHide: true,
      env: childEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout
    return typeof stdout === 'string' ? stdout : ''
  }
}

/** `reg query` 的输出行 → 值（`    Name    REG_SZ    Value`）。 */
function registryValue(output: string, name: string): string | null {
  const pattern = new RegExp('^\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+REG_[A-Z_]*(?:\\s+(.*))?$', 'im')
  const matched = pattern.exec(output)
  if (!matched) return null
  const value = (matched[1] ?? '').trim()
  return value.length > 0 ? value : null
}

/**
 * 附加搜索目录（Windows）。
 *
 * 为什么需要：**安装器改完 PATH，已经跑着的进程看不到** —— 我们在 Electron 里读到的
 * `process.env.PATH` 是启动那一刻的快照。用户刚装完 Agent / 刚在它自己的设置里打开命令行集成，
 * 本程序却一直说"找不到可执行文件"，根因就在这里。
 *
 * 于是这里补两处来源：① 注册表里的用户/机器 PATH；② 已知的"自带命令"目录。
 */
function extraSearchDirs(name: string): string[] {
  if (process.platform !== 'win32') return []
  const dirs: string[] = []

  const environmentPath = registryValue(runSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'Path']), 'Path')
  const machinePath = registryValue(
    runSync('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'Path']),
    'Path'
  )
  for (const raw of [environmentPath, machinePath]) {
    if (!raw) continue
    for (const part of raw.split(delimiter)) {
      const dir = process.env[part.trim()] ?? part.trim()
      if (dir.length > 0) dirs.push(dir)
    }
  }

  if (name.toLowerCase() === 'dsh') dirs.push(...deepSeekHarnessCommandDirs())
  return dirs
}

/**
 * DeepSeek Harness **桌面端自带的 `dsh` 命令**所在目录。
 *
 * 桌面端（Windows 安装版）会把命令放在 `<安装目录>\resources\runtime\cli\bin\dsh.cmd`，
 * 并可以让用户把它加进 PATH（那时它会往 `HKCU\Software\DeepSeekHarness\Command` 写 Directory）。
 * 没加 PATH 的用户也应该能直接用 —— 所以按三个来源找：它自己的登记项 → 卸载表里的安装位置
 * → 默认的按用户安装位置。
 */
function deepSeekHarnessCommandDirs(): string[] {
  const dirs: string[] = []
  const suffix = join('resources', 'runtime', 'cli', 'bin')

  const owned = registryValue(runSync('reg.exe', ['query', 'HKCU\\Software\\DeepSeekHarness\\Command', '/v', 'Directory']), 'Directory')
  if (owned) dirs.push(owned)

  const uninstall = runSync('reg.exe', [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    '/s',
    '/f',
    'DeepSeek Harness',
    '/d'
  ])
  for (const line of uninstall.split(/\r?\n/)) {
    const matched = /^\s*InstallLocation\s+REG_[A-Z_]*\s+(.+)$/i.exec(line)
    if (matched) dirs.push(join(matched[1].trim(), suffix))
  }

  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  dirs.push(join(localAppData, 'Programs', 'DeepSeek Harness', suffix))
  return dirs
}

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
  /**
   * 启动这个命令必须带的环境变量（shim 里写死的那些）。
   * 例：DeepSeek Harness 桌面端自带的 `dsh.cmd` 用 `ELECTRON_RUN_AS_NODE=1` 让 Electron 当 Node 跑它的 cli.js。
   */
  env: Record<string, string>
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
    // 注册表 PATH + 自带命令目录（PATH 快照过时 / dsh 桌面端这类没进 PATH 的情况）
    for (const dir of extraSearchDirs(name)) {
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
        return { command: shim.command, prefixArgs: shim.prefixArgs, env: shim.env, source: candidate, error: null }
      }
      // 认不出来的 shim：交给 cmd.exe 执行（引号见 cmdExpression 的说明）
      return {
        command: process.env.COMSPEC ?? 'cmd.exe',
        prefixArgs: ['/d', '/s', '/c', candidate],
        env: {},
        source: candidate,
        error: null
      }
    }
    if (lower.endsWith('.ps1')) {
      return {
        command: 'powershell.exe',
        prefixArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', candidate],
        env: {},
        source: candidate,
        error: null
      }
    }
    return { command: candidate, prefixArgs: [], env: {}, source: candidate, error: null }
  }

  return {
    command: '',
    prefixArgs: [],
    env: {},
    source: null,
    error: '未找到可执行文件：' + name + '（可在 Agent 管理器中手动指定路径）'
  }
}

/**
 * 解析 .cmd shim，取出"真正要启动什么"。
 *
 * 两种形态：
 *  1. **npm 生成的 shim**：`"%_prog%" "%dp0%\node_modules\<pkg>\bin\<cli>.js" %*`
 *     → 用 node 跑脚本（顺带避开黑框与 shell 解析）。
 *  2. **Electron 应用自带的命令**（本例：DeepSeek Harness 桌面端 `resources\runtime\cli\bin\dsh.cmd`）：
 *     ```bat
 *     set "ELECTRON_RUN_AS_NODE=1"
 *     "%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
 *     ```
 *     这种 shim **不能**当成 `node <script>` 跑：脚本在 `app.asar` 里，普通 node 读不到，
 *     必须用那个 Electron 可执行文件 + `ELECTRON_RUN_AS_NODE=1` 当 Node 用。
 *     识别不了它，命令行就会变成 `node ...app.asar...\cli.js`，报的错跟真因毫不相干。
 */
function parseCmdShim(file: string): { command: string; prefixArgs: string[]; env: Record<string, string> } | null {
  try {
    return parseShimContent(readFileSync(file, 'utf8'), dirname(file))
  } catch {
    return null
  }
}

/**
 * shim 文本 → 启动方式。**纯函数**（`exists` 可注入），所以单测可以直接喂真实 shim 文本，
 * 不必在测试机上装一遍对应软件。
 */
export function parseShimContent(
  content: string,
  dir: string,
  exists: (path: string) => boolean = existsSync
): { command: string; prefixArgs: string[]; env: Record<string, string> } | null {
  const electron = parseElectronShim(content, dir, exists)
  if (electron) return electron
  try {
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
    const script = join(dir, relative.split('/').join('\\'))
    if (!exists(script)) return null
    const nodeCandidates = [
      process.env.NODE_EXE,
      process.execPath,
      'C:\\Program Files\\nodejs\\node.exe',
      join(dirname(process.execPath), 'node.exe')
    ].filter((value): value is string => Boolean(value))
    for (const node of nodeCandidates) {
      if (node.toLowerCase().includes('electron')) continue
      if (exists(node)) return { command: node, prefixArgs: [script], env: {} }
    }
    return { command: 'node', prefixArgs: [script], env: {} }
  } catch {
    return null
  }
}

/** 见 parseCmdShim 的说明 2：Electron 用 `ELECTRON_RUN_AS_NODE` 当 Node 跑的 shim。 */
function parseElectronShim(
  content: string,
  dir: string,
  exists: (path: string) => boolean
): { command: string; prefixArgs: string[]; env: Record<string, string> } | null {
  if (!/ELECTRON_RUN_AS_NODE/i.test(content)) return null
  /**
   * 取 `%~dp0` 之后、**到引号为止**的那一段（不能停在空格：实测路径里就有
   * `…\DeepSeek Harness.exe`，按空格切会把可执行文件切没）。
   */
  const relatives = [...content.matchAll(/%~dp0([^"]+)/gi)].map((match) => match[1].trim())
  const toAbsolute = (rel: string): string => resolve(dir, rel.split('/').join('\\'))
  const executable = relatives.map(toAbsolute).find((value) => /\.exe$/i.test(value))
  const script = relatives.map(toAbsolute).find((value) => /\.(js|mjs|cjs)$/i.test(value))
  if (!executable || !script) return null
  /**
   * **只要求那个 .exe 存在**。脚本常常在 `app.asar` 里 —— Electron 的 fs 能看进 asar，
   * 普通 Node（单测、离线探针）看不到，硬要求它存在会让解析在测试里退化到 cmd.exe 兜底。
   * 脚本路径对不对，交给子进程自己报错（比在这里猜错要好）。
   */
  if (!exists(executable)) return null
  /** 中间那些开关（如 `--expose-internals`）照搬 —— 少一个 Electron 就可能不认这个入口。 */
  const line = content.split(/\r?\n/).find((value) => /\.exe"/i.test(value)) ?? ''
  const flags = [...line.matchAll(/(?:^|\s)(--[A-Za-z0-9][A-Za-z0-9-]*)/g)].map((match) => match[1])
  return {
    command: executable,
    prefixArgs: [...flags, script],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  }
}

export interface SpawnOptions {
  cwd: string
  env?: Record<string, string>
  /** 超时后强制结束 */
  timeoutMs?: number
}

export function spawnAgent(command: string, args: string[], options: SpawnOptions): ChildProcess {
  /**
   * 走 cmd.exe 的兜底路径要自己拼命令行：`/s /c` 会剥掉**最外层**一对引号再原样执行，
   * 所以整条命令必须再包一层 —— 否则带空格的路径（`D:\DeepSeek Harness\…`）会在第一个
   * 空格处被切断（实测报 `'D:\DeepSeek' 不是内部或外部命令`）。普通情况不动。
   */
  const viaCmd = /(^|[\\/])cmd(\.exe)?$/i.test(command)
  const child = spawn(command, viaCmd ? cmdCommandArgs(args) : args, {
    cwd: options.cwd,
    env: childEnv(options.env),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    ...(viaCmd ? { windowsVerbatimArguments: true } : {})
  })
  if (options.timeoutMs && options.timeoutMs > 0) {
    setTimeout(() => {
      if (child.exitCode === null) killTree(child)
    }, options.timeoutMs)
  }
  return child
}

/** 按进程树结束子进程，避免残留。 */
/**
 * cmd.exe 的命令行拼装（配合 `windowsVerbatimArguments: true` 使用）。
 *
 * 输入形如 `['/d','/s','/c', '<可执行文件>', ...参数]`，输出把 `/c` 之后的部分整体包一层引号：
 * `cmd.exe /d /s /c ""D:\带 空格\dsh.cmd" "--profile" "acp""`。
 * 直接传裸路径是错的 —— cmd 会在第一个空格处断句。
 */
export function cmdCommandArgs(args: string[]): string[] {
  if (args.length < 4 || args[0].toLowerCase() !== '/d' || args[2].toLowerCase() !== '/c') return args
  const quote = (value: string): string => (/[\s"]/.test(value) ? '"' + value.replace(/"/g, '\\"') + '"' : value)
  const inner = [quote(args[3]), ...args.slice(4).map(quote)].join(' ')
  return [args[0], args[1], args[2], '"' + inner + '"']
}

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

/**
 * 读取版本号。
 *
 * `env` 是额外注入的环境变量：dsh 之类"自带模型路由"的工具在冷启动时会读密钥，
 * 少了它可能直接以非零码退出，版本号也就读不到。
 *
 * 超时给 15 秒、空输出再试一次，都是被实测逼出来的：**启动时**几个 Agent 是并发探测的
 * （Claude SDK 起子进程、Codex 起 app-server、dsh 要拉起一个 Electron 当 Node 用），
 * 机器忙的时候 dsh 那次 `--version` 会在 8 秒内一个字节都不吐 —— 于是面板上显示
 * `dsh=`（有版本字段但空），用户以为没装好；手动"重新探测"又是好的。
 */
export async function readVersion(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  timeoutMs = 15000
): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { stdout } = await execFileAsync(command, args, {
        timeout: timeoutMs,
        windowsHide: true,
        cwd,
        env: childEnv(env)
      })
      const line = firstLine(stdout)
      if (line) return line
    } catch (error) {
      const line = firstLine((error as { stdout?: string }).stdout ?? '')
      if (line) return line
    }
    // 空输出：可能是冷启动被并发探测挤掉了时间，退让一下再问一次
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 600))
  }
  return null
}

/** 命令输出的第一行（空输出返回 null —— 别把 "" 当版本号，界面会显示成空白）。 */
function firstLine(text: string): string | null {
  const line = text.trim().split(/\r?\n/)[0]?.trim() ?? ''
  return line.length > 0 ? line : null
}

export function listDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
