import { forwardRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useLayout } from '../state/layout.store'
import { ExplorerView } from '../features/explorer/ExplorerView'
import { OutlineView } from '../features/outline/OutlineView'
import { SearchView } from '../features/search/SearchView'
import { GraphSidebarView } from '../features/graph/GraphSidebarView'
import { AgentSidebarView } from '../features/agent/AgentSidebarView'
import { IconClose } from './icons'

const TITLE_KEY: Record<string, string> = {
  explorer: 'sideBar.explorer',
  outline: 'sideBar.outline',
  graph: 'sideBar.graph',
  agent: 'sideBar.agent',
  search: 'sideBar.search'
}

/**
 * 宽度由 Workbench 通过 CSS 变量 `--lr-sidebar-w` 驱动（拖拽期间直接改变量，不重渲染）。
 * 这里**不再**用内联 `style.width`，否则内联样式会盖过变量、拖拽时宽度不动。
 */
export const SideBar = forwardRef<HTMLElement>(function SideBar(_props, ref): JSX.Element {
  const { t } = useTranslation()
  const { sidebarView, toggleSidebar } = useLayout()

  const body = (() => {
    switch (sidebarView) {
      case 'explorer':
        return <ExplorerView />
      case 'outline':
        return <OutlineView />
      case 'search':
        return <SearchView />
      case 'graph':
        return <GraphSidebarView />
      case 'agent':
        return <AgentSidebarView />
      default:
        return null
    }
  })()

  return (
    <aside className="lr-sidebar" ref={ref}>
      <div className="lr-sidebar__header">
        <span>{t(TITLE_KEY[sidebarView] ?? sidebarView)}</span>
        <div className="lr-sidebar__actions">
          <button className="lr-icon-button" title={t('common.close')} onClick={() => toggleSidebar(false)}>
            <IconClose />
          </button>
        </div>
      </div>
      <div className="lr-sidebar__body">{body}</div>
    </aside>
  )
})
