/** Electron 主进程入口。 */
import { app, BrowserWindow, Menu, dialog, session as electronSession } from 'electron'
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CH } from '@logicreader/shared'
import { broadcast, logMain } from './util/ipc'
import { paths } from './util/paths'
import { isSupported } from '@logicreader/shared'
import { logService } from './services/log.service'
import { settingsService } from './services/settings.service'
import { sessionService } from './services/session.service'
import { fsService } from './services/fs.service'
import { storeService } from './services/store.service'
import { applyThemeToWindow, createMainWindow, currentTheme, snapshotGeometry } from './window'
import { registerIpc } from './ipc'
import { agentRegistry } from './services/agent/registry'
import { agentRuntime } from './services/agent/runtime'

let mainWindow: BrowserWindow | null = null
let flushed = false
const pendingFileOpens: string[] = []

/**
 * 启动期崩溃排查文件（%APPDATA%/logicreader/logs/boot.log）。
 *
 * 为什么必须自己写：GPU 子进程的报错来自 **Chromium 原生层**，走的是进程 stderr，
 * 既不会出现在应用日志里，也不会进 SQLite —— 打包成 GUI 程序后 stderr 更是没人接。
 * 实际情况就是"双击后什么都不发生、日志里只有一行 renderer launch-failed"。
 * 这里把 stderr / 未捕获异常 / 各阶段时间点都落盘，下一次启动就能直接看出崩在哪一步。
 */
function bootLog(stage: string, detail?: string): void {
  try {
    const dir = paths.logs()
    mkdirSync(dir, { recursive: true })
    appendFileSync(
      join(dir, 'boot.log'),
      '[' + new Date().toISOString() + '] ' + stage + (detail ? ' :: ' + detail : '') + '\n'
    )
  } catch {
    /* 日志失败不能影响启动 */
  }
}

/**
 * 这台机器是否已经确认"GPU 进程起不来"。
 * 记录在 userData/render-fallback.json —— 因为 app.disableHardwareAcceleration()
 * 只允许在 app ready **之前**调用，而失败是 ready 之后才知道的，
 * 所以只能"记住这次失败，下次启动时降级"。没有这段记忆时的表现就是：
 * 每次双击都失败、每次都只留一行日志，用户永远打不开。
 */
interface FallbackRecord {
  softwareRendering?: boolean
  noSandbox?: boolean
  singleProcess?: boolean
  reason?: string
  at?: number
}

interface RememberedFallback {
  recorded: boolean
  software: boolean
  noSandbox: boolean
  singleProcess: boolean
  reason?: string
}

function gpuFallbackRecorded(): RememberedFallback {
  try {
    const file = paths.gpuFallback()
    if (!existsSync(file)) {
      return { recorded: false, software: false, noSandbox: false, singleProcess: false }
    }
    const raw = JSON.parse(readFileSync(file, 'utf8')) as FallbackRecord
    return {
      recorded: true,
      software: Boolean(raw?.softwareRendering),
      noSandbox: Boolean(raw?.noSandbox),
      singleProcess: Boolean(raw?.singleProcess),
      reason: raw?.reason
    }
  } catch {
    return { recorded: false, software: false, noSandbox: false, singleProcess: false }
  }
}

/**
 * 记下"这台机器需要降级启动"，供下次启动读取。
 *
 * 两条降级互相独立：
 *  - softwareRendering：GPU 进程起不来（FATAL: GPU process isn't usable）；
 *  - noSandbox：**子进程根本创建不出来**（exitCode 18 = RESULT_CODE_LAUNCH_FAILED）。
 *    后者是本次"双击没反应"的直接原因 —— 实测同一份程序，不带 --no-sandbox 时
 *    进程会在写下第一行日志之前就退出，所以日志里什么都看不到。
 */
function markFallback(patch: FallbackRecord): void {
  try {
    const previous = gpuFallbackRecorded()
    const next: FallbackRecord = {
      softwareRendering: previous.software || Boolean(patch.softwareRendering),
      noSandbox: previous.noSandbox || Boolean(patch.noSandbox),
      // 单进程是最后一档：只有"连 --no-sandbox 都救不回来"时才会被写进来
      singleProcess: previous.singleProcess || Boolean(patch.singleProcess),
      reason: patch.reason ?? previous.reason,
      at: Date.now()
    }
    writeFileSync(paths.gpuFallback(), JSON.stringify(next, null, 2), 'utf8')
    bootLog('fallback-recorded', JSON.stringify(next))
  } catch (error) {
    bootLog('fallback-record-failed', String(error))
  }
}

/** 令牌完整性级别的 SID：Medium=8192（普通）、High=12288（提权）、System=16384 */
const ELEVATED_INTEGRITY_SIDS = ['S-1-16-12288', 'S-1-16-16384']

/**
 * 当前进程是否以管理员身份运行（只对 Windows 有意义）。
 *
 * 判据取 `whoami /groups` 输出里的**完整性级别 SID**（S-1-16-*），它是与系统语言无关的：
 * 非提权是 S-1-16-8192（Medium），提权后是 S-1-16-12288（High）。
 * 刻意**不去碰** `\\.\PHYSICALDRIVE0` / SAM 这类对象 —— 那正是勒索软件与凭据窃取的行为特征，
 * 与"降低被安全软件判定为风险"的目标相悖。
 * 任何异常都按"非提权"处理：宁可漏判（少提示一次），也不能误判（打断正常启动）。
 */
function isElevated(): boolean {
  if (process.platform !== 'win32') return false
  try {
    const out = execFileSync('whoami.exe', ['/groups'], { encoding: 'utf8', windowsHide: true, timeout: 4000 })
    return ELEVATED_INTEGRITY_SIDS.some((sid) => out.includes(sid))
  } catch {
    return false
  }
}

/** "已尝试以普通权限重开"的标记文件：防止在内置 Administrator 等**永远**处于 High 令牌的账户上反复重开 */
function normalRetryMarker(): string {
  return join(paths.userData(), 'elevate-retry.json')
}

function normalRetryRecently(): boolean {
  try {
    const file = normalRetryMarker()
    if (!existsSync(file)) return false
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { at?: number }
    return typeof raw?.at === 'number' && Date.now() - raw.at < 120000
  } catch {
    return false
  }
}

function markNormalRetry(): void {
  try {
    writeFileSync(normalRetryMarker(), JSON.stringify({ at: Date.now() }), 'utf8')
  } catch {
    /* 标记写不进去也不影响本次重开 */
  }
}

/**
 * 提权启动的处理 —— 这一条是"非管理员双击毫无反应"的真正根因修复。
 *
 * 实测机制（本机可复现）：
 *  1. 提权实例启动时会独占 `userData/lockfile`（Chromium 的 ProcessSingleton 锁）；
 *  2. 此时**非管理员**双击，Chromium 建锁失败（`Lock file can not be created: 拒绝访问 0x5`），
 *     浏览器进程在**任何 JS 执行之前**直接退出 —— 没有窗口、没有对话框、boot.log 一行都不写；
 *  3. 非管理员实例也无法通知提权实例（Windows UIPI 拦住跨完整性级别的窗口消息），
 *     于是"再点也没用"；而**提权**再启动一次却能看到窗口（同级别可以互相通知），
 *     于是形成"必须用管理员权限才能运行"的错觉。
 *
 * 因此：不再容忍停留在提权令牌下 —— 默认用系统外壳（explorer.exe 是登录用户的中等完整性进程）
 * 以普通权限重新打开自己，然后退出当前提权实例、把锁让出来。
 */
function handleElevatedLaunch(): void {
  if (!isElevated()) return
  bootLog('elevated-detected', 'running as administrator; later non-admin launches would fail silently')
  if (normalRetryRecently()) {
    // 刚重开过还是提权（内置 Administrator / UAC 关闭等），再重开只会成环：如实记录后继续运行
    bootLog('elevated-retry-skipped', 'still elevated after a recent normal-privilege relaunch; continuing')
    return
  }
  let reopen = true
  try {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'LogicReader 不需要管理员权限',
      message: '检测到正在以管理员身份运行',
      detail:
        '以管理员身份运行会让"之后用普通方式打开"完全没有反应：\n' +
        '提权实例会独占用户数据目录里的启动锁（userData/lockfile），\n' +
        '非管理员实例既打不开这个锁，也无法通知提权实例（Windows 完整性隔离）。\n\n' +
        '建议以普通权限重新打开。',
      buttons: ['以普通权限重新打开（推荐）', '仍然以管理员身份继续'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    reopen = choice === 0
  } catch (error) {
    bootLog('elevated-dialog-failed', String(error))
  }
  if (!reopen) {
    bootLog('elevated-continue', 'user chose to keep running elevated')
    return
  }
  try {
    markNormalRetry()
    // explorer.exe 是已运行的中等完整性外壳：由它拉起目标进程 = 以普通权限启动
    const child = spawn('explorer.exe', [process.execPath], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    bootLog('elevated-relaunch-unelevated', process.execPath)
    app.exit(0)
  } catch (error) {
    bootLog('elevated-relaunch-failed', String(error))
    try {
      dialog.showErrorBox(
        '请用普通方式打开',
        '自动以普通权限重新打开失败。请关闭本窗口后，直接双击 LogicReader.exe（不要选"以管理员身份运行"）。'
      )
    } catch {
      /* 对话框失败时至少已经写了 boot.log */
    }
  }
}

/**
 * GPU 相关开关必须在 app ready 之前设置。
 *
 * 注意这里**没有**无条件禁用沙箱/GPU：优先保证正常机器的安全性；
 * 只有在"上一次已经被判定 GPU 不可用"（或用户显式要求）时才关掉硬件加速。
 */
function setupGpuSwitches(): { software: boolean; noSandbox: boolean; singleProcess: boolean } {
  const forcedSoftware = String(process.env.LR_FORCE_SOFTWARE ?? '') === '1'
  const forcedNoSandbox = String(process.env.LR_FORCE_NO_SANDBOX ?? '') === '1'
  const forcedSingle = String(process.env.LR_FORCE_SINGLE_PROCESS ?? '') === '1'
  const remembered = gpuFallbackRecorded()
  const software = forcedSoftware || remembered.software
  const noSandbox = forcedNoSandbox || remembered.noSandbox
  /**
   * 最后一档降级：**单进程模式**。
   * 有些安全软件/策略会拦截 Chromium 创建任何子进程，此时 --no-sandbox 也没用
   * （日志表现为"已降级、仍然 launch-failed"）。单进程模式下渲染就在主进程里跑，
   * 从根上绕开"创建子进程"这件事；代价是稳定性下降，所以只在前两档都失败后才启用。
   */
  const singleProcess = forcedSingle || remembered.singleProcess
  try {
    app.commandLine.appendSwitch('disable-gpu-sandbox')
    app.commandLine.appendSwitch('disable-breakpad')
    /**
     * 关键一行：降级判定只是"算出来"没有用，必须真的把开关加到命令行上。
     * 这里曾经漏掉，导致日志里写着 noSandbox=true、实际启动却仍带沙箱 ——
     * 表现就是"明明已经降级，还是 launch-failed exitCode=18"。
     */
    if (noSandbox) {
      app.commandLine.appendSwitch('no-sandbox')
      app.commandLine.appendSwitch('disable-setuid-sandbox')
      app.commandLine.appendSwitch('disable-gpu-sandbox')
      bootLog('append-switch', 'no-sandbox=1')
    }
    // 混合显卡的笔记本/虚拟机上 GPU 进程经常起不来，这一条几乎没有副作用
    app.commandLine.appendSwitch('disable-gpu-compositing')
    if (singleProcess) {
      app.commandLine.appendSwitch('single-process')
      app.commandLine.appendSwitch('in-process-gpu')
      bootLog('append-switch', 'single-process=1')
    }
    bootLog(
      'gpu-switches',
      'software=' +
        String(software) +
        ' noSandbox=' +
        String(noSandbox) +
        ' singleProcess=' +
        String(singleProcess) +
        ' rememberedSoftware=' +
        String(remembered.software) +
        ' rememberedNoSandbox=' +
        String(remembered.noSandbox) +
        (remembered.reason ? ' reason=' + remembered.reason : '')
    )
    if (software) {
      // 必须在 ready 之前
      app.disableHardwareAcceleration()
      bootLog('disable-hardware-acceleration', 'ok')
    }
  } catch (error) {
    bootLog('gpu-switches-failed', String(error))
  }
  return { software, noSandbox, singleProcess }
}

/** Windows"正在保护你的电脑"这类弹窗之后如果仍然起不来，至少要让用户看见原因，而不是静默退出 */
function reportFatal(message: string): void {
  bootLog('fatal', message)
  try {
    dialog.showErrorBox(
      'LogicReader 启动失败',
      message +
        '\n\n排查文件：' +
        join(paths.logs(), 'boot.log') +
        '\n可尝试：直接再打开一次（下次启动会自动使用兼容形态），或手动执行\n  LogicReader.exe --no-sandbox'
    )
  } catch {
    /* 对话框失败时至少已经写了 boot.log */
  }
}

function rendererUrl(): string | null {
  return process.env.ELECTRON_RENDERER_URL ?? null
}

function rendererEntry(): string {
  return join(__dirname, '../renderer/index.html')
}

function preloadEntry(): string {
  return join(__dirname, '../preload/index.js')
}

function collectFilesFromArgv(argv: string[]): string[] {
  const out: string[] = []
  for (const raw of argv.slice(1)) {
    if (!raw || raw.startsWith('-')) continue
    if (raw === '.' || raw === '..') continue
    try {
      const abs = resolve(raw)
      if (existsSync(abs) && isSupported(abs)) out.push(abs)
    } catch {
      /* 忽略非法路径 */
    }
  }
  return out
}

/**
 * 把待打开文件交给渲染进程。
 * 渲染进程可能还没订阅事件（React 尚未挂载），因此同时放进队列，
 * 由渲染进程启动后调用 app:take-pending-files 取走，避免丢事件。
 */
function deliverFiles(files: string[]): void {
  if (files.length === 0) return
  pendingFileOpens.push(...files)
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.webContents.isLoading()) {
      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(() => broadcast(CH.app.openFiles, files), 60)
      })
    } else {
      broadcast(CH.app.openFiles, files)
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
}

/** 收紧渲染进程权限：禁止 webview、禁止绕过 CSP。 */
function hardenSession(): void {
  electronSession.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  electronSession.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const devUrl = rendererUrl()
    const csp = [
      "default-src 'self'",
      devUrl ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' " + devUrl : "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: file:",
      "font-src 'self' data: file:",
      devUrl ? "connect-src 'self' ws: http: https: file:" : "connect-src 'self' file:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "frame-src 'none'"
    ].join('; ')
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
  })
}

function bootstrapServices(): void {
  logService.init()
  settingsService.load()
  fsService.init(settingsService.all().recentLimit)
  sessionService.setDebounce(settingsService.all().snapshotDebounceMs)
  storeService.open(paths.db())
  // Agent 注册表与事件总线
  agentRegistry.init()
  agentRuntime.setEmitter((sessionId, event) => broadcast(CH.agent.event, { sessionId, ...event }))
  // 启动后台探测：否则界面上所有 Agent 都会显示"不可用"（只有被探测过的才有能力信息）
  void agentRegistry
    .probeAll(false)
    .then((capabilities) => {
      broadcast(CH.agent.changed)
      logMain(
        'info',
        'agent',
        'Agent 能力探测完成：' +
          capabilities.map((item) => item.id + '=' + (item.available ? item.version ?? 'ok' : 'N/A')).join(', ')
      )
    })
    .catch((error) => logMain('warn', 'agent', 'Agent 探测失败', String(error)))
}

/** 已经因渲染进程崩溃重建过几次（每个进程最多一次，避免死循环） */
let windowRebuilds = 0
/** 降级提示只弹一次 */
let fallbackDialogShown = false
/** 本次启动内已经把窗口级沙箱关掉（进程内恢复；命令行开关此刻已来不及追加） */
let sandboxRelaxedAtRuntime = false
/** 本次启动本身就是"恢复启动"（命令行已带 --no-sandbox），用于防止重启成环 */
const launchedByRecovery = process.argv.includes('--lr-recovered')

/** 恢复启动时附加的命令行开关（与 render-fallback.json 记录的一致） */
const RECOVERY_SWITCHES = ['--no-sandbox', '--disable-gpu-sandbox', '--lr-recovered']

/**
 * 第二级恢复：用 `--no-sandbox` **重启自己一次**。
 *
 * 为什么需要它：`--no-sandbox` 只能在 app ready **之前**追加，
 * 而"窗口级沙箱关掉"这条进程内通路在个别机器上依然会被拦住。
 * 重启用的是与"已确认可用"完全相同的命令行形态，因此**不需要管理员权限**，
 * 也不需要用户再手动打开第二次 —— 首次双击即可自动完成。
 */
function relaunchDegraded(reason: string): void {
  bootLog('recover-relaunch', reason)
  try {
    const args = process.argv
      .slice(1)
      .filter((value) => !RECOVERY_SWITCHES.includes(value) && value !== '--single-process' && value !== '--in-process-gpu')
    args.push(...RECOVERY_SWITCHES)
    app.relaunch({ args })
    // 官方推荐写法：relaunch 之后立刻退出。
    // app.exit 不触发 before-quit，因此重启路径上不会弹"启动失败"对话框；
    // 同时保证本进程先释放单实例锁，重启后的实例才能顺利接管。
    app.exit(0)
  } catch (error) {
    bootLog('recover-relaunch-failed', String(error))
  }
}

function createWindow(options: { rebuild?: boolean } = {}): void {
  const report = sessionService.load()
  const snapshot = report?.snapshot.windows[0] ?? null
  const theme = currentTheme()
  bootLog('create-window', 'rebuild=' + String(Boolean(options.rebuild)))

  const win = createMainWindow({
    snapshot,
    theme,
    preloadPath: preloadEntry(),
    rendererUrl: rendererUrl(),
    rendererFile: rendererEntry(),
    isPackaged: app.isPackaged,
    noSandbox: launchSwitches.noSandbox || launchSwitches.singleProcess || sandboxRelaxedAtRuntime
  })
  mainWindow = win

  /**
   * 同一次启动内的**两级自动恢复**（都不需要管理员权限，也不需要用户手动再打开一次）：
   *   第 1 级：关掉窗口级沙箱（webPreferences.sandbox=false）重开窗口 —— 进程内，秒级；
   *   第 2 级：仍然失败就用 --no-sandbox 重启自己一次 —— 等价于"第二次打开"，但自动完成。
   * 失败结论同时落盘（render-fallback.json），保证后续每次启动都直接走兼容形态。
   */
  const createdAt = Date.now()
  win.webContents.on('render-process-gone', (_event, details) => {
    const immediate = Date.now() - createdAt < 15000
    bootLog('render-process-gone', details.reason + ' exitCode=' + details.exitCode + ' immediate=' + String(immediate))
    if (details.reason === 'clean-exit') return
    /**
     * 失败分档记账（每次失败后**下次启动**才会生效，因为开关必须在 ready 之前落地）：
     *  第 1 档：软件渲染 + 关沙箱   —— 覆盖绝大多数"GPU/沙箱被拦"的机器；
     *  第 2 档：再加单进程模式       —— 覆盖"连子进程都创建不出来"的安全软件/策略环境。
     */
    const remembered = gpuFallbackRecorded()
    markFallback({
      softwareRendering: true,
      noSandbox: true,
      reason: details.reason + ' exitCode=' + details.exitCode
    })
    if (!immediate) return
    if (remembered.singleProcess) return
    /**
     * 第 1 级：进程内恢复（不重启、不提权）。
     * webPreferences.sandbox=false 与命令行 --no-sandbox 是两条独立通路，
     * 且它**不受 app ready 限制**，所以能在同一次启动里立刻生效。
     */
    if (windowRebuilds === 0) {
      windowRebuilds += 1
      sandboxRelaxedAtRuntime = true
      bootLog('recover-in-process', 'rebuild window with webPreferences.sandbox=false')
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy()
        mainWindow = null
        createWindow({ rebuild: true })
      }, 300)
      return
    }
    /**
     * 第 2 级：进程内重开仍然失败 —— 用 --no-sandbox 重启自己一次。
     * 这条路依然是"关沙箱"，只是改在命令行上落地，所以仍然**不需要管理员权限**。
     * 若本次已经是恢复启动还失败，就不再重启（否则会成环），留给 before-quit 的提示对话框。
     */
    if (!launchedByRecovery) {
      relaunchDegraded('launch-failed exitCode=' + details.exitCode)
      return
    }
    /**
     * 第 3 级（下次启动生效）：连"关沙箱重启"都失败，说明本机连渲染子进程都创建不出来，
     * 把最后一档"单进程模式"记下来 —— 渲染直接跑在主进程里，从根上不创建子进程。
     */
    markFallback({
      softwareRendering: true,
      noSandbox: true,
      singleProcess: true,
      reason: 'single-process fallback: ' + details.reason + ' exitCode=' + details.exitCode
    })
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.webContents.on('did-finish-load', () => {
    bootLog('did-finish-load')
    if (pendingFileOpens.length > 0) {
      const files = pendingFileOpens.splice(0, pendingFileOpens.length)
      broadcast(CH.app.openFiles, files)
    }
    if (report?.crashed) {
      logMain('warn', 'session', '检测到上次异常退出，已恢复到最近一次快照')
    }
  })

  applyThemeToWindow(win, theme)
}

function saveGeometrySnapshot(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const geometry = snapshotGeometry(mainWindow)
  sessionService.save({ windows: [{ ...geometry }] }, false)
}

function setupLifecycle(): void {
  app.on('before-quit', (event) => {
    if (flushed) return
    event.preventDefault()
    const started = Date.now()
    try {
      saveGeometrySnapshot()
    } catch (error) {
      logMain('warn', 'app', '退出前采集窗口几何失败', String(error))
    }
    sessionService.flush('quit')
    settingsService.dispose()
    fsService.unwatchAll()
    void agentRuntime.shutdown()
    storeService.close()
    flushed = true
    const elapsed = Date.now() - started
    logMain('info', 'app', '退出前快照已落盘（' + elapsed + 'ms）')
    // 1s 兜底：无论如何都要退出
    setTimeout(() => app.exit(0), Math.max(0, 1000 - elapsed))
    app.exit(0)
  })

  app.on('window-all-closed', () => {
    logMain('warn', 'app', '所有窗口已关闭，准备退出')
    app.quit()
  })

  /**
   * 渲染进程起不来时窗口会被系统直接判废、连"闪一下"都看不到 ——
   * 必须给用户一个看得见的解释与可执行的下一步，而不是静默退出。
   */
  app.on('before-quit', () => {
    if (windowRebuilds === 0) return
    if (fallbackDialogShown) return
    fallbackDialogShown = true
    reportFatal(
      'LogicReader 无法在本机启动渲染进程（Chromium 子进程创建被拦截，launch-failed exitCode 18）。\n\n' +
        '程序已自动尝试过两级恢复（关闭窗口沙箱 → 用 --no-sandbox 重启一次），仍然失败。\n' +
        '这两步都**不需要管理员权限**，所以请先按下面两条排查，不要改用管理员身份运行：\n\n' +
        '1) 重新打开一次：失败结论已写入 userData/render-fallback.json，\n' +
        '   下次启动会直接使用"软件渲染 + 关闭沙箱"的兼容形态。\n' +
        '2) 若仍然失败，说明本机禁止 Chromium 创建任何子进程（这会影响所有 Electron 程序）：\n' +
        '   常见来源是安全软件的"程序隔离"、组策略限制、受控文件夹访问；\n' +
        '   把安装目录加入白名单后重试，通常即可恢复。\n\n' +
        '自检（不需要管理员）：\n' +
        '  LogicReader.exe --no-sandbox --single-process\n' +
        '若这样能打开，请把上述排查结果反馈给开发者。'
    )
  })

  process.on('uncaughtException', (error) => {
    bootLog('uncaughtException', error.stack ?? String(error))
    logMain('error', 'app', '未捕获异常', error.stack ?? String(error))
  })
  process.on('unhandledRejection', (reason) => {
    bootLog('unhandledRejection', String(reason))
    logMain('error', 'app', '未处理的 Promise 拒绝', String(reason))
  })
}

// 说明：这里**没有**任何"自我提权"路径（隐藏窗口调 PowerShell + -Verb RunAs 已整体移除）：
// 它既是安全软件判高危的行为模式，又会把 userData/lockfile 交给提权实例、
// 让之后所有**非管理员**双击在 Chromium 启动阶段静默失败（详见 handleElevatedLaunch()）。
// 万一用户仍手动以管理员身份启动，handleElevatedLaunch() 会把他"送回"普通权限。

// GPU / 命令行开关必须在 app ready 之前落地
const launchSwitches = setupGpuSwitches()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  bootLog('single-instance-lock-rejected', '已有实例在运行，本次启动退出')
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    deliverFiles(collectFilesFromArgv(argv))
  })

  app.whenReady().then(() => {
    bootLog(
      'app-ready',
      'electron=' +
        process.versions.electron +
        ' chrome=' +
        process.versions.chrome +
        ' software=' +
        String(launchSwitches.software) +
        ' noSandbox=' +
        String(launchSwitches.noSandbox)
    )
    /**
     * 提权启动的处理必须在这里、且在创建任何窗口之前：
     * 一旦以管理员身份把窗口开起来，userData/lockfile 就被提权实例独占，
     * 之后非管理员双击会"毫无反应"（连日志都没有）。
     */
    handleElevatedLaunch()
    Menu.setApplicationMenu(null)
    bootstrapServices()
    hardenSession()
    registerIpc({
      getWindow: () => mainWindow,
      openFilesFromArgv: deliverFiles,
      takePendingFiles: () => pendingFileOpens.splice(0, pendingFileOpens.length)
    })
    createWindow()
    deliverFiles(collectFilesFromArgv(process.argv))
    setupLifecycle()

    // 冒烟自检：LR_SMOKE=1 时启动数秒后截图并自动退出，用于无人值守验证启动链路
    if (process.env.LR_SMOKE) {
      const parsed = Number(process.env.LR_SMOKE)
      const delay = parsed > 1 ? parsed : 8000
      // 冒烟自动化：早期触发 Agent 提问 / 关系图生成，给真实模型留足生成时间
      setTimeout(() => {
        if (process.env.LR_SMOKE_AGENT) {
          broadcast(CH.app.menuCommand, {
            commandId: 'smoke.agentPrompt',
            // agentId 可选：无人值守截图时用 mock 跑完整流程，不消耗真实模型配额
            args: { text: process.env.LR_SMOKE_AGENT, agentId: process.env.LR_SMOKE_AGENT_ID || undefined }
          })
        }
        /**
         * 第二个提示词（可选）。
         * 真实模型走第三方代理时一轮要几十秒，一条提示词来不及把"工具执行完 + 差异算完"跑完，
         * 于是无人值守截图总是拍在"还在思考"。给一次追加提问，让最后一轮的产物留在界面上。
         */
        if (process.env.LR_SMOKE_AGENT_2) {
          broadcast(CH.app.menuCommand, {
            commandId: 'smoke.agentPrompt',
            args: { text: process.env.LR_SMOKE_AGENT_2, agentId: process.env.LR_SMOKE_AGENT_ID || undefined }
          })
        }
      }, Math.max(4000, Math.min(12000, Math.round(delay / 4))))
      if (process.env.LR_SMOKE_AGENT_2) {
        setTimeout(() => {
          broadcast(CH.app.menuCommand, {
            commandId: 'smoke.agentPrompt',
            args: { text: process.env.LR_SMOKE_AGENT_2, agentId: process.env.LR_SMOKE_AGENT_ID || undefined }
          })
        }, Math.max(30000, Math.round(delay * 0.55)))
      }
      setTimeout(() => {
        void (async () => {
        if (process.env.LR_SMOKE_COMMAND) {
          // 支持逗号分隔的多条命令，便于一次冒烟覆盖多个场景
          for (const commandId of process.env.LR_SMOKE_COMMAND.split(',').map((item) => item.trim()).filter(Boolean)) {
            broadcast(CH.app.menuCommand, { commandId, args: {} })
            await new Promise((resolve) => setTimeout(resolve, 900))
          }
        }
        if (process.env.LR_SMOKE_GRAPH) {
          broadcast(CH.app.menuCommand, {
            commandId: 'smoke.generateGraph',
            args: { agentId: process.env.LR_SMOKE_GRAPH_AGENT || undefined }
          })
        }
        })()
      }, Math.max(6000, Math.min(20000, Math.round(delay / 3))))
      // 真实鼠标拖选：用 sendInputEvent 产生"可信"输入（唯一能复现用户手动划选的路径）
      setTimeout(() => {
        void (async () => {
          try {
            const win = mainWindow
            if (!win || win.isDestroyed()) return
            /**
             * 选一段"确实能选中"的文字：
             *  1) span 完整落在视口内；
             *  2) span 中心的命中测试结果就是它自己（没有被遮罩、链接层、面板挡住）。
             * 这样脚本就不会再出现"拖到空白处 → DOM 选区为空"的假阴性。
             */
            // 首启向导会盖住正文，导致拖选全部落空；先点掉它
            await win.webContents.executeJavaScript(
              "(() => { const w = document.querySelector(\".lr-wizard\"); if (w) { const b = Array.from(w.querySelectorAll(\"button\")).find((x) => (x.textContent || \"\").indexOf(\"确认\") >= 0) || w.querySelector(\"button\"); if (b) b.click(); return true } return false })()"
            )
            await new Promise((resolve) => setTimeout(resolve, 600))
            const measureScript = [
              "(() => {",
              "  const pages = Array.from(document.querySelectorAll(\".lr-pdf-page\"))",
              "  const scroll = document.querySelector(\".lr-pdf-scroll\")",
              "  const host = scroll ? scroll.getBoundingClientRect() : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth }",
              "  const page = pages.find((p) => { const r = p.getBoundingClientRect(); return r.bottom > host.top + 60 && r.top < host.bottom - 60 }) || pages[0]",
              "  if (!page) return null",
              "  const all = Array.from(page.querySelectorAll(\".textLayer span[data-char-start]\")).filter((s) => (s.textContent || \"\").trim().length > 3)",
              "  const usable = all.filter((span) => {",
              "    const r = span.getBoundingClientRect()",
              "    if (r.top < host.top + 130 || r.bottom > host.bottom - 60) return false",
              "    if (r.left < host.left + 4 || r.right > host.right - 24) return false",
              "    return true",
              "  })",
              "  if (usable.length < 3) { const first = all[0]; if (first) first.scrollIntoView({ block: \"center\" }); return null }",
              "  const from = usable[0].getBoundingClientRect()",
              "  const to = usable[Math.min(usable.length - 1, 3)].getBoundingClientRect()",
              "  return { x1: Math.round(from.left + 3), y1: Math.round(from.top + from.height / 2), x2: Math.round(to.right - 3), y2: Math.round(to.top + to.height / 2), text: (usable[0].textContent || \"\").slice(0, 24), spans: usable.length }",
              "})()"
            ].join("\n")
            const dragOnce = async (target: { x1: number; y1: number; x2: number; y2: number }): Promise<void> => {
              win.webContents.sendInputEvent({ type: "mouseMove", x: target.x1, y: target.y1 })
              win.webContents.sendInputEvent({ type: "mouseDown", x: target.x1, y: target.y1, button: "left", clickCount: 1 })
              for (let step = 1; step <= 8; step += 1) {
                await new Promise((resolve) => setTimeout(resolve, 40))
                win.webContents.sendInputEvent({
                  type: "mouseMove",
                  x: Math.round(target.x1 + ((target.x2 - target.x1) * step) / 8),
                  y: Math.round(target.y1 + ((target.y2 - target.y1) * step) / 8),
                  button: "left"
                })
              }
              await new Promise((resolve) => setTimeout(resolve, 60))
              win.webContents.sendInputEvent({ type: "mouseUp", x: target.x2, y: target.y2, button: "left", clickCount: 1 })
              await new Promise((resolve) => setTimeout(resolve, 700))
            }
            type DragBox = { x1: number; y1: number; x2: number; y2: number; text: string; spans: number }
            let box = (await win.webContents.executeJavaScript(measureScript)) as DragBox | null
            if (!box) {
              await new Promise((resolve) => setTimeout(resolve, 900))
              box = (await win.webContents.executeJavaScript(measureScript)) as DragBox | null
            }
            if (!box) {
              logMain("warn", "smoke", "拖选冒烟：找不到可靠的文本 span")
              return
            }
            logMain("info", "smoke", "拖选起点=" + box.x1 + "," + box.y1 + " 终点=" + box.x2 + "," + box.y2 + " 起点文本=" + box.text)
            let domLen = 0
            for (let attempt = 1; attempt <= 3; attempt += 1) {
              await dragOnce(box)
              domLen = (await win.webContents.executeJavaScript(
                "(() => { const s = window.getSelection(); return s ? s.toString().length : 0 })()"
              )) as number
              logMain("info", "smoke", "第 " + attempt + " 次拖选后 DOM 选区长度=" + domLen)
              if (domLen > 0) break
              const retry = (await win.webContents.executeJavaScript(measureScript)) as DragBox | null
              if (retry) box = retry
            }
            if (domLen === 0) logMain("warn", "smoke", "拖选冒烟：三次都未产生 DOM 选区（脚本问题，非产品结论）")
            broadcast(CH.app.menuCommand, { commandId: "smoke.verifySelection", args: {} })
            await new Promise((resolve) => setTimeout(resolve, 600))
            broadcast(CH.app.menuCommand, { commandId: "smoke.highlight", args: {} })
            await new Promise((resolve) => setTimeout(resolve, 1100))
            broadcast(CH.app.menuCommand, { commandId: "smoke.auditHighlight", args: {} })
            await new Promise((resolve) => setTimeout(resolve, 500))
            broadcast(CH.app.menuCommand, { commandId: "smoke.auditAnchor", args: {} })
          } catch (error) {
            logMain("warn", "smoke", "拖选冒烟失败", String(error))
          }
        })()
      }, Math.max(8000, Math.min(24000, Math.round(delay / 2))))
      setTimeout(() => {
        void (async () => {
          try {
            // Agent 冒烟：探测全部 Agent 并可选地发起一次提问
            try {
              const capabilities = await agentRegistry.probeAll(true)
              logMain(
                'info',
                'smoke',
                'Agent 探测结果：' +
                  capabilities
                    .map((item) => item.id + '=' + (item.available ? item.version ?? 'ok' : 'N/A'))
                    .join(', ')
              )
            } catch (error) {
              logMain('warn', 'smoke', 'Agent 探测失败', String(error))
            }
            if (process.env.LR_SMOKE_GRAPH) {
              broadcast(CH.app.menuCommand, { commandId: 'smoke.generateGraph', args: {} })
            }
            const win = mainWindow
            if (win && !win.isDestroyed()) {
              const image = await win.webContents.capturePage()
              const target = process.env.LR_SMOKE_SHOT ?? join(app.getPath('userData'), 'smoke.png')
              writeFileSync(target, image.toPNG())
              logMain('info', 'smoke', '冒烟截图已保存：' + target)
            } else {
              logMain('warn', 'smoke', '没有可用窗口，无法截图')
            }
          } catch (error) {
            logMain('error', 'smoke', '冒烟截图失败', String(error))
          }
          logMain('info', 'smoke', '冒烟自检完成，准备退出')
          app.quit()
        })()
      }, delay)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

// 崩溃时也尽力保留最近一次快照（不阻塞）
process.on('exit', () => {
  if (!flushed) {
    try {
      sessionService.flush('crash')
    } catch {
      /* 忽略 */
    }
  }
})
