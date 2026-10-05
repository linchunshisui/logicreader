import { useTranslation } from 'react-i18next'
import { useLayout, type SidebarViewId } from '../state/layout.store'
import { useDocuments } from '../state/documents.store'
import { useTabs } from '../state/tabs.store'
import {
  IconAgent, IconFiles, IconGraph, IconOutline, IconSearch, IconSettings
} from './icons'
import { CMD } from '@logicreader/shared'
import { executeCommand } from '../state/commands.store'

interface Item {
  id: SidebarViewId | 'settings'
  titleKey: string
  icon: (props: { size?: number }) => JSX.Element
}

/*
 * 「标注」这一项已下线：标注只存在于 PDF，而阅读器自带的侧栏里已经有一份
 * （缩略图 / 页内标注）—— 同一份数据在左侧出现两个入口，用户看到的是"打开了三列导航"。
 */
const ITEMS: Item[] = [
  { id: 'explorer', titleKey: 'activity.explorer', icon: IconFiles },
  { id: 'search', titleKey: 'activity.search', icon: IconSearch },
  { id: 'outline', titleKey: 'activity.outline', icon: IconOutline },
  { id: 'graph', titleKey: 'activity.graph', icon: IconGraph },
  { id: 'agent', titleKey: 'activity.agent', icon: IconAgent }
]

export function ActivityBar(): JSX.Element {
  const { t } = useTranslation()
  const { sidebarView, sidebarVisible, setSidebarView, toggleSidebar } = useLayout()
  const models = useDocuments((s) => s.models)
  const tabs = useTabs()

  const activeDocId = (() => {
    const group = tabs.groups.find((g) => g.id === tabs.activeGroupId) ?? tabs.groups[0]
    const tab = group?.tabs[group.activeIndex]
    return tab && tab.kind === 'reader' ? tab.docId : null
  })()

  const outlineCount = activeDocId ? models[activeDocId]?.outline.length ?? 0 : 0
  const badges: Partial<Record<string, number>> = {
    outline: outlineCount
  }

  const select = (id: SidebarViewId | 'settings'): void => {
    if (id === 'settings') {
      void executeCommand(CMD.settingsOpen)
      return
    }
    if (sidebarView === id && sidebarVisible) toggleSidebar(false)
    else {
      setSidebarView(id)
      toggleSidebar(true)
    }
  }

  return (
    <nav className="lr-activitybar" aria-label={t('activity.title')}>
      <div className="lr-activitybar__group">
        {ITEMS.map((item) => {
          const Icon = item.icon
          const badge = badges[item.id]
          const active = sidebarView === item.id && sidebarVisible
          return (
            <button
              key={item.id}
              className="lr-activitybar__item"
              data-active={active}
              title={t(item.titleKey)}
              aria-label={t(item.titleKey)}
              onClick={() => select(item.id)}
            >
              <Icon size={22} />
              {badge ? <span className="lr-activitybar__badge">{badge > 99 ? '99+' : badge}</span> : null}
            </button>
          )
        })}
      </div>
      <div className="lr-activitybar__group">
        <button
          className="lr-activitybar__item"
          title={t('activity.settings')}
          aria-label={t('activity.settings')}
          onClick={() => select('settings')}
        >
          <IconSettings size={22} />
        </button>
      </div>
    </nav>
  )
}
