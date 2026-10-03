/** 主进程侧的语言解析：提示词模板跟随界面语言（规划书 §6.7）。 */
import { app } from 'electron'
import { settingsService } from '../services/settings.service'

export function resolveLocale(): string {
  try {
    const setting = settingsService.all().locale
    if (setting && setting !== 'system') return setting
    return app.getLocale() || 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}

export default resolveLocale
