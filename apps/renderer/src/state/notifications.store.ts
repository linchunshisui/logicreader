import { create } from 'zustand'
import { createId } from '@logicreader/shared'

export type NotificationSeverity = 'info' | 'warning' | 'error' | 'success'

export interface NotificationAction {
  label: string
  run: () => void | Promise<void>
  /** 点击后是否关闭通知 */
  keepOpen?: boolean
}

export interface AppNotification {
  id: string
  severity: NotificationSeverity
  message: string
  detail?: string
  actions?: NotificationAction[]
  createdAt: number
  /** 自动关闭毫秒数，0 表示不自动关闭 */
  timeoutMs: number
}

interface NotificationsState {
  items: AppNotification[]
  notify: (input: Omit<AppNotification, 'id' | 'createdAt' | 'timeoutMs'> & { timeoutMs?: number }) => string
  dismiss: (id: string) => void
  clear: () => void
}

export const useNotifications = create<NotificationsState>((set) => ({
  items: [],
  notify: (input) => {
    const id = createId('ntf')
    const timeoutMs = input.timeoutMs ?? (input.severity === 'error' ? 0 : 6000)
    set((state) => ({
      items: [...state.items, { ...input, id, createdAt: Date.now(), timeoutMs }].slice(-6)
    }))
    if (timeoutMs > 0) {
      setTimeout(() => {
        set((state) => ({ items: state.items.filter((n) => n.id !== id) }))
      }, timeoutMs)
    }
    return id
  },
  dismiss: (id) => set((state) => ({ items: state.items.filter((n) => n.id !== id) })),
  clear: () => set({ items: [] })
}))

export function notify(message: string, severity: NotificationSeverity = 'info', extra: Partial<AppNotification> = {}): string {
  return useNotifications.getState().notify({ message, severity, ...extra })
}
