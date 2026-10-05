import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CMD, basename } from '@logicreader/shared'
import { useLayout } from '../state/layout.store'
import { useSettings } from '../state/settings.store'
import { useTabs } from '../state/tabs.store'
import { useUiStore } from '../state/ui.store'
import { useAgent } from '../state/agent.store'
import { executeCommand } from '../state/commands.store'
import { useDocuments } from '../state/documents.store'

export function StatusBar(): JSX.Element {
  const { t } = useTranslation()
  const layout = useLayout()
  const tabs = useTabs()
  const { settings, resolvedTheme } = useSettings()
  const { readerProgress, selection, statusMessage: message, statusMessageAt } = useUiStore()
  const documents = useDocuments()
  const agent = useAgent()
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

  /*
   * "第 N / M" 的口径由阅读器自己声明（`readerProgress.unit`）：
   * 表格读的是**工作表**，Markdown / DOCX / 纯文本根本没有分页概念 ——
   * 一律按"页"渲染会得到"第 1 / 1 页"这种没人看得懂的东西（表格更糟：两页 Sheet 被叫成两页）。
   */
  const progressLabel =
    readerProgress?.unit === 'sheet'
      ? t('status.sheetOf', { index: readerProgress.page, total: readerProgress.total })
      : readerProgress?.unit === 'page'
        ? t('common.pageOf', { page: readerProgress.page, total: readerProgress.total })
        : null

  /*
   * Agent 项要能回答"现在用的是谁、在不在忙"：
   * 只写一个 "Agent" 的话，用户既看不出当前通道，也看不出它是否正在工作。
   */
  const agentCapability = agent.agents.find((item) => item.id === agent.selectedAgentId)?.capability ?? null
  const agentLabel = agentCapability?.displayName
    ? t('status.agentState', {
        agent: agentCapability.displayName,
        state: agent.streaming ? t('agent.statusWorking') : t('status.agentIdle')
      })
    : t('agent.unavailable')

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
        {progressLabel ? (
          <button
            className="lr-statusbar__item"
            onClick={() => void executeCommand(CMD.gotoPage)}
            title={t('reader.pagePlaceholder')}
          >
            {progressLabel}
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
        {/*
         * 状态栏这一项显示的是**应用主题**，那就应该切应用主题。
         * 它原来点下去执行的是「阅读区主题」（readerThemeOverride）—— 显示与动作对不上：
         * 用户看到"主题：浅色"点一下，结果整个界面的主题没变（变的只有阅读区）。
         * 阅读区主题仍可从命令面板（`cmd.reader.toggleDarkMode`）与设置里改，没有丢。
         */}
        <button
          className="lr-statusbar__item"
          title={t('cmd.workbench.action.toggleLightDarkThemes')}
          onClick={() => void executeCommand(CMD.themeToggleLightDark)}
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
          title={agentCapability?.displayName ?? t('agent.unavailable')}
          data-streaming={agent.streaming}
          onClick={() => void executeCommand(CMD.agentFocusInput)}
        >
          {agentLabel}
        </button>
        {/* 带标签的构建时间：裸时间戳看起来像"停住的时钟"，但它其实是"我跑的是哪份产物" */}
        <span className="lr-statusbar__item lr-statusbar__build">
          {typeof __LR_BUILD__ === 'string' ? t('status.build', { value: __LR_BUILD__ }) : ''}
        </span>

        {layout.zenMode ? <span className="lr-statusbar__item">🧘 {t('common.focusMode')}</span> : null}
      </div>
    </footer>
  )
}
