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
  sidebarView: 'thumbnails' | 'outline' | 'annotations' | 'search'
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
