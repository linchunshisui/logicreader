/**
 * 会话快照的恢复与保存（规划书 §5.9）。
 * 恢复顺序：布局 → 标签骨架 → 逐标签恢复文档 → 状态栏汇总。
 */
import {
  emptyLayout,
  type SessionSnapshot,
  type WindowSnapshot
} from '@logicreader/shared'
import { api } from '../lib/api'
import { useLayout } from './layout.store'
import { useTabs, type EditorGroupState } from './tabs.store'
import { useTabIssues } from './tabIssues.store'
import { useDocuments } from './documents.store'
import { notify } from './notifications.store'

let lastSnapshot: SessionSnapshot | null = null
let restoreReportCrashed = false

export function getLastSnapshot(): SessionSnapshot | null {
  return lastSnapshot
}

export interface RestoreOutcome {
  restored: boolean
  crashed: boolean
  recoveredFromBackup: boolean
  tabs: number
  positions: number
  drafts: number
  missing: number
}

export async function restoreSession(): Promise<RestoreOutcome> {
  const outcome: RestoreOutcome = {
    restored: false,
    crashed: false,
    recoveredFromBackup: false,
    tabs: 0,
    positions: 0,
    drafts: 0,
    missing: 0
  }
  let report: Awaited<ReturnType<typeof api.session.load>> = null
  try {
    report = await api.session.load()
  } catch {
    report = null
  }
  if (!report) return outcome

  lastSnapshot = report.snapshot
  restoreReportCrashed = report.crashed
  outcome.crashed = report.crashed
  outcome.recoveredFromBackup = report.recoveredFromBackup

  const win: WindowSnapshot | undefined = report.snapshot.windows[0]
  if (!win) return outcome

  useLayout.getState().restore(win.layout ?? emptyLayout())
  const groups: EditorGroupState[] = (win.layout?.editorGroups ?? []).map((g) => ({
    id: g.id,
    tabs: g.tabs,
    activeIndex: Math.max(0, Math.min(g.activeTabIndex ?? 0, g.tabs.length - 1))
  }))
  if (groups.length > 0) {
    useTabs.getState().setGroups(groups, win.layout.activeGroupId ?? groups[0].id)
  }
  outcome.restored = true

  if (groups.every((g) => g.tabs.length === 0)) {
    useTabs.getState().openTab({ kind: 'welcome', id: 'welcome-1' })
  }

  const readerTabs = groups.flatMap((g) => g.tabs.filter((t) => t.kind === 'reader'))
  outcome.tabs = readerTabs.length
  outcome.positions = readerTabs.filter((t) => t.kind === 'reader' && t.view.page > 1).length

  // 并行恢复文档（标签先显示骨架占位）
  await Promise.all(
    readerTabs.map(async (tab) => {
      if (tab.kind !== 'reader') return
      try {
        const exists = await api.fs.exists(tab.filePath)
        if (!exists) {
          outcome.missing += 1
          useTabIssues.getState().set(tab.id, { kind: 'missing', filePath: tab.filePath })
          return
        }
        await api.fs.watch(tab.filePath)
        const result = await useDocuments.getState().open(tab.filePath)
        if (!result) {
          useTabIssues.getState().set(tab.id, { kind: 'error', filePath: tab.filePath })
          return
        }
        useTabIssues.getState().clear(tab.id)
        useTabs.getState().updateTab(tab.id, { docId: result.docId, title: result.model.title } as never)
        if (result.stale > 0) {
          notify(
            '文档已在外部更新，' + result.relocated + ' 处位置已重定位，' + result.stale + ' 处无法定位',
            'warning'
          )
        }
      } catch (error) {
        outcome.missing += 1
        useTabIssues.getState().set(tab.id, {
          kind: 'error',
          filePath: tab.filePath,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    })
  )

  return outcome
}

export function reportRestoreOutcome(outcome: RestoreOutcome): void {
  if (!outcome.restored) return
  if (outcome.crashed) {
    notify('上次异常退出，已恢复到最近一次快照', 'warning')
  }
  if (outcome.missing > 0) {
    notify('有 ' + outcome.missing + ' 个标签的文件未找到，可在标签页内重新定位', 'warning')
  }
}

/** 组装当前窗口的 layout 快照。 */
export function buildLayoutSnapshot() {
  const layout = useLayout.getState().serialize()
  const tabs = useTabs.getState()
  return {
    sidebar: layout.sidebar,
    auxBar: layout.auxBar,
    panel: layout.panel,
    zenMode: layout.zenMode,
    activeGroupId: tabs.activeGroupId,
    editorGroups: tabs.groups.map((g) => ({
      id: g.id,
      activeTabIndex: g.activeIndex,
      tabs: g.tabs
    }))
  }
}

export function saveLayoutSnapshot(immediate = false): void {
  const layout = buildLayoutSnapshot()
  void api.session.save({ windows: [{ layout }] }).catch(() => undefined)
  if (immediate) void api.session.flush('key-action').catch(() => undefined)
}
