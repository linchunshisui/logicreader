import type { SdkModelInfo } from './sdk'
import type { PermissionControl } from '@logicreader/shared'
import type { ConfigOption, ModelOption } from './types'

/** 界面消费的模型视图（与 packages/shared 的 AgentModelView 对齐）。 */
export interface ModelView {
  id: string
  name: string
  description?: string
  resolvedModel?: string
  supportsEffort?: boolean
  effortLevels?: string[]
  thoughtLevels?: { id: string; name: string }[]
  /** 该模型默认的思考强度档位（Codex 的 `defaultReasoningEffort`；Claude 侧为空） */
  defaultThoughtLevel?: string | null
}

/**
 * SDK 模型条目 → 界面视图。两个出口（会话内 supportedModels / 探测进程）共用，避免两份漂移。
 * 关键一步：把逐模型的 supportedEffortLevels 映射成界面消费的 thoughtLevels ——
 * 不做这层映射时，「真实模型清单」路径上思考强度永远显示「未声明」。
 */
export function mapSdkModel(item: SdkModelInfo): ModelView {
  const id = String(item.value ?? item.resolvedModel ?? item.displayName ?? '')
  const effortLevels = Array.isArray(item.supportedEffortLevels) ? item.supportedEffortLevels.map(String) : undefined
  return {
    id,
    // 显示名优先用真实模型名；没有就退回别名
    name: String(item.displayName ?? item.resolvedModel ?? id),
    description: item.description ? String(item.description) : undefined,
    resolvedModel: item.resolvedModel ? String(item.resolvedModel) : undefined,
    supportsEffort: item.supportsEffort === true,
    effortLevels,
    thoughtLevels: effortLevels && effortLevels.length > 0 ? effortLevels.map((level) => ({ id: level, name: level })) : undefined
  }
}

/**
 * Codex `model/list` 的条目（字段取自官方 app-server 实测报文）。
 * 只声明我们真正消费的字段，其余原样忽略 —— app-server 每次升级都会加字段。
 */
export interface CodexModelInfo {
  id?: string
  model?: string
  displayName?: string
  description?: string
  hidden?: boolean
  isDefault?: boolean
  /** 该模型声明的思考强度档位（id 即提交值） */
  supportedReasoningEfforts?: { reasoningEffort?: string; description?: string }[]
  defaultReasoningEffort?: string | null
}

/**
 * Codex 模型条目 → 界面视图。
 *
 * 与 Claude 那侧的区别：app-server 给的 `id` 就是**真实模型名**（没有别名解析这一层），
 * 所以 `resolvedModel` 留空；思考强度档位由模型自己声明（如 deepseek-flash 给 low/high/max），
 * 不做映射的话界面上永远显示"未声明"。
 */
export function mapCodexModel(item: CodexModelInfo): ModelView {
  const id = String(item.id ?? item.model ?? item.displayName ?? '')
  const levels = (item.supportedReasoningEfforts ?? [])
    .map((level) => (level.reasoningEffort == null ? '' : String(level.reasoningEffort)))
    .filter((level) => level.length > 0)
  return {
    id,
    name: String(item.displayName ?? item.model ?? id),
    description: item.description ? String(item.description) : undefined,
    supportsEffort: levels.length > 0,
    effortLevels: levels.length > 0 ? levels : undefined,
    thoughtLevels:
      levels.length > 0
        ? levels.map((level) => ({
            id: level,
            name: level,
            description: (item.supportedReasoningEfforts ?? []).find((entry) => entry.reasoningEffort === level)?.description
          }))
        : undefined,
    defaultThoughtLevel: item.defaultReasoningEffort ? String(item.defaultReasoningEffort) : null
  }
}

/**
 * 模型清单 → 会话配置项（模型 + 思考强度）。
 *
 * 兜底探测、app-server 探测、SDK 探测三条路共用这一份，
 * 避免"某个入口的模型选择器少一档"这类漂移。
 */
export function buildModelConfigOptions(models: ModelOption[]): ConfigOption[] {
  const options: ConfigOption[] = [
    {
      id: 'model',
      name: '模型',
      category: 'model',
      type: 'select',
      currentValue: models[0]?.id ?? null,
      options: models.map((model) => ({ value: model.id, name: model.name, description: model.description }))
    }
  ]
  const levels = models[0]?.thoughtLevels ?? []
  if (levels.length > 0) {
    options.push({
      id: 'thought_level',
      name: '思考强度',
      category: 'thought_level',
      type: 'select',
      currentValue: models[0]?.defaultThoughtLevel ?? levels[0].id,
      options: levels.map((level) => ({ value: level.id, name: level.name }))
    })
  }
  return options
}

/**
 * 把**通道自己的授权控制项**转成界面能渲染的配置项（`category: 'permission'`）。
 *
 * 与模型/强度那些配置项走同一条通道（探测 → capability.configOptions → 渲染进程），
 * 所以界面不必知道"哪家 Agent 有档位"，只认 `category === 'permission'` 就行。
 *
 * `currentValue` 取控制项**显式声明的默认值**（不是"第一项"：列表按最保守在前排，
 * 而默认值要保住既有行为，两者不一定同一项 —— 理由见 PermissionControl.defaultValue）。
 * 名字与说明由渲染进程按 `agent.permission.<控件 id>.<值>` 本地化，找不到才用这里的协议原文。
 */
export function permissionConfigOptions(controls: PermissionControl[]): ConfigOption[] {
  return controls.map((control) => ({
    id: control.id,
    name: control.name,
    category: 'permission',
    type: 'select',
    currentValue: control.defaultValue,
    options: control.options,
    rebuild: control.rebuild
  }))
}
