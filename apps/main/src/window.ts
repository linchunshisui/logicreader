/** 主窗口创建与几何恢复 —— 规划书 §5.9.2 / §5.9.7。 */
import { BrowserWindow, screen, shell, nativeTheme, app } from 'electron'
import { join } from 'node:path'
import { resolveTheme, type WindowSnapshot, type WindowState } from '@logicreader/shared'
import { broadcast, logMain } from './util/ipc'
import { settingsService } from './services/settings.service'

const DEFAULT_SIZE = { width: 1440, height: 920 }
const MIN_SIZE = { width: 960, height: 600 }

export interface WindowCreateOptions {
  snapshot: WindowSnapshot | null
  theme: 'light' | 'dark'
  preloadPath: string
  rendererUrl: string | null
  rendererFile: string
  isPackaged: boolean
  /**
   * 关掉渲染进程的窗口级沙箱。
   * 它与命令行 --no-sandbox 是**两条独立通路**：命令行开关可能被安全软件/策略拦截，
   * 而 webPreferences.sandbox=false 直接决定 Electron 是否为该窗口创建沙箱渲染进程，
   * 对"launch-failed exitCode 18"的机器更可靠。
   */
  noSandbox?: boolean
}

interface DisplayInfo {
  id: string | null
  workArea: { x: number; y: number; width: number; height: number }
}

function resolveDisplay(displayId: string | null): DisplayInfo {
  const displays = screen.getAllDisplays()
  if (displayId) {
    const found = displays.find((d) => String(d.id) === displayId)
    if (found) return { id: displayId, workArea: found.workArea }
  }
  const primary = screen.getPrimaryDisplay()
  return { id: String(primary.id), workArea: primary.workArea }
}

/** 把窗口矩形夹取到显示器工作区内，绝不落到屏幕外。 */
export function clampBounds(bounds: { x: number; y: number; width: number; height: number }, area: DisplayInfo['workArea']): { x: number; y: number; width: number; height: number } {
  const width = Math.max(MIN_SIZE.width, Math.min(bounds.width, area.width))
  const height = Math.max(MIN_SIZE.height, Math.min(bounds.height, area.height))
  let x = bounds.x
  let y = bounds.y
  if (!Number.isFinite(x) || x < area.x - width + 120 || x > area.x + area.width - 120) x = area.x + Math.round((area.width - width) / 2)
  if (!Number.isFinite(y) || y < area.y - 40 || y > area.y + area.height - 120) y = area.y + Math.round((area.height - height) / 2)
  x = Math.max(area.x, Math.min(x, area.x + area.width - width))
  y = Math.max(area.y, Math.min(y, area.y + area.height - height))
  return { x, y, width, height }
}

export function createMainWindow(options: WindowCreateOptions): BrowserWindow {
  const snap = options.snapshot
  const display = resolveDisplay(snap?.displayId ?? null)
  const bounds = clampBounds(
    snap?.bounds ?? {
      x: display.workArea.x + Math.round((display.workArea.width - DEFAULT_SIZE.width) / 2),
      y: display.workArea.y + Math.round((display.workArea.height - DEFAULT_SIZE.height) / 2),
      width: DEFAULT_SIZE.width,
      height: DEFAULT_SIZE.height
    },
    display.workArea
  )

  const win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    backgroundColor: options.theme === 'dark' ? '#1e1e1e' : '#ffffff',
    title: 'LogicReader',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(options.theme),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: options.noSandbox !== true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  if (snap?.maximized) win.maximize()
  if (snap?.fullscreen) win.setFullScreen(true)

  // 骨架尽快出现：先 show 再加载，避免白屏等待（§5.9.4 步骤 3）
  win.once('ready-to-show', () => {
    win.show()
  })

  const emitState = (): void => {
    if (win.isDestroyed()) return
    broadcast('win:state-changed', collectState(win))
  }
  let resizeTimer: NodeJS.Timeout | null = null
  const emitDebounced = (): void => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(emitState, 200)
  }
  win.on('resize', emitDebounced)
  win.on('move', emitDebounced)
  win.on('maximize', emitState)
  win.on('unmaximize', emitState)
  win.on('enter-full-screen', emitState)
  win.on('leave-full-screen', emitState)
  win.on('focus', emitState)
  win.on('blur', emitState)

  // 渲染进程控制台转发到主进程日志，便于排查
  win.webContents.on('console-message', (event) => {
    const level = event.level === 'error' ? 'error' : event.level === 'warning' ? 'warn' : 'debug'
    logMain(level, 'renderer', event.message, event.lineNumber ? 'line ' + event.lineNumber : undefined)
  })
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    logMain('error', 'renderer', '页面加载失败 ' + code + ' ' + description, url)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    logMain('error', 'renderer', '渲染进程退出：' + details.reason + '（exitCode ' + details.exitCode + '）')
  })

  // 外部链接一律用系统浏览器打开，禁止窗口内导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = options.rendererUrl
    if (devUrl && url.startsWith(devUrl)) return
    if (url.startsWith('file://')) return
    event.preventDefault()
    if (url.startsWith('http:') || url.startsWith('https:')) void shell.openExternal(url)
  })

  if (options.rendererUrl) {
    void win.loadURL(options.rendererUrl)
  } else {
    void win.loadFile(join(options.rendererFile))
  }

  return win
}

export function titleBarOverlay(theme: 'light' | 'dark'): { color: string; symbolColor: string; height: number } {
  return theme === 'dark'
    ? { color: '#3c3c3c', symbolColor: '#cccccc', height: 35 }
    : { color: '#dddddd', symbolColor: '#333333', height: 35 }
}

export function applyThemeToWindow(win: BrowserWindow, theme: 'light' | 'dark'): void {
  if (win.isDestroyed()) return
  const overlay = titleBarOverlay(theme)
  try {
    win.setTitleBarOverlay(overlay)
  } catch {
    /* Linux 等平台可能不支持 */
  }
  win.setBackgroundColor(theme === 'dark' ? '#1e1e1e' : '#ffffff')
  /*
   * 把这次的决定写进日志：右上角那三个窗口按钮由**系统**绘制、截不到图里，
   * 出问题时只能靠"覆盖层颜色 vs 应用主题"这两个数对齐来判断（设置档位也一并打出来）。
   */
  logMain(
    'info',
    'theme',
    '窗口主题：' +
      theme +
      ' 覆盖层底=' +
      overlay.color +
      ' 符号=' +
      overlay.symbolColor +
      '（设置=' +
      settingsService.all().theme +
      ' 系统深色=' +
      String(nativeTheme.shouldUseDarkColors) +
      '）'
  )
}

export function collectState(win: BrowserWindow): WindowState {
  const b = win.getBounds()
  return {
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
    focused: win.isFocused(),
    bounds: { x: b.x, y: b.y, width: b.width, height: b.height }
  }
}

/** 采集窗口快照（含所在显示器 id）。 */
export function snapshotGeometry(win: BrowserWindow): { bounds: WindowState['bounds']; maximized: boolean; fullscreen: boolean; displayId: string | null } {
  const state = collectState(win)
  let displayId: string | null = null
  try {
    const display = screen.getDisplayMatching(state.bounds)
    displayId = String(display.id)
  } catch (error) {
    logMain('warn', 'window', '无法确定窗口显示器', String(error))
  }
  return { bounds: state.bounds, maximized: state.maximized, fullscreen: state.fullscreen, displayId }
}

/**
 * 窗口（标题栏覆盖层 / 背景色）该用哪个主题。
 *
 * ★ 必须看**应用的设置**，不能只看系统主题。
 * 旧实现是 `nativeTheme.shouldUseDarkColors ? 'dark' : 'light'` —— 用户把应用切成浅色、
 * 而 Windows 还是深色时，标题栏本身是浅的，右上角那三个窗口按钮（最小化 / 还原 / 关闭）
 * 却在浅色条上留一块深色。用户的原话："右上角的…最小化…关闭在浅色模式下也需要调整"。
 * `system` 档才跟随系统 —— 与渲染进程的 `resolveTheme` 同一套规则（同一份实现）。
 */
export function currentTheme(): 'light' | 'dark' {
  return resolveTheme(settingsService.all().theme, nativeTheme.shouldUseDarkColors)
}

export function appVersion(): string {
  return app.getVersion()
}
