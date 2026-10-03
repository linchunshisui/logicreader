/**
 * ACP 配置项的**取值编码**（纯函数，可单测）。
 *
 * 为什么需要这一层：`session/set_config_option` 的取值形态由 Agent 自己决定，
 * 而我们界面里的选择器只会给出"一个 id"。实测（dsh 0.2.0-rc.2 的 `--profile acp`，
 * 见 scripts/probe-dsh-acp.mjs）：
 *
 * ```
 * configOption model [model]             当前=["deepseek-official","deepseek-v4-flash"]  可选=(空)
 * set_config_option model=deepseek-v4-flash                  ✖ unknown model option
 * set_config_option model=["deepseek-official","deepseek-v4-flash"]  ✅
 * set_config_option reasoning_effort=max                     ✅
 * ```
 *
 * 也就是说 dsh 的 `model` 是一个 **[provider, model] 路由**，提交形态是**这条 JSON 的字符串**
 * （直接传 JSON 数组反而不认）。旧代码把界面给的裸模型名原样发出去，被拒绝后又被客户端
 * 吞成一条 warn —— 用户看到的现象就是"换了模型，一点变化都没有"。
 */

export interface ConfigValueShape {
  id: string
  type?: string
  currentValue?: unknown
}

/** 把 `provider/model`、`provider|model` 或裸 `model` 解析成路由片段。 */
export function parseModelRoute(value: string): { provider: string | null; model: string } {
  const text = value.trim()
  const separator = text.includes('|') ? '|' : text.includes('/') ? '/' : null
  if (!separator) return { provider: null, model: text }
  const index = text.indexOf(separator)
  const provider = text.slice(0, index).trim()
  const model = text.slice(index + 1).trim()
  return { provider: provider.length > 0 ? provider : null, model }
}

/**
 * 取路由片段。两种形态都要认：
 *  - **数组** `["deepseek-official","deepseek-v4-flash"]`；
 *  - **JSON 字符串** `'["deepseek-official","deepseek-v4-flash"]'` —— dsh 0.2 实测回的就是这个
 *    （`String(currentValue)` 打出来带方括号和引号，正是"字符串里装着 JSON"）。
 */
function toRouteArray(value: unknown): string[] | null {
  let list: unknown[] | null = null
  if (Array.isArray(value)) list = value
  else if (typeof value === 'string') {
    const text = value.trim()
    if (text.startsWith('[') && text.endsWith(']')) {
      try {
        const parsed: unknown = JSON.parse(text)
        if (Array.isArray(parsed)) list = parsed
      } catch {
        list = null
      }
    }
  }
  if (!list) return null
  const parts = list.map((item) => String(item ?? '')).filter((item) => item.length > 0)
  return parts.length >= 2 ? parts : null
}

/**
 * 把选择器的值编码成该配置项要的形态。
 * 只对"取值是数组的路由型选项"做转换，其余原样返回 —— 别的 ACP 工具（取值是普通字符串/布尔）不受影响。
 */
export function encodeConfigValue(option: ConfigValueShape, value: string | boolean): string | boolean {
  if (typeof value === 'boolean') return value
  const route = toRouteArray(option.currentValue)
  if (!route) {
    if (option.type === 'boolean') return value === 'true'
    return value
  }
  // 路由型选项：[provider, model]。界面给 `provider/model` 就换 provider，只给模型名就沿用当前 provider。
  const parsed = parseModelRoute(value)
  const provider = parsed.provider ?? route[0]
  const model = parsed.model.length > 0 ? parsed.model : route[route.length - 1]
  return JSON.stringify([provider, model])
}

/**
 * 反向：把配置项的当前值显示成人能读的一行（日志与界面兜底都用它）。
 * 路由型选项显示成 `provider/model`，普通值原样。
 */
export function describeConfigValue(value: unknown): string {
  const route = toRouteArray(value)
  if (route) return route[0] + '/' + route[route.length - 1]
  if (value == null) return ''
  return String(value)
}
