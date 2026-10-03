import { create } from 'zustand'
import { DEFAULT_SETTINGS, resolveTheme, type AppInfo, type AppSettings, type ResolvedTheme } from '@logicreader/shared'
import { api } from '../lib/api'
import { applyTheme } from '../theme/apply'
import { resolveLocale, setLocale, type SupportedLocale } from '../i18n'

interface SettingsState {
  settings: AppSettings
  appInfo: AppInfo | null
  systemPrefersDark: boolean
  resolvedTheme: ResolvedTheme
  readerTheme: ResolvedTheme
  locale: SupportedLocale
  ready: boolean
  init: () => Promise<void>
  patch: (patch: unknown) => Promise<void>
  reset: () => Promise<void>
  setSystemPrefersDark: (value: boolean) => void
  refresh: () => Promise<void>
}

function computeReaderTheme(settings: AppSettings, resolved: ResolvedTheme): ResolvedTheme {
  if (settings.readerThemeOverride === 'inherit') return resolved
  return settings.readerThemeOverride
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS },
  appInfo: null,
  systemPrefersDark: true,
  resolvedTheme: 'dark',
  readerTheme: 'dark',
  locale: 'zh-CN',
  ready: false,

  init: async () => {
    const [settings, appInfo] = await Promise.all([api.settings.all(), api.app.info()])
    const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const resolved = resolveTheme(settings.theme, systemPrefersDark)
    const locale = resolveLocale(settings.locale, appInfo.locale)
    const readerTheme = computeReaderTheme(settings, resolved)
    applyTheme(resolved, readerTheme)
    setLocale(locale)
    void api.app.setUiScale(settings.uiScale)
    set({ settings, appInfo, systemPrefersDark, resolvedTheme: resolved, readerTheme, locale, ready: true })

    api.settings.onChange((next) => {
      const sysDark = get().systemPrefersDark
      const r = resolveTheme(next.theme, sysDark)
      const loc = resolveLocale(next.locale, get().appInfo?.locale ?? 'zh-CN')
      const rt = computeReaderTheme(next, r)
      applyTheme(r, rt)
      setLocale(loc)
      void api.app.setUiScale(next.uiScale)
      set({ settings: next, resolvedTheme: r, readerTheme: rt, locale: loc })
    })

    api.theme.onSystemChange((_theme, prefersDark) => {
      get().setSystemPrefersDark(prefersDark)
    })

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
      get().setSystemPrefersDark(event.matches)
    })
  },

  patch: async (patch) => {
    const next = await api.settings.patch(patch)
    const sysDark = get().systemPrefersDark
    const resolved = resolveTheme(next.theme, sysDark)
    const readerTheme = computeReaderTheme(next, resolved)
    applyTheme(resolved, readerTheme)
    set({ settings: next, resolvedTheme: resolved, readerTheme })
  },

  reset: async () => {
    const next = await api.settings.reset()
    const sysDark = get().systemPrefersDark
    const resolved = resolveTheme(next.theme, sysDark)
    applyTheme(resolved, computeReaderTheme(next, resolved))
    set({ settings: next, resolvedTheme: resolved, readerTheme: computeReaderTheme(next, resolved) })
  },

  setSystemPrefersDark: (value) => {
    const settings = get().settings
    const resolved = resolveTheme(settings.theme, value)
    const readerTheme = computeReaderTheme(settings, resolved)
    applyTheme(resolved, readerTheme)
    set({ systemPrefersDark: value, resolvedTheme: resolved, readerTheme })
  },

  refresh: async () => {
    const settings = await api.settings.all()
    set({ settings })
  }
}))

/** 便捷读取当前设置（非响应式）。 */
export function currentSettings(): AppSettings {
  return useSettings.getState().settings
}
