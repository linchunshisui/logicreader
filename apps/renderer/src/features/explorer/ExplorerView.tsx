import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { basename, type RecentEntry } from '@logicreader/shared'
import { api } from '../../lib/api'
import { useTabs } from '../../state/tabs.store'
import { openFileInWorkbench } from '../../commands'
import { IconFile, IconFolderOpen } from '../../workbench/icons'
import { CMD } from '@logicreader/shared'
import { executeCommand } from '../../state/commands.store'

export function ExplorerView(): JSX.Element {
  const { t } = useTranslation()
  const tabs = useTabs()
  const [recent, setRecent] = useState<RecentEntry[]>([])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  useEffect(() => {
    void api.fs.recent().then(setRecent).catch(() => undefined)
  }, [tabs.groups])

  const toggle = (key: string): void => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))

  return (
    <div className="lr-view lr-scroll">
      <Section
        title={t('sideBar.openEditors')}
        collapsed={collapsed.openEditors}
        onToggle={() => toggle('openEditors')}
        actions={
          <button className="lr-icon-button" title={t('welcome.openFile')} onClick={() => executeCommand(CMD.fileOpen)}>
            +
          </button>
        }
      >
        {tabs.groups.every((g) => g.tabs.length === 0) ? (
          <div className="lr-empty">{t('sideBar.noOpenEditors')}</div>
        ) : (
          tabs.groups.map((group) =>
            group.tabs.map((tab) => (
              <button
                key={tab.id}
                className="lr-tree__row"
                data-active={group.id === tabs.activeGroupId && group.tabs[group.activeIndex]?.id === tab.id}
                onClick={() => tabs.activate(tab.id)}
                title={tab.kind === 'reader' ? tab.filePath : undefined}
              >
                <span className="lr-tree__chevron">
                  <IconFile />
                </span>
                <span className="lr-tree__label">
                  {tab.kind === 'reader'
                    ? tab.title || basename(tab.filePath)
                    : tab.kind === 'graph'
                      ? t('tab.graph')
                      : tab.kind === 'settings'
                        ? t('tab.settings')
                        : t('tab.welcome')}
                </span>
              </button>
            ))
          )
        )}
      </Section>

      <Section title={t('sideBar.recent')} collapsed={collapsed.recent} onToggle={() => toggle('recent')}>
        {recent.length === 0 ? (
          <div className="lr-empty">{t('sideBar.noRecent')}</div>
        ) : (
          recent.map((entry) => (
            <button
              key={entry.path}
              className="lr-tree__row"
              title={entry.path}
              onClick={() => void openFileInWorkbench(entry.path)}
            >
              <span className="lr-tree__chevron">
                <IconFolderOpen />
              </span>
              <span className="lr-tree__label">{entry.title || basename(entry.path)}</span>
              <span className="lr-tree__meta">{entry.path.split(/[\\/]/).slice(-2, -1)[0] ?? ''}</span>
            </button>
          ))
        )}
      </Section>
    </div>
  )
}

export function Section({
  title,
  children,
  collapsed,
  onToggle,
  actions
}: {
  title: string
  children: React.ReactNode
  collapsed?: boolean
  onToggle?: () => void
  actions?: React.ReactNode
}): JSX.Element {
  return (
    <div className="lr-section">
      <div className="lr-section__header" onClick={onToggle}>
        <span className="lr-tree__chevron">{collapsed ? '▸' : '▾'}</span>
        <span>{title}</span>
        <div style={{ flex: 1 }} />
        {actions}
      </div>
      {collapsed ? null : <div className="lr-section__body lr-tree">{children}</div>}
    </div>
  )
}
