/** 快捷键解析与分发（规划书 §6.6）。支持 Ctrl+K Ctrl+T 这类双段组合。 */
import { CMD } from '@logicreader/shared'
import { executeCommand } from './state/commands.store'
import { useUiStore } from './state/ui.store'
import { useTabs } from './state/tabs.store'
import { useLayout } from './state/layout.store'

export interface Keybinding {
  keys: string[]
  command: string
  /** 在输入框内也生效 */
  global?: boolean
  args?: unknown
}

export const KEYBINDINGS: Keybinding[] = [
  { keys: ['ctrl+shift+p', 'f1'], command: CMD.commandPalette, global: true },
  { keys: ['ctrl+p'], command: CMD.gotoFile, global: true },
  { keys: ['ctrl+shift+o'], command: CMD.fileOpenFolder, global: true },
  { keys: ['ctrl+o'], command: CMD.fileOpen, global: true },
  { keys: ['ctrl+,'], command: CMD.settingsOpen, global: true },
  { keys: ['ctrl+b'], command: CMD.viewToggleSidebar, global: true },
  { keys: ['ctrl+alt+b'], command: CMD.viewToggleAuxBar, global: true },
  { keys: ['ctrl+j'], command: CMD.viewTogglePanel, global: true },
  { keys: ['f11'], command: CMD.viewToggleFullScreen, global: true },
  { keys: ['ctrl+\\'], command: CMD.viewSplitEditor, global: true },
  { keys: ['ctrl+shift+g'], command: CMD.graphGenerate, global: true },
  { keys: ['ctrl+shift+l'], command: CMD.graphShow, global: true },
  { keys: ['ctrl+shift+a'], command: CMD.agentFocusInput, global: true },
  { keys: ['ctrl+shift+q'], command: CMD.agentAskSelection, global: true },
  { keys: ['ctrl+='], command: CMD.viewZoomIn, global: true },
  { keys: ['ctrl+-'], command: CMD.viewZoomOut, global: true },
  { keys: ['ctrl+0'], command: CMD.viewZoomReset, global: true },
  { keys: ['ctrl+k', 'ctrl+t'], command: CMD.themeToggleLightDark, global: true },
  { keys: ['ctrl+k', 'ctrl+d'], command: CMD.themeCyclePdfDark, global: true },
  { keys: ['ctrl+k', 'ctrl+s'], command: CMD.helpShortcuts, global: true },
  { keys: ['ctrl+w'], command: CMD.fileClose, global: true },
  { keys: ['ctrl+numpad1'], command: CMD.viewFocusGroup1, global: true },
  { keys: ['ctrl+f'], command: CMD.readerFind },
  { keys: ['pgdn'], command: CMD.nextPage },
  { keys: ['pgup'], command: CMD.prevPage },
  { keys: ['alt+left'], command: CMD.goBack },
  { keys: ['alt+right'], command: CMD.goForward },
  { keys: ['escape'], command: CMD.agentStop, global: true }
]

function normalizeEvent(event: KeyboardEvent): string {
  const parts: string[] = []
  if (event.ctrlKey) parts.push('ctrl')
  if (event.altKey) parts.push('alt')
  if (event.shiftKey) parts.push('shift')
  if (event.metaKey) parts.push('meta')
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase()
  if (!['control', 'alt', 'shift', 'meta'].includes(key)) parts.push(key)
  return parts.join('+')
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

let pending: { keys: string[]; at: number } | null = null

/**
 * 快捷键诊断：把最近的按键组合写进主日志。
 * 有些环境里 Ctrl 组合会被系统/输入法吞掉，光看"没反应"无法判断是没收到还是没匹配。
 */
const recentKeys: string[] = []
function traceKey(event: KeyboardEvent): void {
  const chord = normalizeEvent(event)
  recentKeys.push(chord)
  if (recentKeys.length > 40) recentKeys.shift()
  const api = (globalThis as { logicreader?: { log: { write: (...args: unknown[]) => Promise<void> } } }).logicreader
  void api?.log.write(
    'debug',
    'keys',
    'keydown ' + chord + ' target=' + String((event.target as HTMLElement | null)?.tagName ?? '?')
  )
}

export function installKeybindings(): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    const chord = normalizeEvent(event)
    const editable = isEditable(event.target)
    traceKey(event)

    // Escape：关闭覆盖层 / 退出演示模式 / 停止生成
    if (chord === 'escape') {
      const ui = useUiStore.getState()
      if (ui.commandPaletteOpen) {
        ui.closeCommandPalette()
        return
      }
      if (ui.quickOpenOpen) {
        ui.closeQuickOpen()
        return
      }
      if (useLayout.getState().zenMode) {
        useLayout.getState().toggleZenMode()
        return
      }
      void executeCommand(CMD.agentStop)
      return
    }

    if (editable) {
      // 输入框内只响应全局快捷动作
      const globalOnly = KEYBINDINGS.filter((binding) => binding.global && binding.keys.includes(chord))
      if (globalOnly.length === 0) return
      event.preventDefault()
      void executeCommand(globalOnly[0].command, globalOnly[0].args)
      return
    }

    const sequence = pending && Date.now() - pending.at < 2000 ? [...pending.keys, chord] : [chord]
    pending = null

    const exact = KEYBINDINGS.filter((binding) => binding.keys.length === sequence.length && binding.keys.every((key, index) => key === sequence[index]))
    if (exact.length > 0) {
      event.preventDefault()
      void executeCommand(exact[0].command, exact[0].args)
      return
    }

    const isPrefix = KEYBINDINGS.some(
      (binding) => binding.keys.length > sequence.length && sequence.every((key, index) => binding.keys[index] === key)
    )
    if (isPrefix) {
      event.preventDefault()
      pending = { keys: sequence, at: Date.now() }
    }
  }

  window.addEventListener('keydown', onKeyDown, true)
  return () => window.removeEventListener('keydown', onKeyDown, true)
}

export function activeTabId(): string | null {
  return useTabs.getState().activeTab()?.id ?? null
}
