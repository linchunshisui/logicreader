import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CMD } from '@logicreader/shared'
import { Menu, MenuBar, type MenuItem } from './Menu'
import { executeCommand } from '../state/commands.store'
import { useSettings } from '../state/settings.store'
import { useTabs } from '../state/tabs.store'
import { IconLogo } from './icons'

export function TitleBar(): JSX.Element {
  const { t } = useTranslation()
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const { settings, patch } = useSettings()
  const tabs = useTabs()

  const active = tabs.groups
    .flatMap((g) => g.tabs)
    .find((tab) => {
      const group = tabs.groups.find((g) => g.id === tabs.activeGroupId)
      return group?.tabs[group.activeIndex]?.id === tab.id
    })

  const run = (id: string) => () => {
    void executeCommand(id)
  }

  const fileItems: MenuItem[] = [
    { id: 'open', label: t('menu.fileOpen'), shortcut: 'Ctrl+O', run: run(CMD.fileOpen) },
    { id: 'openFolder', label: t('menu.fileOpenFolder'), run: run(CMD.fileOpenFolder) },
    { id: 'sep1', label: '', separator: true },
    { id: 'close', label: t('menu.fileClose'), shortcut: 'Ctrl+W', run: run(CMD.fileClose) },
    { id: 'closeAll', label: t('menu.fileCloseAll'), shortcut: 'Ctrl+K W', run: run(CMD.fileCloseAll) },
    { id: 'sep2', label: '', separator: true },
    { id: 'export', label: t('menu.fileExportAnnotatedPdf'), run: run(CMD.fileExportAnnotatedPdf) },
    { id: 'reveal', label: t('cmd.revealFileInOS'), run: run(CMD.fileRevealInExplorer) },
    { id: 'sep3', label: '', separator: true },
    { id: 'quit', label: t('common.close'), shortcut: 'Alt+F4', run: () => void window.logicreader.app.quit() }
  ]

  const editItems: MenuItem[] = [
    { id: 'undo', label: t('menu.editUndo'), shortcut: 'Ctrl+Z', run: () => document.execCommand('undo') },
    { id: 'redo', label: t('menu.editRedo'), shortcut: 'Ctrl+Y', run: () => document.execCommand('redo') },
    { id: 'sep1', label: '', separator: true },
    { id: 'cut', label: t('menu.editCut'), shortcut: 'Ctrl+X', run: () => document.execCommand('cut') },
    { id: 'copy', label: t('menu.editCopy'), shortcut: 'Ctrl+C', run: () => document.execCommand('copy') },
    { id: 'paste', label: t('menu.editPaste'), shortcut: 'Ctrl+V', run: () => document.execCommand('paste') },
    { id: 'selectAll', label: t('menu.editSelectAll'), shortcut: 'Ctrl+A', run: () => document.execCommand('selectAll') },
    { id: 'sep2', label: '', separator: true },
    { id: 'find', label: t('menu.editFind'), shortcut: 'Ctrl+F', run: run(CMD.readerFind) }
  ]

  const viewItems: MenuItem[] = [
    { id: 'palette', label: t('menu.viewCommandPalette'), shortcut: 'Ctrl+Shift+P', run: run(CMD.commandPalette) },
    { id: 'quickOpen', label: t('menu.viewQuickOpen'), shortcut: 'Ctrl+P', run: run(CMD.gotoFile) },
    { id: 'sep1', label: '', separator: true },
    { id: 'graphShow', label: t('graph.show'), shortcut: 'Ctrl+Shift+L', run: run(CMD.graphShow) },
    { id: 'sepGraph', label: '', separator: true },
    { id: 'sidebar', label: t('menu.viewToggleSidebar'), shortcut: 'Ctrl+B', run: run(CMD.viewToggleSidebar) },
    { id: 'auxbar', label: t('menu.viewToggleAuxBar'), shortcut: 'Ctrl+Alt+B', run: run(CMD.viewToggleAuxBar) },
    { id: 'panel', label: t('menu.viewTogglePanel'), shortcut: 'Ctrl+J', run: run(CMD.viewTogglePanel) },
    { id: 'sep2', label: '', separator: true },
    { id: 'themeToggle', label: t('menu.viewTheme') + '：' + (settings.theme === 'dark' ? t('settings.appearance.themeDark') : settings.theme === 'light' ? t('settings.appearance.themeLight') : t('settings.appearance.themeSystem')), shortcut: 'Ctrl+K Ctrl+T', run: run(CMD.themeToggleLightDark) },
    { id: 'pdfDark', label: t('reader.darkMode.label'), shortcut: 'Ctrl+K Ctrl+D', run: run(CMD.themeCyclePdfDark) },
    { id: 'zen', label: t('menu.viewToggleZen'), run: run(CMD.viewToggleZen) },
    { id: 'fullscreen', label: t('menu.viewFullScreen'), shortcut: 'F11', run: run(CMD.viewToggleFullScreen) },
    { id: 'sep3', label: '', separator: true },
    { id: 'layout', label: t('cmd.workbench.action.resetLayout'), run: run(CMD.viewResetLayout) }
  ]

  const agentItems: MenuItem[] = [
    { id: 'newSession', label: t('menu.agentNewSession'), shortcut: 'Ctrl+Shift+A', run: run(CMD.agentNewSession) },
    { id: 'ask', label: t('menu.agentAskSelection'), shortcut: 'Ctrl+Shift+Q', run: run(CMD.agentAskSelection) },
    { id: 'sep1', label: '', separator: true },
    { id: 'graph', label: t('graph.generate'), shortcut: 'Ctrl+Shift+G', run: run(CMD.graphGenerate) },
    { id: 'manager', label: t('menu.agentManager'), run: run(CMD.agentManager) },
    { id: 'sep2', label: '', separator: true },
    { id: 'mode', label: t('agent.mode') + '：' + (settings.agent.allowWrite ? t('settings.agent.allowWrite') : t('settings.agent.allowExecute')), run: run(CMD.agentToggleMode) }
  ]

  const helpItems: MenuItem[] = [
    { id: 'shortcuts', label: t('menu.helpShortcuts'), shortcut: 'Ctrl+K Ctrl+S', run: run(CMD.helpShortcuts) },
    { id: 'settings', label: t('settings.title'), shortcut: 'Ctrl+,', run: run(CMD.settingsOpen) },
    { id: 'logs', label: t('cmd.workbench.action.showLogs'), run: run(CMD.logShow) },
    { id: 'sep1', label: '', separator: true },
    { id: 'devtools', label: t('cmd.workbench.action.toggleDevTools'), shortcut: 'Ctrl+Shift+I', run: run(CMD.developerToggleDevTools) },
    { id: 'reload', label: t('cmd.workbench.action.reloadWindow'), shortcut: 'Ctrl+R', run: run(CMD.developerReload) },
    { id: 'sep2', label: '', separator: true },
    { id: 'about', label: t('menu.helpAbout'), run: run(CMD.helpAbout) }
  ]

  const toggleMenu = (id: string) => (value: boolean) => setOpenMenu(value ? id : null)

  const theme = settings.theme

  return (
    <header className="lr-titlebar">
      <div className="lr-titlebar__logo">
        <IconLogo className="lr-titlebar__logo-mark" />
        <span>LogicReader</span>
      </div>
      <MenuBar>
        <Menu label={t('menu.file')} items={fileItems} open={openMenu === 'file'} onOpenChange={toggleMenu('file')} />
        <Menu label={t('menu.edit')} items={editItems} open={openMenu === 'edit'} onOpenChange={toggleMenu('edit')} />
        <Menu label={t('menu.view')} items={viewItems} open={openMenu === 'view'} onOpenChange={toggleMenu('view')} />
        <Menu label={t('menu.agent')} items={agentItems} open={openMenu === 'agent'} onOpenChange={toggleMenu('agent')} />
        <Menu label={t('menu.help')} items={helpItems} open={openMenu === 'help'} onOpenChange={toggleMenu('help')} />
      </MenuBar>
      <div className="lr-titlebar__title">
        {active ? String((active as { title?: string }).title ?? '') + ' — LogicReader' : t('app.tagline')}
      </div>
      <div className="lr-titlebar__right">
        <button
          className="lr-titlebar__chip"
          title={t('settings.appearance.theme')}
          onClick={() => void patch({ theme: theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark' })}
        >
          {theme === 'dark' ? '🌙' : theme === 'light' ? '☀️' : '🖥️'}
        </button>
      </div>
    </header>
  )
}
