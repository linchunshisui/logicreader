import { create } from 'zustand'

export type TabIssueKind = 'missing' | 'offline' | 'changed' | 'error'

export interface TabIssue {
  kind: TabIssueKind
  filePath: string
  message?: string
}

interface TabIssuesState {
  issues: Record<string, TabIssue>
  set: (tabId: string, issue: TabIssue) => void
  clear: (tabId: string) => void
}

export const useTabIssues = create<TabIssuesState>((set) => ({
  issues: {},
  set: (tabId, issue) => set((state) => ({ issues: { ...state.issues, [tabId]: issue } })),
  clear: (tabId) =>
    set((state) => {
      const issues = { ...state.issues }
      delete issues[tabId]
      return { issues }
    })
}))
