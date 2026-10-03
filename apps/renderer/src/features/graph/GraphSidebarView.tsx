import { useTranslation } from 'react-i18next'
import { CMD } from '@logicreader/shared'
import { useTabs } from '../../state/tabs.store'
import { executeCommand } from '../../state/commands.store'

export function GraphSidebarView(): JSX.Element {
  const { t } = useTranslation()
  const tabs = useTabs()
  const activeTab = tabs.activeTab()
  const docId = activeTab && activeTab.kind !== 'welcome' && activeTab.kind !== 'settings' ? activeTab.docId : null

  return (
    <div className="lr-view lr-scroll">
      <div className="lr-empty">{t('sideBar.graphEmptyHint')}</div>
      <div className="lr-sidebar-actions">
        {/* 关掉关系图不会关论文，这里就是"再调出来"的入口之一（另有 视图菜单 / Ctrl+Shift+L / 命令面板） */}
        <button className="lr-button" disabled={!docId} onClick={() => void executeCommand(CMD.graphShow, { docId })}>
          {t('graph.show')}
        </button>
        <button className="lr-button lr-button--secondary" disabled={!docId} onClick={() => void executeCommand(CMD.graphGenerate, { docId })}>
          {t('graph.generate')}
        </button>
        <button className="lr-button lr-button--secondary" onClick={() => void executeCommand(CMD.graphImport)}>
          {t('common.import')}
        </button>
      </div>
    </div>
  )
}
