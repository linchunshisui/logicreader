import { create } from 'zustand'
import { createId, type EditorTab, type GraphTab, type ReaderTab } from '@logicreader/shared'

export interface EditorGroupState {
  id: string
  tabs: EditorTab[]
  activeIndex: number
}

interface TabsState {
  groups: EditorGroupState[]
  activeGroupId: string
  /** 关闭历史，用于"重新打开已关闭的编辑器" */
  closed: EditorTab[]

  openTab: (tab: EditorTab, options?: { groupId?: string; activate?: boolean }) => void
  closeTab: (tabId: string) => void
  closeOthers: (tabId: string) => void
  closeAll: () => void
  reopenClosed: () => void
  activate: (tabId: string) => void
  activateIndex: (groupId: string, index: number) => void
  splitGroup: (tabId: string) => void
  moveTab: (tabId: string, targetGroupId: string, index: number) => void
  reorder: (groupId: string, from: number, to: number) => void
  updateTab: (tabId: string, patch: Partial<EditorTab>) => void
  updateReaderView: (tabId: string, patch: Partial<ReaderTab['view']>) => void
  updateGraphView: (tabId: string, patch: Partial<GraphTab['view']>) => void
  findTab: (tabId: string) => EditorTab | null
  findByDoc: (docId: string, kind?: EditorTab['kind']) => EditorTab | null
  activeTab: () => EditorTab | null
  setGroups: (groups: EditorGroupState[], activeGroupId: string) => void
}

function cloneGroups(groups: EditorGroupState[]): EditorGroupState[] {
  return groups.map((g) => ({ ...g, tabs: [...g.tabs] }))
}

function findTabIn(groups: EditorGroupState[], tabId: string): EditorTab | null {
  for (const group of groups) {
    const tab = group.tabs.find((item) => item.id === tabId)
    if (tab) return tab
  }
  return null
}

export const useTabs = create<TabsState>((set, get) => ({
  groups: [{ id: 'g1', tabs: [], activeIndex: 0 }],
  activeGroupId: 'g1',
  closed: [],

  openTab: (tab, options) =>
    set((state) => {
      const groups = cloneGroups(state.groups)
      const groupId = options?.groupId ?? state.activeGroupId
      let group = groups.find((g) => g.id === groupId) ?? groups[0]
      if (!group) {
        group = { id: 'g1', tabs: [], activeIndex: 0 }
        groups.push(group)
      }
      const existingIndex = group.tabs.findIndex((t) => t.id === tab.id)
      if (existingIndex >= 0) {
        group.tabs[existingIndex] = tab
        if (options?.activate !== false) group.activeIndex = existingIndex
      } else {
        group.tabs.push(tab)
        if (options?.activate !== false) group.activeIndex = group.tabs.length - 1
      }
      return { groups, activeGroupId: group.id, closed: state.closed.filter((t) => t.id !== tab.id) }
    }),

  closeTab: (tabId) =>
    set((state) => {
      const groups = cloneGroups(state.groups)
      /**
       * 论文标签与它的关系图是**绑定**的。
       *
       * - 关论文 → 连它的关系图一起关（图离开论文没有意义，留着只会越堆越多；
       *   用户要的是"关闭论文时关闭关系图"）；
       * - 关关系图 → **不动**论文（图只是个视图，随时可以再调出来）。
       *
       * 所以这里只从 reader 出发收集，反向不收集。
       */
      const closing = new Set<string>([tabId])
      const target = findTabIn(groups, tabId)
      if (target?.kind === 'reader') {
        for (const group of groups) {
          for (const tab of group.tabs) {
            if (tab.kind === 'graph' && tab.docId === target.docId) closing.add(tab.id)
          }
        }
      }

      const closedTabs: EditorTab[] = []
      for (const group of groups) {
        const removed = group.tabs.filter((tab) => closing.has(tab.id))
        if (removed.length === 0) continue
        // 用户点名关掉的那个排最前 —— "重新打开已关闭的编辑器"先把它还回来
        removed.sort((a, b) => (a.id === tabId ? -1 : b.id === tabId ? 1 : 0))
        closedTabs.push(...removed)
        group.tabs = group.tabs.filter((tab) => !closing.has(tab.id))
        if (group.activeIndex >= group.tabs.length) group.activeIndex = Math.max(0, group.tabs.length - 1)
      }

      let nextGroups = groups.filter((g) => g.tabs.length > 0)
      if (nextGroups.length === 0) nextGroups = [{ id: 'g1', tabs: [], activeIndex: 0 }]
      const activeGroupId = nextGroups.some((g) => g.id === state.activeGroupId) ? state.activeGroupId : nextGroups[0].id
      return {
        groups: nextGroups,
        activeGroupId,
        closed: closedTabs.length > 0 ? [...closedTabs, ...state.closed].slice(0, 20) : state.closed
      }
    }),

  closeOthers: (tabId) =>
    set((state) => {
      const groups = cloneGroups(state.groups)
      for (const group of groups) {
        const keep = group.tabs.filter((t) => t.id === tabId)
        if (keep.length === 0) continue
        group.tabs = keep
        group.activeIndex = 0
      }
      return { groups: groups.filter((g) => g.tabs.length > 0) }
    }),

  closeAll: () => set({ groups: [{ id: 'g1', tabs: [], activeIndex: 0 }], activeGroupId: 'g1' }),

  reopenClosed: () =>
    set((state) => {
      const [first, ...rest] = state.closed
      if (!first) return state
      const groups = cloneGroups(state.groups)
      const group = groups.find((g) => g.id === state.activeGroupId) ?? groups[0]
      group.tabs.push(first)
      group.activeIndex = group.tabs.length - 1
      return { groups, closed: rest }
    }),

  activate: (tabId) =>
    set((state) => {
      const groups = cloneGroups(state.groups)
      for (const group of groups) {
        const index = group.tabs.findIndex((t) => t.id === tabId)
        if (index >= 0) {
          group.activeIndex = index
          return { groups, activeGroupId: group.id }
        }
      }
      return state
    }),

  activateIndex: (groupId, index) =>
    set((state) => {
      const groups = cloneGroups(state.groups)
      const group = groups.find((g) => g.id === groupId)
      if (!group) return state
      group.activeIndex = Math.max(0, Math.min(index, group.tabs.length - 1))
      return { groups, activeGroupId: groupId }
    }),

  splitGroup: (tabId) =>
    set((state) => {
      const groups = cloneGroups(state.groups)
      let moved: EditorTab | null = null
      for (const group of groups) {
        const index = group.tabs.findIndex((t) => t.id === tabId)
        if (index < 0) continue
        moved = group.tabs[index]
        group.tabs.splice(index, 1)
        if (group.activeIndex >= group.tabs.length) group.activeIndex = Math.max(0, group.tabs.length - 1)
        break
      }
      if (!moved) return state
      const filtered = groups.filter((g) => g.tabs.length > 0)
      const newGroup: EditorGroupState = { id: createId('g'), tabs: [moved], activeIndex: 0 }
      filtered.push(newGroup)
      return { groups: filtered.length > 0 ? filtered : [newGroup], activeGroupId: newGroup.id }
    }),

  moveTab: (tabId, targetGroupId, index) =>
    set((state) => {
      const groups = cloneGroups(state.groups)
      let moved: EditorTab | null = null
      for (const group of groups) {
        const i = group.tabs.findIndex((t) => t.id === tabId)
        if (i < 0) continue
        moved = group.tabs.splice(i, 1)[0]
        if (group.activeIndex >= group.tabs.length) group.activeIndex = Math.max(0, group.tabs.length - 1)
        break
      }
      if (!moved) return state
      const target = groups.find((g) => g.id === targetGroupId)
      if (!target) return state
      target.tabs.splice(Math.max(0, Math.min(index, target.tabs.length)), 0, moved)
      target.activeIndex = target.tabs.findIndex((t) => t.id === moved?.id)
      const filtered = groups.filter((g) => g.tabs.length > 0)
      return { groups: filtered, activeGroupId: targetGroupId }
    }),

  reorder: (groupId, from, to) =>
    set((state) => {
      const groups = cloneGroups(state.groups)
      const group = groups.find((g) => g.id === groupId)
      if (!group) return state
      const [item] = group.tabs.splice(from, 1)
      group.tabs.splice(to, 0, item)
      group.activeIndex = group.tabs.findIndex((t) => t.id === item.id)
      return { groups }
    }),

  updateTab: (tabId, patch) =>
    set((state) => {
      const groups = cloneGroups(state.groups)
      for (const group of groups) {
        const index = group.tabs.findIndex((t) => t.id === tabId)
        if (index >= 0) {
          group.tabs[index] = { ...group.tabs[index], ...patch } as EditorTab
          break
        }
      }
      return { groups }
    }),

  updateReaderView: (tabId, patch) =>
    set((state) => {
      const groups = cloneGroups(state.groups)
      for (const group of groups) {
        const index = group.tabs.findIndex((t) => t.id === tabId)
        if (index >= 0 && group.tabs[index].kind === 'reader') {
          const tab = group.tabs[index] as ReaderTab
          group.tabs[index] = { ...tab, view: { ...tab.view, ...patch } }
          break
        }
      }
      return { groups }
    }),

  updateGraphView: (tabId, patch) =>
    set((state) => {
      const groups = cloneGroups(state.groups)
      for (const group of groups) {
        const index = group.tabs.findIndex((t) => t.id === tabId)
        if (index >= 0 && group.tabs[index].kind === 'graph') {
          const tab = group.tabs[index] as GraphTab
          group.tabs[index] = { ...tab, view: { ...tab.view, ...patch } }
          break
        }
      }
      return { groups }
    }),

  findTab: (tabId) => {
    for (const group of get().groups) {
      const tab = group.tabs.find((t) => t.id === tabId)
      if (tab) return tab
    }
    return null
  },

  findByDoc: (docId, kind) => {
    for (const group of get().groups) {
      for (const tab of group.tabs) {
        if (tab.kind === 'welcome' || tab.kind === 'settings') continue
        if (tab.docId !== docId) continue
        if (kind && tab.kind !== kind) continue
        return tab
      }
    }
    return null
  },

  activeTab: () => {
    const state = get()
    const group = state.groups.find((g) => g.id === state.activeGroupId) ?? state.groups[0]
    if (!group) return null
    return group.tabs[group.activeIndex] ?? null
  },

  setGroups: (groups, activeGroupId) => set({ groups, activeGroupId })
}))
