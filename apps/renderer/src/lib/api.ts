import type { LogicReaderApi } from '@logicreader/shared'

/**
 * 渲染进程访问主进程能力的唯一入口。
 * 在浏览器（无 preload）环境下给出显式报错，避免静默失败。
 */
function getApi(): LogicReaderApi {
  const api = (window as unknown as { logicreader?: LogicReaderApi }).logicreader
  if (!api) {
    throw new Error('preload API 不可用：请通过 Electron 启动本应用')
  }
  return api
}

export const api: LogicReaderApi = new Proxy({} as LogicReaderApi, {
  get(_target, prop: string) {
    return (getApi() as unknown as Record<string, unknown>)[prop]
  }
})

export function hasApi(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { logicreader?: unknown }).logicreader)
}
