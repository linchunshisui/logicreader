import { create } from 'zustand'
import { emptyLayout, type LayoutSnapshot } from '@logicreader/shared'

export type SidebarViewId = 'explorer' | 'outline' | 'graph' | 'agent' | 'annotations' | 'search'
export type PanelTabId = 'output' | 'problems' | 'log' | 'graph-log' | 'terminal'

interface LayoutState {
  sidebarVisible: boolean
  sidebarWidth: number
  sidebarView: SidebarViewId
  sidebarViewState: Record<string, unknown>
  auxVisible: boolean
  auxWidth: number
  auxView: string
  panelVisible: boolean
  panelHeight: number
  panelTabs: string[]
  panelActiveTab: string
  zenMode: boolean
  activeGroupId: string

  toggleSidebar: (force?: boolean) => void
  toggleAuxBar: (force?: boolean) => void
  togglePanel: (force?: boolean) => void
  toggleZenMode: () => void
  setSidebarView: (view: SidebarViewId) => void
  setSidebarWidth: (width: number) => void
  setAuxWidth: (width: number) => void
  setPanelHeight: (height: number) => void
  setAuxView: (view: string) => void
  setPanelActiveTab: (tab: string) => void
  setActiveGroup: (groupId: string) => void
  setSidebarViewState: (key: string, value: unknown) => void
  resetLayout: () => void
  serialize: () => LayoutSnapshot
  restore: (snapshot: Partial<LayoutSnapshot>) => void
}

const MIN_SIDEBAR = 170
const MAX_SIDEBAR = 720

const defaults = emptyLayout()

export const useLayout = create<LayoutState>((set, get) => ({
  sidebarVisible: defaults.sidebar.visible,
  sidebarWidth: defaults.sidebar.width,
  sidebarView: defaults.sidebar.activeView as SidebarViewId,
  sidebarViewState: {},
  auxVisible: defaults.auxBar.visible,
  auxWidth: defaults.auxBar.width,
  auxView: defaults.auxBar.activeView,
  panelVisible: defaults.panel.visible,
  panelHeight: defaults.panel.height,
  panelTabs: defaults.panel.tabs,
  panelActiveTab: defaults.panel.activeTab,
  zenMode: false,
  activeGroupId: defaults.activeGroupId,

  toggleSidebar: (force) => set((s) => ({ sidebarVisible: force ?? !s.sidebarVisible })),
  toggleAuxBar: (force) => set((s) => ({ auxVisible: force ?? !s.auxVisible })),
  togglePanel: (force) => set((s) => ({ panelVisible: force ?? !s.panelVisible })),
  toggleZenMode: () =>
    set((s) => {
      const next = !s.zenMode
      return next
        ? { zenMode: true, sidebarVisible: false, auxVisible: false, panelVisible: false }
        : { zenMode: false, sidebarVisible: true, auxVisible: true }
    }),
  setSidebarView: (view) =>
    set((s) => ({ sidebarView: view, sidebarVisible: s.sidebarVisible || true })),
  setSidebarWidth: (width) => set({ sidebarWidth: Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, width)) }),
  setAuxWidth: (width) => set({ auxWidth: Math.min(900, Math.max(240, width)) }),
  setPanelHeight: (height) => set({ panelHeight: Math.min(800, Math.max(80, height)) }),
  setAuxView: (view) => set({ auxView: view }),
  setPanelActiveTab: (tab) => set({ panelActiveTab: tab }),
  setActiveGroup: (groupId) => set({ activeGroupId: groupId }),
  setSidebarViewState: (key, value) =>
    set((s) => ({ sidebarViewState: { ...s.sidebarViewState, [key]: value } })),

  resetLayout: () =>
    set({
      sidebarVisible: true,
      sidebarWidth: 280,
      sidebarView: 'explorer',
      sidebarViewState: {},
      auxVisible: true,
      auxWidth: 420,
      auxView: 'agent',
      panelVisible: false,
      panelHeight: 240,
      panelTabs: ['output', 'problems', 'log'],
      panelActiveTab: 'output',
      zenMode: false
    }),

  serialize: () => {
    const s = get()
    return {
      sidebar: { visible: s.sidebarVisible, width: s.sidebarWidth, activeView: s.sidebarView, viewState: s.sidebarViewState },
      auxBar: { visible: s.auxVisible, width: s.auxWidth, activeView: s.auxView, viewState: {} },
      panel: { visible: s.panelVisible, height: s.panelHeight, tabs: s.panelTabs, activeTab: s.panelActiveTab },
      editorGroups: [],
      activeGroupId: s.activeGroupId,
      zenMode: s.zenMode
    }
  },

  restore: (snapshot) =>
    set((s) => ({
      sidebarVisible: snapshot.sidebar?.visible ?? s.sidebarVisible,
      sidebarWidth: snapshot.sidebar?.width ?? s.sidebarWidth,
      sidebarView: (snapshot.sidebar?.activeView as SidebarViewId) ?? s.sidebarView,
      sidebarViewState: snapshot.sidebar?.viewState ?? {},
      auxVisible: snapshot.auxBar?.visible ?? s.auxVisible,
      auxWidth: snapshot.auxBar?.width ?? s.auxWidth,
      auxView: snapshot.auxBar?.activeView ?? s.auxView,
      panelVisible: snapshot.panel?.visible ?? s.panelVisible,
      panelHeight: snapshot.panel?.height ?? s.panelHeight,
      panelTabs: snapshot.panel?.tabs ?? s.panelTabs,
      panelActiveTab: snapshot.panel?.activeTab ?? s.panelActiveTab,
      zenMode: snapshot.zenMode ?? false,
      activeGroupId: snapshot.activeGroupId ?? s.activeGroupId
    }))
}))
