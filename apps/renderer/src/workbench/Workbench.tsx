import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useLayout } from '../state/layout.store'
import { useTabs } from '../state/tabs.store'
import { useSettings } from '../state/settings.store'
import { saveLayoutSnapshot } from '../state/session'
import { api } from '../lib/api'
import { notify } from '../state/notifications.store'
import { useTabIssues } from '../state/tabIssues.store'
import { useDocuments } from '../state/documents.store'
import { openFileInWorkbench } from '../commands'
import { TitleBar } from './TitleBar'
import { ActivityBar } from './ActivityBar'
import { SideBar } from './SideBar'
import { AuxBar } from './AuxBar'
import { EditorArea } from './EditorArea'
import { PanelArea } from './PanelArea'
import { StatusBar } from './StatusBar'
import { ResizeHandle } from './ResizeHandle'

/** 各面板尺寸边界（与 layout.store 的钳制保持一致） */
const MIN_SIDEBAR = 120
const MAX_SIDEBAR = 520
const MIN_AUX = 240
const MAX_AUX = 900
const MIN_PANEL = 80
const MAX_PANEL = 800

/**
 * 拖拽性能指标（冒烟自检用）。
 *
 * 存在的意义：`Workbench` 的渲染次数是**订阅了 layout store 才会发生**的 ——
 * 只要拖拽期间这个数字是 0、松手后是 1，就说明"每帧重渲染整棵树"这个卡顿源真的被切断了。
 * 这比"拖起来感觉顺不顺"可靠得多。
 */
interface DragMetrics {
  renders: number
  storeUpdates: number
}
const metrics = ((globalThis as unknown as { __lrDragMetrics?: DragMetrics }).__lrDragMetrics ??= {
  renders: 0,
  storeUpdates: 0
})
const dragMetrics: DragMetrics = metrics
// store 订阅次数：只在挂载时挂一次，与渲染计数分开统计，便于区分"谁在触发重渲染"
useLayout.subscribe(() => {
  dragMetrics.storeUpdates += 1
})

/**
 * 拖拽期间改尺寸的**唯一**入口：只写 CSS 变量，不碰 React 状态。
 *
 * 为什么这么做：`Workbench` 订阅了整个 layout store，以前每个 `pointermove` 都
 * `setState(width + delta)`，于是整棵树（含 Agent 消息流几百个节点）重渲染 ——
 * 拖起来就是"跟不上手"的卡顿。现在拖拽只让布局引擎重排，
 * 松手（onResizeEnd）才把最终值提交进状态，那一次重渲染用户是感觉不到的。
 *
 * 注意这里**不再回读** `offsetWidth`：尺寸由 ResizeHandle 按绝对坐标算好直接传进来。
 * 回读会拿到上一帧的值（布局还没刷新），窗口就会一直慢半拍地追鼠标。
 */
function applySize(element: HTMLElement | null, variable: string, size: number): void {
  if (!element || !Number.isFinite(size)) return
  element.style.setProperty(variable, size + 'px')
}

/** 松手时把变量里的像素值提交进状态（这也是唯一一次落盘） */
function commitWidth(kind: 'sidebar' | 'aux' | 'panel', element: HTMLElement | null): void {
  if (!element) return
  const raw = element.style.getPropertyValue(
    kind === 'sidebar' ? '--lr-sidebar-w' : kind === 'aux' ? '--lr-aux-w' : '--lr-panel-h'
  )
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) return
  const layout = useLayout.getState()
  if (kind === 'sidebar') layout.setSidebarWidth(value)
  else if (kind === 'aux') layout.setAuxWidth(value)
  else layout.setPanelHeight(value)
}

export function Workbench(): JSX.Element {
  dragMetrics.renders += 1
  const { t } = useTranslation()
  const layout = useLayout()
  const tabs = useTabs()
  const { ready } = useSettings()
  const headingRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const auxRef = useRef<HTMLElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // 布局 / 标签变化 → 快照（防抖由主进程负责）
  useEffect(() => {
    if (!ready) return
    saveLayoutSnapshot()
  }, [
    ready,
    layout.sidebarVisible,
    layout.sidebarWidth,
    layout.sidebarView,
    layout.auxVisible,
    layout.auxWidth,
    layout.panelVisible,
    layout.panelHeight,
    layout.panelActiveTab,
    layout.zenMode,
    tabs.groups,
    tabs.activeGroupId
  ])

  /**
   * 状态 → CSS 变量的同步。
   *
   * 只在**尺寸真的变了**时才写（依赖数组已限定为这三个值，且值与上次相同则不写），
   * 所以拖拽期间这条 effect 不会跑；它负责的是复位、切换布局、快照恢复这些"非拖拽"路径。
   */
  useEffect(() => {
    sidebarRef.current?.style.setProperty('--lr-sidebar-w', layout.sidebarWidth + 'px')
  }, [layout.sidebarWidth])

  useEffect(() => {
    auxRef.current?.style.setProperty('--lr-aux-w', layout.auxWidth + 'px')
  }, [layout.auxWidth])

  useEffect(() => {
    panelRef.current?.style.setProperty('--lr-panel-h', layout.panelHeight + 'px')
  }, [layout.panelHeight])

  // 文件被外部修改
  useEffect(() => {
    return api.fs.onChanged(async (event) => {
      const tab = tabs.groups.flatMap((g) => g.tabs).find((item) => item.kind === 'reader' && item.filePath === event.path)
      if (!tab || tab.kind !== 'reader') return
      if (event.kind === 'rename') {
        const stat = await api.fs.stat(event.path)
        if (!stat) {
          useTabIssues.getState().set(tab.id, { kind: 'missing', filePath: event.path })
          notify(t('notifications.fileDeleted', { path: event.path }), 'warning', {
            actions: [
              {
                label: t('editor.relocate'),
                run: async () => {
                  const files = await api.dialog.openFiles()
                  if (files[0]) await useDocuments.getState().open(files[0], { force: true })
                },
                keepOpen: false
              }
            ]
          })
        }
        return
      }
      useTabIssues.getState().set(tab.id, { kind: 'changed', filePath: event.path })
      notify(t('notifications.fileChanged', { name: tab.title }), 'info', {
        timeoutMs: 0,
        actions: [
          {
            label: t('notifications.fileReload'),
            run: async () => {
              await useDocuments.getState().open(event.path, { force: true })
              useTabIssues.getState().clear(tab.id)
            }
          },
          { label: t('common.close'), run: () => useTabIssues.getState().clear(tab.id) }
        ]
      })
    })
  }, [tabs.groups, t])

  // 拖放打开文件
  useEffect(() => {
    const prevent = (event: DragEvent): void => {
      event.preventDefault()
    }
    const onDrop = (event: DragEvent): void => {
      event.preventDefault()
      void (async () => {
        const files = Array.from(event.dataTransfer?.files ?? [])
        for (const file of files) {
          const path = (file as File & { path?: string }).path
          if (path) await openFileInWorkbench(path)
        }
      })()
    }
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  // 主进程送来的"用本应用打开"：先取走启动队列，再订阅后续事件
  useEffect(() => {
    let disposed = false
    void (async () => {
      const pending = await api.app.takePendingFiles().catch(() => [] as string[])
      if (disposed) return
      for (const file of pending) await openFileInWorkbench(file)
    })()
    const unsubscribe = api.app.onOpenFiles((files) => {
      void (async () => {
        for (const file of files) await openFileInWorkbench(file)
      })()
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  return (
    <div className="lr-workbench">
      <TitleBar />
      <div className="lr-workbench__body" ref={headingRef}>
        {!layout.zenMode ? <ActivityBar /> : null}
        {layout.sidebarVisible && !layout.zenMode ? (
          <>
            <SideBar ref={sidebarRef} />
            <ResizeHandle
              direction="vertical"
              target={() => sidebarRef.current}
              min={MIN_SIDEBAR}
              max={MAX_SIDEBAR}
              onResize={(size) => applySize(sidebarRef.current, '--lr-sidebar-w', size)}
              onResizeEnd={() => commitWidth('sidebar', sidebarRef.current)}
              onDoubleClick={() => useLayout.getState().toggleSidebar(false)}
            />
          </>
        ) : null}
        <div className="lr-workbench__center">
          <EditorArea />
          {layout.panelVisible ? (
            <>
              <ResizeHandle
                direction="horizontal"
                anchor="end"
                target={() => panelRef.current}
                min={MIN_PANEL}
                max={MAX_PANEL}
                onResize={(size) => applySize(panelRef.current, '--lr-panel-h', size)}
                onResizeEnd={() => commitWidth('panel', panelRef.current)}
                onDoubleClick={() => useLayout.getState().togglePanel(false)}
              />
              <div
                className="lr-panel-wrap"
                ref={panelRef}
                style={{ height: 'var(--lr-panel-h, ' + layout.panelHeight + 'px)', display: 'flex', flexDirection: 'column', minHeight: 0 }}
              >
                <PanelArea />
              </div>
            </>
          ) : null}
        </div>
        {layout.auxVisible && !layout.zenMode ? (
          <>
            <ResizeHandle
              direction="vertical"
              anchor="end"
              target={() => auxRef.current}
              min={MIN_AUX}
              max={MAX_AUX}
              onResize={(size) => applySize(auxRef.current, '--lr-aux-w', size)}
              onResizeEnd={() => commitWidth('aux', auxRef.current)}
              onDoubleClick={() => useLayout.getState().toggleAuxBar(false)}
            />
            <AuxBar ref={auxRef} />
          </>
        ) : null}
      </div>
      <StatusBar />
      <div className="lr-zen-hint" data-visible={layout.zenMode}>
        {t('common.focusMode')} · Esc 退出
      </div>
    </div>
  )
}
