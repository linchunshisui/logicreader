import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CMD, basename } from '@logicreader/shared'
import { useLayout } from '../state/layout.store'
import { useSettings } from '../state/settings.store'
import { useTabs } from '../state/tabs.store'
import { useUiStore } from '../state/ui.store'
import { executeCommand } from '../state/commands.store'
import { useDocuments } from '../state/documents.store'

export function StatusBar(): JSX.Element {
  const { t } = useTranslation()
  const layout = useLayout()
  const tabs = useTabs()
  const { settings, resolvedTheme } = useSettings()
  const { readerProgress, selection, statusMessage: message, statusMessageAt } = useUiStore()
  const documents = useDocuments()
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!message) return
    setNow(Date.now())
    const timer = setTimeout(() => setNow(Date.now()), 8000)
    return () => clearTimeout(timer)
  }, [message, statusMessageAt])

  const group = tabs.groups.find((g) => g.id === tabs.activeGroupId) ?? tabs.groups[0]
  const activeTab = group?.tabs[group.activeIndex] ?? null
  const title =
    activeTab && activeTab.kind === 'reader'
      ? activeTab.title || basename(activeTab.filePath)
      : activeTab?.kind === 'graph'
        ? t('graph.title')
        : t('status.noDocument')

  const backend = documents.status

  const showMessage = message && now - statusMessageAt < 8000

  return (
    <footer className="lr-statusbar">
      <div className="lr-statusbar__group">
        <button
          className="lr-statusbar__item"
          title={t('menu.viewToggleSidebar')}
          onClick={() => void executeCommand(CMD.viewToggleSidebar)}
        >
          {title}
        </button>
        {readerProgress ? (
          <button
            className="lr-statusbar__item"
            onClick={() => void executeCommand(CMD.gotoPage)}
            title={t('reader.pagePlaceholder')}
          >
            {t('common.pageOf', { page: readerProgress.page, total: readerProgress.total })}
          </button>
        ) : null}
        {readerProgress ? (
          <button className="lr-statusbar__item" onClick={() => void executeCommand(CMD.readerZoomFitWidth)}>
            {t('status.zoom', { value: Math.round(readerProgress.zoom * 100) + '%' })}
          </button>
        ) : null}
        {selection ? (
          <span className="lr-statusbar__item" title={selection.text.slice(0, 120)}>
            {/* 位置 + 字数都要显示：只有字数时用户无法确认"选中的到底是哪一段" */}
            {selection.locationLabel ? selection.locationLabel + ' · ' : ''}
            {t('status.selection', { count: selection.text.length })}
          </span>
        ) : null}
        {showMessage ? <span className="lr-statusbar__item">{message}</span> : null}
        {Object.values(backend).some((s) => s === 'loading') ? (
          <span className="lr-statusbar__item">{t('reader.loading')}</span>
        ) : null}
      </div>
      <div className="lr-statusbar__group">
        <button
          className="lr-statusbar__item"
          title={t('settings.appearance.readerThemeOverride')}
          onClick={() => void executeCommand(CMD.themeToggleReader)}
        >
          {t('status.theme')}：{resolvedTheme === 'dark' ? t('settings.appearance.themeDark') : t('settings.appearance.themeLight')}
        </button>
        <button
          className="lr-statusbar__item"
          title={t('reader.darkMode.label')}
          onClick={() => void executeCommand(CMD.themeCyclePdfDark)}
        >
          {settings.pdfDarkMode === 'off' ? t('reader.darkMode.off') : settings.pdfDarkMode === 'invert' ? t('reader.darkMode.invert') : t('reader.darkMode.smart')}
        </button>
        <button
          className="lr-statusbar__item"
          title={t('agent.title')}
          onClick={() => void executeCommand(CMD.agentFocusInput)}
        >
          {settings.agent.disabled.length > 0 ? t('agent.unavailable') : t('agent.title')}
        </button>
        <span className="lr-statusbar__item lr-statusbar__build" title="构建时间">
          {typeof __LR_BUILD__ === "string" ? __LR_BUILD__ : ""}
        </span>

        {layout.zenMode ? <span className="lr-statusbar__item">🧘 {t('common.focusMode')}</span> : null}
      </div>
    </footer>
  )
}
