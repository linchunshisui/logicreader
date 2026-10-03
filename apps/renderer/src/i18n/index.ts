import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { zhCN } from './locales/zh-CN'
import { enUS } from './locales/en-US'

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

/** 把任意系统语言映射到受支持的语言。 */
export function normalizeLocale(locale: string | null | undefined): SupportedLocale {
  if (!locale) return 'zh-CN'
  const lower = locale.toLowerCase()
  if (lower.startsWith('zh')) return 'zh-CN'
  if (lower.startsWith('en')) return 'en-US'
  return 'zh-CN'
}

/** 'system' → 使用系统语言；否则使用指定语言。 */
export function resolveLocale(setting: string, systemLocale: string): SupportedLocale {
  if (setting === 'system') return normalizeLocale(systemLocale)
  return normalizeLocale(setting)
}

void i18next.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS }
  },
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  supportedLngs: [...SUPPORTED_LOCALES],
  interpolation: { escapeValue: false },
  returnNull: false,
  react: { useSuspense: false },
  saveMissing: true,
  missingKeyHandler: (lngs, namespace, key) => {
    // 缺失的文案键会打到主进程日志，便于做"中英切换无遗漏"的自检
    const api = (globalThis as { logicreader?: { log: { write: (...args: unknown[]) => Promise<void> } } }).logicreader
    void api?.log.write('warn', 'i18n', '缺少文案键：' + String(lngs) + ' ' + namespace + ' ' + key)
  }
})

export function setLocale(locale: SupportedLocale): void {
  if (i18next.language !== locale) void i18next.changeLanguage(locale)
}

export default i18next
