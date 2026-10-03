/** 全局命令注册与"打开文件"这一核心流程。 */
import { CMD, basename, describeFormat, isSupported, type EditorTab, type ReaderTab, type ReaderViewState, type GraphTab, type GraphViewState } from '@logicreader/shared'
import { useCommands } from './state/commands.store'
import { useDocuments } from './state/documents.store'
import { useTabs } from './state/tabs.store'
import { useLayout } from './state/layout.store'
import { useSettings } from './state/settings.store'
import { useUiStore } from './state/ui.store'
import { useTabIssues } from './state/tabIssues.store'
import { notify } from './state/notifications.store'
import { api } from './lib/api'
import { createId } from '@logicreader/shared'
import { buildLayoutSnapshot, saveLayoutSnapshot } from './state/session'
import { activeReader, type ReaderController } from './state/readerBridge'
import { useAgent as useAgentStore } from './state/agent.store'
import { useGraph } from './state/graph.store'
import { graphDisplayName } from './lib/graphName'
import i18n from './i18n'

export function defaultReaderView(): ReaderViewState {
  const { settings } = useSettings.getState()
  return {
    page: 1,
    anchorId: null,
    scrollTopRatio: 0,
    scrollTop: 0,
    zoom: settings.reader.defaultZoom,
    viewMode: settings.reader.viewMode,
    rotation: 0,
    themeOverride: 'inherit',
    pdfDarkMode: settings.pdfDarkMode,
    pdfImagePolicy: settings.pdfImagePolicy,
    sidebarView: 'outline',
    expandedOutlineIds: [],
    activeAnnotationId: null
  }
}

export function defaultGraphView(): GraphViewState {
  const { settings } = useSettings.getState()
  return {
    viewport: { x: 0, y: 0, zoom: 1 },
    layoutMode: settings.graph.layout,
    selectedNodeIds: [],
    collapsedClusterIds: [],
    filters: { edgeKinds: [...settings.graph.edgeKinds], nodeKinds: [] },
    searchTerm: ''
  }
}

/** 打开本地文件并复用/创建阅读器标签页。 */
export async function openFileInWorkbench(filePath: string): Promise<string | null> {
  if (!isSupported(filePath)) {
    notify(i18n.t('notifications.openFailed', { message: filePath }), 'error')
    return null
  }
  try {
    const result = await useDocuments.getState().open(filePath)
    if (!result) return null
    const tabs = useTabs.getState()
    const existing = tabs.findByDoc(result.docId, 'reader') as ReaderTab | null
    if (existing) {
      tabs.activate(existing.id)
      tabs.updateTab(existing.id, { title: result.model.title } as never)
      useLayout.getState().setActiveGroup(useTabs.getState().activeGroupId)
      saveLayoutSnapshot(true)
      return existing.id
    }
    const tab: ReaderTab = {
      kind: 'reader',
      id: createId('tab'),
      docId: result.docId,
      filePath,
      title: result.model.title || basename(filePath),
      view: defaultReaderView()
    }
    tabs.openTab(tab)
    useTabIssues.getState().clear(tab.id)
    await api.fs.pushRecent({ path: filePath, title: tab.title })
    useUiStore.getState().setStatusMessage(i18n.t('notifications.opened', { name: tab.title }))
    saveLayoutSnapshot(true)
    return tab.id
  } catch (error) {
    notify(
      i18n.t('notifications.openFailed', { message: error instanceof Error ? error.message : String(error) }),
      'error',
      { timeoutMs: 0 }
    )
    return null
  }
}

/**
 * 打开（或聚焦）某篇论文的关系图标签页。
 *
 * 这是"再次调取关系图"的唯一出口：关掉关系图不会关论文，
 * 需要时用 视图菜单 / 侧边栏「显示关系图」/ Ctrl+Shift+L / 命令面板 再调出来。
 */
export function openGraphTab(docId: string, graphId: string | null = null): string {
  const tabs = useTabs.getState()
  const title = graphDisplayName(docId)
  const existing = tabs.findByDoc(docId, 'graph') as GraphTab | null
  if (existing) {
    tabs.activate(existing.id)
    // 文档名或界面语言可能变了：把标题对齐成当前的显示名
    if (existing.title !== title) tabs.updateTab(existing.id, { title } as never)
    return existing.id
  }
  const tab: GraphTab = {
    kind: 'graph',
    id: createId('tab'),
    docId,
    graphId,
    title,
    view: defaultGraphView()
  }
  tabs.openTab(tab)
  saveLayoutSnapshot(true)
  return tab.id
}

export function openSettingsTab(): void {
  const tabs = useTabs.getState()
  const existing = tabs.groups.flatMap((g) => g.tabs).find((tab) => tab.kind === 'settings')
  if (existing) {
    tabs.activate(existing.id)
    return
  }
  tabs.openTab({ kind: 'settings', id: createId('tab') })
  saveLayoutSnapshot(true)
}

export function activeReaderTab(): ReaderTab | null {
  const tab = useTabs.getState().activeTab()
  return tab && tab.kind === 'reader' ? tab : null
}

export function registerGlobalCommands(): void {
  const commands = useCommands.getState()
  const t = i18n.t.bind(i18n)
  const enabledWithReader = (): boolean => activeReaderTab() !== null

  commands.registerAll([
    {
      id: CMD.fileOpen,
      titleKey: 'cmd.workbench.action.files.openFile',
      categoryKey: 'command.category.file',
      keybinding: 'Ctrl+O',
      run: async () => {
        const files = await api.dialog.openFiles()
        for (const file of files) await openFileInWorkbench(file)
      }
    },
    {
      id: CMD.fileOpenFolder,
      titleKey: 'cmd.workbench.action.files.openFolder',
      categoryKey: 'command.category.file',
      run: async () => {
        const dir = await api.dialog.openFolder()
        if (!dir) return
        const entries = await api.fs.readDir(dir)
        const files = entries.filter((entry) => !entry.isDirectory && isSupported(entry.path)).slice(0, 20)
        for (const file of files) await openFileInWorkbench(file.path)
      }
    },
    {
      id: CMD.fileClose,
      titleKey: 'cmd.workbench.action.closeActiveEditor',
      categoryKey: 'command.category.file',
      keybinding: 'Ctrl+W',
      run: () => {
        const tab = useTabs.getState().activeTab()
        if (tab) useTabs.getState().closeTab(tab.id)
        saveLayoutSnapshot(true)
      }
    },
    {
      id: CMD.fileCloseAll,
      titleKey: 'cmd.workbench.action.closeAllEditors',
      categoryKey: 'command.category.file',
      run: () => {
        useTabs.getState().closeAll()
        saveLayoutSnapshot(true)
      }
    },
    {
      id: CMD.fileReopenClosed,
      titleKey: 'cmd.workbench.action.reopenClosedEditor',
      categoryKey: 'command.category.file',
      run: () => useTabs.getState().reopenClosed()
    },
    {
      id: CMD.fileRevealInExplorer,
      titleKey: 'cmd.revealFileInOS',
      categoryKey: 'command.category.file',
      enabled: enabledWithReader,
      run: () => {
        const tab = activeReaderTab()
        if (tab) void api.fs.reveal(tab.filePath)
      }
    },
    {
      id: CMD.viewToggleSidebar,
      titleKey: 'cmd.workbench.action.toggleSidebarVisibility',
      categoryKey: 'command.category.view',
      keybinding: 'Ctrl+B',
      run: () => useLayout.getState().toggleSidebar()
    },
    {
      id: CMD.viewToggleAuxBar,
      titleKey: 'cmd.workbench.action.toggleAuxiliaryBar',
      categoryKey: 'command.category.view',
      keybinding: 'Ctrl+Alt+B',
      run: () => useLayout.getState().toggleAuxBar()
    },
    {
      id: CMD.viewTogglePanel,
      titleKey: 'cmd.workbench.action.togglePanel',
      categoryKey: 'command.category.view',
      keybinding: 'Ctrl+J',
      run: () => useLayout.getState().togglePanel()
    },
    {
      id: CMD.viewToggleZen,
      titleKey: 'cmd.workbench.action.toggleZenMode',
      categoryKey: 'command.category.view',
      run: () => useLayout.getState().toggleZenMode()
    },
    {
      id: CMD.viewToggleFullScreen,
      titleKey: 'cmd.workbench.action.toggleFullScreen',
      categoryKey: 'command.category.view',
      keybinding: 'F11',
      run: async () => {
        const state = await api.win.state()
        await api.win.setFullScreen(!state.fullscreen)
      }
    },
    {
      id: CMD.viewSplitEditor,
      titleKey: 'cmd.workbench.action.splitEditor',
      categoryKey: 'command.category.view',
      keybinding: 'Ctrl+\\',
      run: () => {
        const tab = useTabs.getState().activeTab()
        if (tab) useTabs.getState().splitGroup(tab.id)
      }
    },
    {
      id: CMD.viewResetLayout,
      titleKey: 'cmd.workbench.action.resetLayout',
      categoryKey: 'command.category.view',
      run: () => useLayout.getState().resetLayout()
    },
    {
      id: CMD.viewZoomIn,
      titleKey: 'cmd.workbench.action.zoomIn',
      categoryKey: 'command.category.view',
      run: async () => {
        const next = Math.min(2, useSettings.getState().settings.uiScale + 0.1)
        await useSettings.getState().patch({ uiScale: Number(next.toFixed(2)) })
      }
    },
    {
      id: CMD.viewZoomOut,
      titleKey: 'cmd.workbench.action.zoomOut',
      categoryKey: 'command.category.view',
      run: async () => {
        const next = Math.max(0.6, useSettings.getState().settings.uiScale - 0.1)
        await useSettings.getState().patch({ uiScale: Number(next.toFixed(2)) })
      }
    },
    {
      id: CMD.viewZoomReset,
      titleKey: 'cmd.workbench.action.zoomReset',
      categoryKey: 'command.category.view',
      run: async () => useSettings.getState().patch({ uiScale: 1 })
    },
    {
      id: CMD.themeToggleLightDark,
      titleKey: 'cmd.workbench.action.toggleLightDarkThemes',
      categoryKey: 'command.category.theme',
      keybinding: 'Ctrl+K Ctrl+T',
      run: async () => {
        const current = useSettings.getState().settings.theme
        const next = current === 'dark' ? 'light' : current === 'light' ? 'dark' : 'dark'
        await useSettings.getState().patch({ theme: next })
      }
    },
    {
      id: CMD.themeSelect,
      titleKey: 'cmd.workbench.action.selectTheme',
      categoryKey: 'command.category.theme',
      run: () => openSettingsTab()
    },
    {
      id: CMD.themeToggleReader,
      titleKey: 'cmd.reader.toggleDarkMode',
      categoryKey: 'command.category.theme',
      run: async () => {
        const current = useSettings.getState().settings.readerThemeOverride
        await useSettings.getState().patch({ readerThemeOverride: current === 'dark' ? 'light' : 'dark' })
      }
    },
    {
      id: CMD.themeCyclePdfDark,
      titleKey: 'cmd.reader.cyclePdfDarkMode',
      categoryKey: 'command.category.theme',
      keybinding: 'Ctrl+K Ctrl+D',
      run: async () => {
        const order = ['smart', 'invert', 'off'] as const
        const current = useSettings.getState().settings.pdfDarkMode
        const next = order[(order.indexOf(current) + 1) % order.length]
        await useSettings.getState().patch({ pdfDarkMode: next })
      }
    },
    {
      id: CMD.commandPalette,
      titleKey: 'cmd.workbench.action.showCommands',
      categoryKey: 'command.category.view',
      keybinding: 'Ctrl+Shift+P',
      run: () => useUiStore.getState().openCommandPalette()
    },
    {
      id: CMD.gotoFile,
      titleKey: 'cmd.workbench.action.quickOpen',
      categoryKey: 'command.category.file',
      keybinding: 'Ctrl+P',
      run: () => useUiStore.getState().openQuickOpen()
    },
    {
      id: CMD.settingsOpen,
      titleKey: 'cmd.workbench.action.openSettings',
      categoryKey: 'command.category.view',
      keybinding: 'Ctrl+,',
      run: () => openSettingsTab()
    },
    {
      id: CMD.logShow,
      titleKey: 'cmd.workbench.action.showLogs',
      categoryKey: 'command.category.view',
      run: () => {
        useLayout.getState().togglePanel(true)
        useLayout.getState().setPanelActiveTab('log')
      }
    },
    {
      id: CMD.outputShow,
      titleKey: 'cmd.workbench.action.output.toggleOutput',
      categoryKey: 'command.category.view',
      run: () => {
        useLayout.getState().togglePanel(true)
        useLayout.getState().setPanelActiveTab('output')
      }
    },
    {
      id: CMD.developerToggleDevTools,
      titleKey: 'cmd.workbench.action.toggleDevTools',
      categoryKey: 'command.category.developer',
      run: () => {
        // 通过快捷键由 Electron 默认处理；此处给出提示
        notify('Ctrl+Shift+I', 'info')
      }
    },
    {
      id: CMD.developerReload,
      titleKey: 'cmd.workbench.action.reloadWindow',
      categoryKey: 'command.category.developer',
      run: () => window.location.reload()
    },
    {
      id: CMD.helpAbout,
      titleKey: 'cmd.workbench.action.showAbout',
      categoryKey: 'command.category.help',
      run: async () => {
        const info = await api.app.info()
        await api.dialog.message({
          type: 'info',
          message: 'LogicReader ' + info.version,
          detail: [
            'Electron ' + info.electron,
            'Chromium ' + info.chrome,
            'Node ' + info.node,
            info.userDataPath
          ].join('\n'),
          buttons: [i18n.t('common.ok')]
        })
      }
    },
    {
      id: CMD.helpShortcuts,
      titleKey: 'cmd.workbench.action.showShortcuts',
      categoryKey: 'command.category.help',
      run: async () => {
        const rows: [string, string][] = [
          [t('shortcuts.commandPalette'), 'Ctrl+Shift+P'],
          [t('shortcuts.quickOpen'), 'Ctrl+P'],
          [t('shortcuts.toggleSidebar'), 'Ctrl+B'],
          [t('shortcuts.togglePanel'), 'Ctrl+J'],
          [t('shortcuts.splitEditor'), 'Ctrl+\\'],
          [t('shortcuts.find'), 'Ctrl+F'],
          [t('shortcuts.nextPage'), 'PgDn / PgUp'],
          [t('shortcuts.zoom'), 'Ctrl+= / Ctrl+- / Ctrl+0'],
          [t('shortcuts.theme'), 'Ctrl+K Ctrl+T'],
          [t('shortcuts.pdfDark'), 'Ctrl+K Ctrl+D'],
          [t('shortcuts.graph'), 'Ctrl+Shift+G'],
          [t('shortcuts.graphShow'), 'Ctrl+Shift+L'],
          [t('shortcuts.agentFocus'), 'Ctrl+Shift+A'],
          [t('shortcuts.send'), 'Enter'],
          [t('shortcuts.stop'), 'Esc'],
          [t('shortcuts.askSelection'), 'Ctrl+Shift+Q']
        ]
        await api.dialog.message({
          type: 'info',
          message: t('shortcuts.title'),
          detail: rows.map(([label, keys]) => label.padEnd(28, ' ') + keys).join('\n'),
          buttons: [t('common.ok')]
        })
      }
    },
    {
      id: CMD.sessionClear,
      titleKey: 'cmd.workbench.action.clearSavedSession',
      categoryKey: 'command.category.session',
      run: async () => {
        const answer = await api.dialog.message({
          type: 'question',
          message: t('dialog.clearSession'),
          buttons: [t('common.confirm'), t('common.cancel')],
          cancelId: 1
        })
        if (answer !== 0) return
        await api.session.clear()
        notify(t('dialog.sessionCleared'), 'success')
      }
    },
    {
      id: CMD.sessionReopenLast,
      titleKey: 'cmd.workbench.action.reopenLastSession',
      categoryKey: 'command.category.session',
      run: async () => {
        const report = await api.session.load()
        const win = report?.snapshot.windows[0]
        if (!win) {
          notify(t('welcome.noRecent'), 'info')
          return
        }
        useLayout.getState().restore(win.layout)
        for (const group of win.layout.editorGroups) {
          for (const tab of group.tabs as EditorTab[]) {
            if (tab.kind === 'reader') await openFileInWorkbench(tab.filePath)
          }
        }
      }
    },
    {
      id: CMD.graphShow,
      titleKey: 'cmd.graph.show',
      categoryKey: 'command.category.graph',
      keybinding: 'Ctrl+Shift+L',
      /**
       * **关掉关系图之后靠它调回来**：阅读器或关系图标签下都能用
       * （图被关掉后当前标签就是论文，正好从这里再开出来）。
       */
      enabled: () => {
        const tab = useTabs.getState().activeTab()
        return Boolean(tab && 'docId' in tab)
      },
      run: (args) => {
        // 侧边栏等入口会显式带 docId；没带就跟随当前标签
        const explicit = (args as { docId?: string } | undefined)?.docId
        const tab = useTabs.getState().activeTab()
        const docId = explicit ?? (tab && 'docId' in tab ? tab.docId : null)
        if (docId) openGraphTab(docId)
      }
    },
    {
      id: CMD.graphGenerate,
      titleKey: 'cmd.graph.generate',
      categoryKey: 'command.category.graph',
      keybinding: 'Ctrl+Shift+G',
      // 阅读器或关系图标签页都可用
      enabled: () => {
        const tab = useTabs.getState().activeTab()
        return Boolean(tab && (tab.kind === 'reader' || tab.kind === 'graph'))
      },
      run: async () => {
        const tab = useTabs.getState().activeTab()
        if (!tab || (tab.kind !== 'reader' && tab.kind !== 'graph')) return
        const docId = tab.docId
        // 1) 打开（或聚焦）该文档的关系图标签页
        openGraphTab(docId)
        // 2) 确认本机确实有可用 Agent；没有才提示去配置
        const agentState = useAgentStore.getState()
        await agentState.init()
        await agentState.refreshAgents(false)
        const available = useAgentStore.getState().agents.filter((item) => item.capability?.available)
        if (available.length === 0) {
          notify(t('agent.notFound'), 'warning', {
            timeoutMs: 0,
            detail: t('agent.unavailableHint'),
            actions: [
              {
                label: t('agent.manager'),
                run: () => {
                  useUiStore.getState().setSettingsCategory('agent')
                  openSettingsTab()
                }
              },
              {
                label: t('settings.agent.probe'),
                run: async () => {
                  await useAgentStore.getState().refreshAgents(true)
                  const now = useAgentStore.getState().agents.filter((item) => item.capability?.available)
                  if (now.length > 0) {
                    notify(t('agent.detected', { count: now.length }), 'success')
                    useGraph.getState().requestGenerate()
                  }
                }
              }
            ]
          })
          return
        }
        // 3) 打开生成配置面板（Agent / 模型 / 思考强度 / 精度）
        useGraph.getState().requestGenerate()
      }
    },
    {
      id: CMD.agentFocusInput,
      titleKey: 'cmd.agent.focusInput',
      categoryKey: 'command.category.agent',
      keybinding: 'Ctrl+Shift+A',
      run: () => {
        useLayout.getState().toggleAuxBar(true)
      }
    },
    {
      id: CMD.agentNewSession,
      titleKey: 'cmd.agent.newSession',
      categoryKey: 'command.category.agent',
      run: () => useLayout.getState().toggleAuxBar(true)
    },
    {
      id: CMD.agentManager,
      titleKey: 'cmd.agent.showManager',
      categoryKey: 'command.category.agent',
      run: () => openSettingsTab()
    },
    {
      id: CMD.readerFind,
      titleKey: 'cmd.reader.find',
      categoryKey: 'command.category.reader',
      keybinding: 'Ctrl+F',
      enabled: enabledWithReader,
      run: () => {
        useLayout.getState().setSidebarView('search')
      }
    }
  ])

  // ------------------------------------------------------------ 阅读器命令
  const reader = (): ReaderController | null => activeReader()
  const readerEnabled = (): boolean => reader() !== null

  commands.registerAll([
    { id: CMD.readerZoomIn, titleKey: 'cmd.reader.zoomIn', categoryKey: 'command.category.reader', enabled: readerEnabled, run: () => reader()?.zoomIn() },
    { id: CMD.readerZoomOut, titleKey: 'cmd.reader.zoomOut', categoryKey: 'command.category.reader', enabled: readerEnabled, run: () => reader()?.zoomOut() },
    { id: CMD.readerZoomFitWidth, titleKey: 'cmd.reader.zoomFitWidth', categoryKey: 'command.category.reader', enabled: readerEnabled, run: () => reader()?.zoomFitWidth() },
    { id: CMD.readerZoomFitPage, titleKey: 'cmd.reader.zoomFitPage', categoryKey: 'command.category.reader', enabled: readerEnabled, run: () => reader()?.zoomFitPage() },
    { id: CMD.readerZoomActual, titleKey: 'cmd.reader.zoomActual', categoryKey: 'command.category.reader', enabled: readerEnabled, run: () => reader()?.zoomActual() },
    { id: CMD.readerRotate, titleKey: 'cmd.reader.rotateClockwise', categoryKey: 'command.category.reader', enabled: readerEnabled, run: () => reader()?.rotate() },
    { id: CMD.readerViewSingle, titleKey: 'cmd.reader.viewMode.single', categoryKey: 'command.category.reader', enabled: readerEnabled, run: () => reader()?.setViewMode('single') },
    { id: CMD.readerViewContinuous, titleKey: 'cmd.reader.viewMode.continuous', categoryKey: 'command.category.reader', enabled: readerEnabled, run: () => reader()?.setViewMode('continuous') },
    { id: CMD.readerViewSpread, titleKey: 'cmd.reader.viewMode.spread', categoryKey: 'command.category.reader', enabled: readerEnabled, run: () => reader()?.setViewMode('spread') },
    { id: CMD.nextPage, titleKey: 'cmd.reader.nextPage', categoryKey: 'command.category.reader', keybinding: 'PgDn', enabled: readerEnabled, run: () => reader()?.nextPage() },
    { id: CMD.prevPage, titleKey: 'cmd.reader.previousPage', categoryKey: 'command.category.reader', keybinding: 'PgUp', enabled: readerEnabled, run: () => reader()?.previousPage() },
    { id: CMD.gotoPage, titleKey: 'cmd.reader.gotoPage', categoryKey: 'command.category.reader', enabled: readerEnabled, run: () => reader()?.openFind() },
    { id: CMD.readerFindNext, titleKey: 'cmd.reader.findNext', categoryKey: 'command.category.reader', enabled: readerEnabled, run: () => reader()?.findNext() },
    { id: CMD.readerFindPrevious, titleKey: 'cmd.reader.findPrevious', categoryKey: 'command.category.reader', enabled: readerEnabled, run: () => reader()?.findPrevious() },
    // 高亮入口已停用：不注册命令，命令面板里也就不会出现（功能上等同"没有高亮"）
    // { id: CMD.readerAddHighlight, titleKey: 'cmd.reader.annotation.highlight', ... }
    { id: CMD.readerAddUnderline, titleKey: 'cmd.reader.annotation.underline', categoryKey: 'command.category.reader', enabled: readerEnabled, run: () => reader()?.addAnnotation('underline') },
    { id: CMD.readerAddStrike, titleKey: 'cmd.reader.annotation.strike', categoryKey: 'command.category.reader', enabled: readerEnabled, run: () => reader()?.addAnnotation('strike') },
    { id: CMD.readerAddNote, titleKey: 'cmd.reader.annotation.note', categoryKey: 'command.category.reader', enabled: readerEnabled, run: () => reader()?.addAnnotation('note') },
    { id: CMD.readerAddRect, titleKey: 'cmd.reader.annotation.rect', categoryKey: 'command.category.reader', enabled: readerEnabled, run: () => reader()?.addAnnotation('rect') },
    { id: CMD.readerAddArrow, titleKey: 'cmd.reader.annotation.arrow', categoryKey: 'command.category.reader', enabled: readerEnabled, run: () => reader()?.addAnnotation('arrow') },
    { id: CMD.readerDeleteAnnotation, titleKey: 'cmd.reader.annotation.delete', categoryKey: 'command.category.reader', enabled: readerEnabled, run: () => reader()?.deleteActiveAnnotation() },
    { id: CMD.readerClearAnnotations, titleKey: 'cmd.reader.annotation.clearAll', categoryKey: 'command.category.reader', enabled: readerEnabled, run: () => reader()?.clearAnnotations() },
    { id: CMD.fileExportAnnotatedPdf, titleKey: 'cmd.reader.exportAnnotatedPdf', categoryKey: 'command.category.file', enabled: readerEnabled, run: () => reader()?.exportAnnotated() },
    {
      // 诊断用：把"文本层 DOM 实测矩形 vs 矢量应有矩形"写进日志，排查选区偏移
      id: CMD.debugTextLayer,
      titleKey: 'cmd.reader.debugTextLayer',
      categoryKey: 'command.category.reader',
      run: () => {
        void import('./lib/textLayerDebug').then((module) => module.dumpTextLayerGeometry())
        return undefined
      }
    },
    {
      id: CMD.agentCopyCitation,
      titleKey: 'cmd.agent.copyCitation',
      categoryKey: 'command.category.agent',
      enabled: readerEnabled,
      run: () => {
        const text = reader()?.copyCitation()
        if (text) notify(i18n.t('agent.copiedCitation'), 'success')
        return undefined
      }
    },
    {
      id: CMD.agentAskSelection,
      titleKey: 'cmd.agent.askFromSelection',
      categoryKey: 'command.category.agent',
      enabled: () => useUiStore.getState().selection !== null,
      run: async () => {
        useLayout.getState().toggleAuxBar(true)
        const { askFromSelection } = await import('./state/askFlow')
        await askFromSelection('ask')
      }
    },
    {
      id: CMD.agentExplainSelection,
      titleKey: 'cmd.agent.explainSelection',
      categoryKey: 'command.category.agent',
      enabled: () => useUiStore.getState().selection !== null,
      run: async () => {
        useLayout.getState().toggleAuxBar(true)
        const { askFromSelection } = await import('./state/askFlow')
        await askFromSelection('explain')
      }
    },
    {
      id: CMD.agentTranslateSelection,
      titleKey: 'cmd.agent.translateSelection',
      categoryKey: 'command.category.agent',
      enabled: () => useUiStore.getState().selection !== null,
      run: async () => {
        useLayout.getState().toggleAuxBar(true)
        const { askFromSelection } = await import('./state/askFlow')
        await askFromSelection('translate')
      }
    },
    {
      id: CMD.agentAddSelectionToGraph,
      titleKey: 'cmd.agent.addSelectionToGraph',
      categoryKey: 'command.category.agent',
      enabled: () => useUiStore.getState().selection !== null,
      run: async () => {
        const { askFromSelection } = await import('./state/askFlow')
        // 问题文本由 askFlow 统一组装（动作名 + **完整**选区文本）
        await askFromSelection('graph')
      }
    },
    {
      id: CMD.agentStop,
      titleKey: 'cmd.agent.stop',
      categoryKey: 'command.category.agent',
      run: () => undefined
    }
  ])

  void buildLayoutSnapshot
}
