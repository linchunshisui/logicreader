/** 应用设置（非敏感部分存 settings.json，敏感部分存 secrets.bin）。 */

export type LocaleSetting = 'zh-CN' | 'en-US' | 'system'
export type ThemeSetting = 'light' | 'dark' | 'system'
export type PdfDarkMode = 'off' | 'invert' | 'smart'
export type PdfImagePolicy = 'keep' | 'brighten' | 'invert'
export type StartupBehavior = 'restore' | 'welcome' | 'file'
export type GraphPrecision = 'skeleton' | 'structure' | 'panorama' | 'custom'
export type ContextMode = 'fulltext' | 'graph'

export interface AgentSettings {
  /**
   * Agent 的工作目录策略：
   * - `document`：使用文档所在目录（贴近 Claude Code / Codex 常规用法，Agent 能直接读到文档）
   * - `isolated`：使用应用数据目录下的隔离影子目录（更安全，Agent 看不到用户文件）
   */
  workspaceMode: 'document' | 'isolated'
  /** 是否允许 Agent 写文件（默认拒绝） */
  allowWrite: boolean
  /** 是否允许 Agent 执行命令（默认拒绝） */
  allowExecute: boolean
  /** 允许写入的目录白名单 */
  allowedWriteDirs: string[]
  /** 每个 Agent 的默认模型 / 思考强度覆盖 */
  overrides: Record<string, { modelId?: string; thinkingEffort?: string }>
  /** 已禁用的 Agent id */
  disabled: string[]
}

export interface GraphSettings {
  precision: GraphPrecision
  targetNodeLimit: number
  chunkTokens: number
  chunkOverlap: number
  concurrency: number
  entityResolutionThreshold: number
  edgeKinds: string[]
  stageModels: boolean
  mapModelId: string | null
  reduceModelId: string | null
  layout: 'layered' | 'force' | 'radial'
  aggregate: boolean
}

export interface ReaderSettings {
  defaultZoom: 'fit-width' | 'fit-page' | 'actual' | number
  viewMode: 'single' | 'continuous' | 'spread'
  contextParagraphsBefore: number
  contextParagraphsAfter: number
  includeLocationHeader: boolean
  smoothScroll: boolean
}

export interface AppSettings {
  locale: LocaleSetting
  theme: ThemeSetting
  /** 阅读区独立主题覆盖 */
  readerThemeOverride: 'inherit' | 'light' | 'dark'
  pdfDarkMode: PdfDarkMode
  pdfImagePolicy: PdfImagePolicy
  pdfDarkBrightness: number
  startupBehavior: StartupBehavior
  startupFile: string | null
  restoreDraft: boolean
  maxRestoredTabs: number
  /** 会话快照防抖写入间隔（毫秒） */
  snapshotDebounceMs: number
  recentLimit: number
  libreOfficePath: string | null
  agent: AgentSettings
  graph: GraphSettings
  reader: ReaderSettings
  /** 界面缩放的额外系数 */
  uiScale: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  locale: 'system',
  theme: 'system',
  readerThemeOverride: 'inherit',
  pdfDarkMode: 'smart',
  pdfImagePolicy: 'keep',
  pdfDarkBrightness: 1,
  startupBehavior: 'restore',
  startupFile: null,
  restoreDraft: true,
  maxRestoredTabs: 20,
  snapshotDebounceMs: 15000,
  recentLimit: 30,
  libreOfficePath: null,
  agent: {
    workspaceMode: 'document',
    allowWrite: false,
    allowExecute: false,
    allowedWriteDirs: [],
    overrides: {},
    disabled: []
  },
  graph: {
    precision: 'structure',
    targetNodeLimit: 200,
    chunkTokens: 3000,
    chunkOverlap: 0.15,
    concurrency: 3,
    entityResolutionThreshold: 0.88,
    edgeKinds: [
      'causes', 'supports', 'refutes', 'elaborates',
      'contrasts', 'sequences', 'defines', 'references', 'inquiry'
    ],
    stageModels: false,
    mapModelId: null,
    reduceModelId: null,
    layout: 'layered',
    aggregate: true
  },
  reader: {
    defaultZoom: 'fit-width',
    viewMode: 'continuous',
    contextParagraphsBefore: 1,
    contextParagraphsAfter: 1,
    includeLocationHeader: true,
    smoothScroll: true
  },
  uiScale: 1
}

/** 深合并设置补丁，保证新增字段总有默认值。 */
export function mergeSettings(base: AppSettings, patch: unknown): AppSettings {
  return deepMerge(base, patch) as AppSettings
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base
  if (!isPlainObject(base)) return patch as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    const cur = out[k]
    out[k] = isPlainObject(v) && isPlainObject(cur) ? deepMerge(cur, v) : v
  }
  return out as T
}
