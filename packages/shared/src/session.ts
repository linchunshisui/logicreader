/**
 * 会话快照（userData/session.json）—— 对应规划书 §5.9.2。
 * 只承载"界面与位置"，内容数据一律在 SQLite 中实时落库。
 */
import type { ContextMode, PdfDarkMode, PdfImagePolicy, ThemeSetting, LocaleSetting } from './settings'
import type { PermissionMode } from './permissions'

export const SESSION_SNAPSHOT_VERSION = 1

export type SnapshotReason = 'quit' | 'interval' | 'crash' | 'key-action'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface ReaderViewState {
  page: number
  anchorId: string | null
  scrollTopRatio: number
  scrollTop: number
  zoom: number | 'fit-width' | 'fit-page' | 'actual'
  viewMode: 'single' | 'continuous' | 'spread'
  rotation: 0 | 90 | 180 | 270
  themeOverride: 'inherit' | 'light' | 'dark'
  pdfDarkMode: PdfDarkMode
  pdfImagePolicy: PdfImagePolicy
  /**
   * PDF 阅读器自带侧栏里两块面板的显隐：缩略图 / 标注。
   *
   * 两块**各自独立、可以同时打开**（用户要求："支持同时存在"），都由工具栏上的按钮唤起；
   * 都关掉时整条侧栏收起（工具栏那一栏是唯一的唤起入口，所以它俩必须常驻可见）。
   * 旧快照只有 `sidebarView`（三选一的页签），读取时按它回落（见 PdfReaderView.normalizeRailPanels）。
   */
  railPanels?: { thumbnails: boolean; annotations: boolean }
  /** @deprecated 旧快照的页签式侧栏；新代码用 railPanels（保留字段只为读得懂老数据） */
  sidebarView?: 'thumbnails' | 'outline' | 'annotations' | 'search'
  expandedOutlineIds: string[]
  activeAnnotationId: string | null
}

export interface GraphViewState {
  viewport: { x: number; y: number; zoom: number }
  layoutMode: 'layered' | 'force' | 'radial'
  selectedNodeIds: string[]
  collapsedClusterIds: string[]
  filters: { edgeKinds: string[]; nodeKinds: string[] }
  searchTerm: string
  /**
   * 浮层的展开状态（质量报告 / 图例）。
   *
   * 默认**都收起**：三个浮层（质量报告 + 图例 + 迷你地图）全开时画布中央被压得没法看图
   * （用户报的"打开关系图时三层浮层全开"）。旧快照没有这个字段，读的时候按"收起"处理。
   */
  overlays?: { quality: boolean; legend: boolean }
}

/**
 * 读取某份阅读器视图的"自带侧栏"面板状态。
 *
 * 旧快照里只有三选一的 `sidebarView`（缩略图 / 目录 / 标注），新形态是**两块可叠加的面板**，
 * 所以读的时候要能翻译老数据：`'annotations'` → 只开标注；其余（缩略图/目录/搜索）→ 只开缩略图。
 *
 * 纯函数、有单测 —— "老快照读出来是什么样"这种事，靠读代码猜迟早出错。
 */
export function railPanelsOf(view: {
  railPanels?: { thumbnails: boolean; annotations: boolean }
  sidebarView?: string
}): { thumbnails: boolean; annotations: boolean } {
  if (view.railPanels) return view.railPanels
  const legacy = view.sidebarView
  return { thumbnails: legacy !== 'annotations', annotations: legacy === 'annotations' }
}

export interface ReaderTab {
  kind: 'reader'
  id: string
  docId: string
  filePath: string
  title: string
  view: ReaderViewState
}

export interface GraphTab {
  kind: 'graph'
  id: string
  docId: string
  graphId: string | null
  title: string
  view: GraphViewState
}

export interface WelcomeTab {
  kind: 'welcome'
  id: string
  title?: string
}

export interface SettingsTab {
  kind: 'settings'
  id: string
  title?: string
}

export type EditorTab = ReaderTab | GraphTab | WelcomeTab | SettingsTab

export interface EditorGroupSnapshot {
  id: string
  activeTabIndex: number
  tabs: EditorTab[]
}

export interface SidebarSnapshot {
  visible: boolean
  width: number
  activeView: string
  viewState: Record<string, unknown>
}

export interface AuxBarSnapshot {
  visible: boolean
  width: number
  activeView: string
  viewState?: Record<string, unknown>
}

export interface PanelSnapshot {
  visible: boolean
  height: number
  tabs: string[]
  activeTab: string
}

export interface LayoutSnapshot {
  sidebar: SidebarSnapshot
  auxBar: AuxBarSnapshot
  panel: PanelSnapshot
  editorGroups: EditorGroupSnapshot[]
  activeGroupId: string
  /** 演示/专注模式 */
  zenMode: boolean
}

export interface AgentDocSnapshot {
  conversationId: string | null
  contextMode: ContextMode
  /** 授权模式（manual / plan / edit / auto）；旧快照缺这一项时按默认值回退 */
  permissionMode?: PermissionMode
  /**
   * **该 Agent 自己那些授权控制项**当前选中的值（如 Codex 的 `approvalPolicy` / `sandbox`）。
   *
   * 与 `permissionMode` 分开：后者是**我们客户端**的放行策略（决定怎么应答 Agent 的授权请求），
   * 前者是各通道协议的原始档位。旧快照没有这一项，按各控制项的默认值回退。
   */
  configValues?: Record<string, string>
  /** 扩展档（可选的更高思考强度），Agent 不支持时为 false */
  ultracode?: boolean
  nodeId: string | null
  agentId: string | null
  modelId: string | null
  thinkingEffort: string | null
  draft: string
  scrollAnchorMessageId: string | null
}

export interface WindowSnapshot {
  bounds: Rect
  maximized: boolean
  fullscreen: boolean
  displayId: string | null
  layout: LayoutSnapshot
  agent: Record<string, AgentDocSnapshot>
}

export interface SessionSnapshot {
  version: number
  savedAt: number
  reason: SnapshotReason
  app: {
    theme: ThemeSetting
    locale: LocaleSetting
    readerThemeOverride: 'inherit' | 'light' | 'dark'
  }
  windows: WindowSnapshot[]
}

export function emptyLayout(): LayoutSnapshot {
  return {
    sidebar: { visible: true, width: 280, activeView: 'explorer', viewState: {} },
    auxBar: { visible: true, width: 420, activeView: 'agent', viewState: {} },
    panel: { visible: false, height: 240, tabs: ['output', 'log', 'problems'], activeTab: 'output' },
    editorGroups: [{ id: 'g1', activeTabIndex: 0, tabs: [{ kind: 'welcome', id: 'welcome-1' }] }],
    activeGroupId: 'g1',
    zenMode: false
  }
}

export function createEmptySnapshot(reason: SnapshotReason = 'interval'): SessionSnapshot {
  return {
    version: SESSION_SNAPSHOT_VERSION,
    savedAt: Date.now(),
    reason,
    app: { theme: 'system', locale: 'system', readerThemeOverride: 'inherit' },
    windows: []
  }
}
