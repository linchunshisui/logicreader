import { create } from 'zustand'
import { useNotifications } from './notifications.store'

export interface CommandDescriptor {
  id: string
  /** i18n key，渲染时用 t() 转换 */
  titleKey: string
  categoryKey: string
  run: (args?: unknown) => void | Promise<void>
  /** 返回 false 时命令在面板中隐藏且不可执行 */
  enabled?: () => boolean
  keybinding?: string
  /** 命令面板中用于搜索的额外关键词 */
  keywords?: string[]
}

interface CommandsState {
  commands: Record<string, CommandDescriptor>
  recent: string[]
  register: (command: CommandDescriptor) => void
  registerAll: (commands: CommandDescriptor[]) => void
  execute: (id: string, args?: unknown) => Promise<boolean>
  list: () => CommandDescriptor[]
  isEnabled: (id: string) => boolean
}

export const useCommands = create<CommandsState>((set, get) => ({
  commands: {},
  recent: [],

  register: (command) =>
    set((state) => ({ commands: { ...state.commands, [command.id]: command } })),

  registerAll: (list) =>
    set((state) => {
      const next = { ...state.commands }
      for (const command of list) next[command.id] = command
      return { commands: next }
    }),

  execute: async (id, args) => {
    const command = get().commands[id]
    if (!command) return false
    if (command.enabled && !command.enabled()) return false
    try {
      await command.run(args)
      set((state) => ({ recent: [id, ...state.recent.filter((x) => x !== id)].slice(0, 12) }))
      return true
    } catch (error) {
      useNotifications
        .getState()
        .notify({ message: error instanceof Error ? error.message : String(error), severity: 'error', timeoutMs: 0 })
      return false
    }
  },

  list: () => Object.values(get().commands),

  isEnabled: (id) => {
    const command = get().commands[id]
    if (!command) return false
    return command.enabled ? command.enabled() : true
  }
}))

export function executeCommand(id: string, args?: unknown): Promise<boolean> {
  return useCommands.getState().execute(id, args)
}
