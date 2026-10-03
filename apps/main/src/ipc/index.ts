/** IPC 路由注册：渲染进程只能通过这些白名单通道访问主进程能力。 */
import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'
import { CH, FILE_FILTERS } from '@logicreader/shared'
import type { AnchorRecord, AnnotationRecord, BlockRecord, DocumentRecord, LogEntry, PermissionMode } from '@logicreader/shared'
import { assertArray, assertNumber, assertObject, assertPath, assertString, broadcast, handle, logMain } from '../util/ipc'
import { fsService } from '../services/fs.service'
import { settingsService } from '../services/settings.service'
import { sessionService } from '../services/session.service'
import { storeService } from '../services/store.service'
import { logService } from '../services/log.service'
import { convertService } from '../services/convert.service'
import { agentRegistry } from '../services/agent/registry'
import { agentRuntime } from '../services/agent/runtime'
import { graphService } from '../services/graph.service'
import { applyThemeToWindow, collectState, currentTheme } from '../window'
import { paths } from '../util/paths'

export interface IpcContext {
  getWindow: () => BrowserWindow | null
  openFilesFromArgv: (files: string[]) => void
  takePendingFiles: () => string[]
}

/**
 * 解析 Agent 注册表里的环境变量映射。
 * 只收"合法环境变量名 → 字符串值"，其余一律丢弃 —— 这些键值最终会原样进子进程环境，
 * 不允许出现空名 / 数字 / 超长内容；`secret:<key>` 形态由 runtime 在启动时解析成密钥库里的值。
 */
function parseEnvMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (typeof raw !== 'string') continue
    if (raw.length > 8192) continue
    out[key] = raw
  }
  return out
}

/**
 * 给注册表条目补一个"密钥配没配"的标记（界面用它提示"到设置里填 DeepSeek API Key"）。
 * 只有需要密钥的 Agent（dsh）会得到 true/false，其余是 null（不需要）。
 */
function withCredentialState<T extends { id: string }>(registration: T): T & { credentialOk: boolean | null } {
  return { ...registration, credentialOk: agentRegistry.hasCredentials(registration.id) }
}

function makeDialogs(ctx: IpcContext) {
  return {
    open: async (options: Electron.OpenDialogOptions) => {
      const win = ctx.getWindow()
      return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
    },
    save: async (options: Electron.SaveDialogOptions) => {
      const win = ctx.getWindow()
      return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
    },
    message: async (options: Electron.MessageBoxOptions) => {
      const win = ctx.getWindow()
      return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
    }
  }
}

export function registerIpc(ctx: IpcContext): void {
  const dlg = makeDialogs(ctx)
  // ------------------------------------------------------------------ app
  handle(CH.app.info, () => ({
    name: app.getName(),
    productName: 'LogicReader',
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    locale: app.getLocale(),
    isPackaged: app.isPackaged,
    userDataPath: paths.userData(),
    appPath: app.getAppPath(),
    logsPath: paths.logs(),
    totalMemMb: Math.round(require('node:os').totalmem() / 1024 / 1024)
  }))

  handle(CH.app.openExternal, async (_e, url) => {
    const target = assertString(url, 'url')
    if (!/^https?:|^mailto:/.test(target)) throw new Error('仅允许打开 http/https/mailto 链接')
    await shell.openExternal(target)
  })

  handle(CH.app.takePendingFiles, () => {
    const files = ctx.takePendingFiles()
    return files
  })

  handle(CH.app.quit, () => {
    app.quit()
  })

  handle(CH.app.relaunch, () => {
    app.relaunch()
    app.exit(0)
  })

  handle(CH.app.setUiScale, (_e, scale) => {
    const value = assertNumber(scale, 'scale')
    const win = ctx.getWindow()
    if (!win) return
    const clamped = Math.min(2, Math.max(0.6, value))
    win.webContents.setZoomFactor(clamped)
  })

  // ------------------------------------------------------------- window
  handle(CH.win.minimize, () => {
    ctx.getWindow()?.minimize()
  })
  handle(CH.win.toggleMaximize, () => {
    const win = ctx.getWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  handle(CH.win.close, () => {
    ctx.getWindow()?.close()
  })
  handle(CH.win.setFullScreen, (_e, value) => {
    ctx.getWindow()?.setFullScreen(Boolean(value))
  })
  handle(CH.win.state, () => {
    const win = ctx.getWindow()
    return win ? collectState(win) : { maximized: false, fullscreen: false, focused: false, bounds: { x: 0, y: 0, width: 0, height: 0 } }
  })

  // ------------------------------------------------------------- dialog
  handle(CH.dialog.openFiles, async () => {
    const result = await dlg.open({
      title: '打开文档',
      properties: ['openFile', 'multiSelections'],
      // 与 packages/shared/formats.ts 共用同一份过滤器，避免"支持格式加了一种、对话框忘了同步"
      filters: FILE_FILTERS
    })
    if (result.canceled) return []
    return result.filePaths
  })

  handle(CH.dialog.openFolder, async () => {
    const result = await dlg.open({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  handle(CH.dialog.saveFile, async (_e, options) => {
    const opts = assertObject(options, 'options')
    const result = await dlg.save({
      title: typeof opts.title === 'string' ? opts.title : undefined,
      defaultPath: typeof opts.defaultPath === 'string' ? opts.defaultPath : undefined,
      filters: Array.isArray(opts.filters) ? (opts.filters as { name: string; extensions: string[] }[]) : undefined
    })
    if (result.canceled || !result.filePath) return null
    return result.filePath
  })

  handle(CH.dialog.message, async (_e, options) => {
    const opts = assertObject(options, 'options')
    const result = await dlg.message({
      type: (opts.type as 'none') ?? 'none',
      title: typeof opts.title === 'string' ? opts.title : undefined,
      message: assertString(opts.message, 'message'),
      detail: typeof opts.detail === 'string' ? opts.detail : undefined,
      buttons: Array.isArray(opts.buttons) ? (opts.buttons as string[]) : ['确定'],
      defaultId: typeof opts.defaultId === 'number' ? opts.defaultId : 0,
      cancelId: typeof opts.cancelId === 'number' ? opts.cancelId : undefined,
      noLink: true
    })
    return result.response
  })

  // ----------------------------------------------------------------- fs
  handle(CH.fs.stat, (_e, path) => fsService.stat(assertPath(path)))
  handle(CH.fs.exists, (_e, path) => fsService.exists(assertPath(path)))
  handle(CH.fs.readBinary, (_e, path) => fsService.readBinary(assertPath(path)))
  handle(CH.fs.readText, (_e, path) => fsService.readText(assertPath(path)))
  handle(CH.fs.writeText, async (_e, path, text) => {
    await fsService.writeText(assertPath(path), assertString(text, 'text'))
  })
  handle(CH.fs.writeBinary, async (_e, path, data) => {
    if (!(data instanceof Uint8Array)) throw new TypeError('data 必须是 Uint8Array')
    await fsService.writeBinary(assertPath(path), data)
  })
  handle(CH.fs.hash, (_e, path) => fsService.hash(assertPath(path)))
  handle(CH.fs.reveal, (_e, path) => fsService.reveal(assertPath(path)))
  handle(CH.fs.openPath, (_e, path) => fsService.openPath(assertPath(path)))
  handle(CH.fs.readDir, (_e, path) => fsService.readDir(assertPath(path)))
  handle(CH.fs.watch, (_e, path) => {
    fsService.watch(assertPath(path))
  })
  handle(CH.fs.unwatch, (_e, path) => {
    fsService.unwatch(assertPath(path))
  })
  handle(CH.fs.recent, () => fsService.recent())
  handle(CH.fs.pushRecent, (_e, entry) => {
    const obj = assertObject(entry, 'entry')
    return fsService.pushRecent({ path: assertPath(obj.path), title: assertString(obj.title, 'title') })
  })

  // ----------------------------------------------------------- settings
  handle(CH.settings.all, () => settingsService.all())
  handle(CH.settings.patch, (_e, patch) => settingsService.patch(patch))
  handle(CH.settings.reset, () => settingsService.reset())
  handle(CH.settings.secretSet, (_e, key, value) => {
    settingsService.setSecret(assertString(key, 'key'), assertString(value, 'value'))
  })
  handle(CH.settings.secretHas, (_e, key) => settingsService.hasSecret(assertString(key, 'key')))
  handle(CH.settings.secretDelete, (_e, key) => {
    settingsService.deleteSecret(assertString(key, 'key'))
  })

  settingsService.onChange((settings) => {
    broadcast(CH.settings.changed, settings)
    const win = ctx.getWindow()
    if (win) applyThemeToWindow(win, currentTheme())
  })

  // ------------------------------------------------------------ session
  handle(CH.session.load, () => sessionService.report())
  handle(CH.session.save, (_e, patch, immediate) => {
    sessionService.save(patch, Boolean(immediate))
  })
  handle(CH.session.flush, (_e, reason) => {
    sessionService.flush((typeof reason === 'string' ? reason : 'quit') as 'quit')
  })
  handle(CH.session.clear, () => {
    sessionService.clear()
  })

  // -------------------------------------------------------------- store
  handle(CH.store.upsertDocument, (_e, doc) => {
    storeService.upsertDocument(assertObject(doc, 'doc') as unknown as DocumentRecord)
  })
  handle(CH.store.listDocuments, (_e, limit) => storeService.listDocuments(typeof limit === 'number' ? limit : 50))
  handle(CH.store.getDocument, (_e, id) => storeService.getDocument(assertString(id, 'id')))
  handle(CH.store.removeDocument, (_e, id) => {
    storeService.removeDocument(assertString(id, 'id'))
  })
  handle(CH.store.saveBlocks, (_e, docId, blocks) => {
    storeService.saveBlocks(assertString(docId, 'docId'), assertArray(blocks, 'blocks') as unknown as BlockRecord[])
  })
  handle(CH.store.getBlocks, (_e, docId) => storeService.getBlocks(assertString(docId, 'docId')))
  handle(CH.store.saveAnchors, (_e, anchors) => {
    storeService.saveAnchors(assertArray(anchors, 'anchors') as unknown as AnchorRecord[])
  })
  handle(CH.store.getAnchor, (_e, id) => storeService.getAnchor(assertString(id, 'id')))
  handle(CH.store.listAnchors, (_e, docId) => storeService.listAnchors(assertString(docId, 'docId')))
  handle(CH.store.updateAnchor, (_e, anchor) => {
    storeService.updateAnchor(assertObject(anchor, 'anchor') as unknown as AnchorRecord)
  })
  handle(CH.store.annotations, (_e, docId) => storeService.listAnnotations(assertString(docId, 'docId')))
  handle(CH.store.annotationUpsert, (_e, annotation) => {
    storeService.upsertAnnotation(assertObject(annotation, 'annotation') as unknown as AnnotationRecord)
  })
  handle(CH.store.annotationDelete, (_e, id) => {
    storeService.deleteAnnotation(assertString(id, 'id'))
  })
  handle(CH.store.graphSave, (_e, payload) => {
    storeService.graphSave(assertObject(payload, 'graph') as never)
  })
  handle(CH.store.graphGet, (_e, graphId) => storeService.graphGet(assertString(graphId, 'graphId')))
  handle(CH.store.graphList, (_e, docId) => storeService.graphList(assertString(docId, 'docId')))
  handle(CH.store.graphPatch, () => {
    throw new Error('graphPatch 请通过 graph 服务调用')
  })
  handle(CH.store.graphDelete, (_e, graphId) => {
    storeService.graphDelete(assertString(graphId, 'graphId'))
  })
  handle(CH.store.conversationUpsert, (_e, payload) => {
    storeService.conversationUpsert(assertObject(payload, 'payload'))
  })
  handle(CH.store.conversationRemoteSession, (_e, conversationId, remoteSessionId) => {
    storeService.setConversationRemoteSession(
      assertString(conversationId, 'conversationId'),
      assertString(remoteSessionId, 'remoteSessionId')
    )
  })
  handle(CH.store.conversationList, (_e, docId) => storeService.conversationList(assertString(docId, 'docId')))
  handle(CH.store.conversationGet, (_e, id) => storeService.conversationGet(assertString(id, 'id')))
  handle(CH.store.messageAppend, (_e, payload) => {
    storeService.messageAppend(assertObject(payload, 'payload'))
  })
  handle(CH.store.messageList, (_e, conversationId) => storeService.messageList(assertString(conversationId, 'conversationId')))
  handle(CH.store.agentUpsert, (_e, payload) => {
    storeService.agentUpsert(assertObject(payload, 'payload'))
  })
  handle(CH.store.agentList, () => storeService.agentList())
  handle(CH.store.stats, () => storeService.stats())

  // ---------------------------------------------------------------- log
  handle(CH.log.write, (_e, level, scope, message, detail) => {
    logService.push({
      id: 'log_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      at: Date.now(),
      level: (['debug', 'info', 'warn', 'error'].includes(String(level)) ? level : 'info') as LogEntry['level'],
      scope: assertString(scope, 'scope'),
      message: assertString(message, 'message'),
      detail: typeof detail === 'string' ? detail : undefined
    })
  })
  handle(CH.log.read, (_e, limit) => logService.read(typeof limit === 'number' ? limit : 500))
  handle(CH.log.clear, () => {
    logService.clear()
  })
  logService.onEntry((entry) => broadcast(CH.log.entry, entry))

  // ------------------------------------------------------------ convert
  handle(CH.convert.availability, (_e, force) => convertService.probe(Boolean(force)))
  handle(CH.convert.toPdf, async (_e, path, hash) => {
    const target = assertPath(path)
    const docHash = typeof hash === 'string' && hash.length > 0 ? hash : await fsService.hash(target)
    return convertService.toPdf(target, docHash)
  })
  handle(CH.convert.pickLibreOffice, async () => {
    const result = await dlg.open({
      title: '选择 soffice.exe',
      properties: ['openFile'],
      filters: [{ name: 'LibreOffice', extensions: ['exe', 'com', ''] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const chosen = result.filePaths[0]
    settingsService.patch({ libreOfficePath: chosen })
    convertService.invalidate()
    return convertService.probe(true)
  })

  // -------------------------------------------------------------- agent
  handle(CH.agent.list, () => agentRegistry.list().map(withCredentialState))
  handle(CH.agent.probe, (_e, agentId, force) => agentRegistry.probe(assertString(agentId, 'agentId'), Boolean(force)))
  handle(CH.agent.probeAll, (_e, force) => agentRegistry.probeAll(Boolean(force)))
  handle(CH.agent.upsert, (_e, payload) => {
    const obj = assertObject(payload, 'registration')
    agentRegistry.upsert({
      id: typeof obj.id === 'string' && obj.id.length > 0 ? obj.id : 'custom_' + Math.random().toString(36).slice(2, 8),
      kind: (obj.kind as 'custom') ?? 'custom',
      displayName: assertString(obj.displayName, 'displayName'),
      protocol: (obj.protocol as 'cli') ?? 'cli',
      executable: obj.executable == null ? null : String(obj.executable),
      args: Array.isArray(obj.args) ? (obj.args as string[]) : [],
      env: parseEnvMap(obj.env),
      enabled: obj.enabled !== false,
      builtin: false
    })
    return agentRegistry.list().map(withCredentialState)
  })
  handle(CH.agent.remove, (_e, agentId) => {
    agentRegistry.remove(assertString(agentId, 'agentId'))
    return agentRegistry.list().map(withCredentialState)
  })
  handle(CH.agent.sessionCreate, (_e, request) => {
    const obj = assertObject(request, 'request')
    return agentRuntime.createSession({
      agentId: assertString(obj.agentId, 'agentId'),
      contextMode: obj.contextMode === 'graph' ? 'graph' : 'fulltext',
      modelId: obj.modelId == null ? null : String(obj.modelId),
      thinkingEffort: obj.thinkingEffort == null ? null : String(obj.thinkingEffort),
      resumeSessionId: obj.resumeSessionId == null ? null : String(obj.resumeSessionId),
      forkSession: obj.forkSession === true,
      resumeSessionAt: obj.resumeSessionAt == null ? null : String(obj.resumeSessionAt),
      documentDir: obj.documentDir == null ? null : String(obj.documentDir),
      permissionMode: obj.permissionMode == null ? null : (String(obj.permissionMode) as PermissionMode)
    })
  })
  handle(CH.agent.revertHunks, (_e, sessionId, toolUseId, indices) =>
    agentRuntime.revertHunks(
      assertString(sessionId, 'sessionId'),
      assertString(toolUseId, 'toolUseId'),
      Array.isArray(indices) ? indices.map((value) => Number(value)).filter((value) => Number.isFinite(value)) : []
    )
  )
  handle(CH.agent.workdir, (_e, documentDir) =>
    agentRuntime.workdirFor(documentDir == null ? null : String(documentDir))
  )
  handle(CH.agent.sessionDispose, (_e, sessionId) => agentRuntime.dispose(assertString(sessionId, 'sessionId')))
  handle(CH.agent.models, (_e, sessionId) => agentRuntime.models(assertString(sessionId, 'sessionId')))
  handle(CH.agent.probeModels, (_e, agentId) => agentRuntime.probeModels(assertString(agentId, 'agentId')))
  handle(CH.agent.commands, (_e, sessionId) => agentRuntime.commands(assertString(sessionId, 'sessionId')))
  handle(CH.agent.history, (_e, dir, limit, agentId) =>
    agentRuntime.listSessions(
      dir == null ? null : String(dir),
      typeof limit === 'number' ? limit : 30,
      agentId == null ? null : String(agentId)
    )
  )
  handle(CH.agent.historyRename, (_e, agentId, sessionId, title) => {
    const text = assertString(title, 'title').trim()
    if (text.length === 0) return
    storeService.sessionTitleSet({
      agentId: assertString(agentId, 'agentId'),
      sessionId: assertString(sessionId, 'sessionId'),
      title: text.slice(0, 80),
      source: 'manual'
    })
  })
  handle(CH.agent.historyName, (_e, agentId, sessionId, firstPrompt) =>
    agentRuntime.nameSession({
      agentId: assertString(agentId, 'agentId'),
      sessionId: assertString(sessionId, 'sessionId'),
      firstPrompt: firstPrompt == null ? null : String(firstPrompt)
    })
  )
  handle(CH.agent.files, async (_e, dir, query, limit) => {
    const target = dir == null || String(dir).length === 0 ? null : String(dir)
    if (!target) return []
    const { listWorkspaceFiles, searchWorkspaceFiles } = await import('../services/agent/files')
    const files = await listWorkspaceFiles(target)
    return searchWorkspaceFiles(files, typeof query === 'string' ? query : '', typeof limit === 'number' ? limit : 12)
  })
  handle(CH.agent.rewind, (_e, sessionId, userMessageId, dryRun) =>
    agentRuntime.rewind(assertString(sessionId, 'sessionId'), assertString(userMessageId, 'userMessageId'), Boolean(dryRun))
  )
  handle(CH.agent.sessionList, () => agentRuntime.listRuntimeSessions())
  handle(CH.agent.prompt, (_e, sessionId, input) => {
    const obj = assertObject(input, 'input')
    return agentRuntime.prompt(assertString(sessionId, 'sessionId'), {
      text: assertString(obj.text, 'text'),
      systemContext: typeof obj.systemContext === 'string' ? obj.systemContext : undefined,
      modelId: obj.modelId == null ? null : String(obj.modelId),
      thinkingEffort: obj.thinkingEffort == null ? null : String(obj.thinkingEffort)
    })
  })
  handle(CH.agent.cancel, (_e, sessionId) => agentRuntime.cancel(assertString(sessionId, 'sessionId')))
  handle(CH.agent.permissionRespond, (_e, requestId, optionId) => {
    agentRuntime.respondPermission(assertString(requestId, 'requestId'), optionId == null ? null : String(optionId))
  })
  handle(CH.agent.setConfigOption, (_e, sessionId, optionId, value) =>
    agentRuntime.setConfigOption(assertString(sessionId, 'sessionId'), assertString(optionId, 'optionId'), value as string)
  )

  // -------------------------------------------------------------- graph
  handle(CH.graph.estimate, (_e, request) => {
    const obj = assertObject(request, 'request')
    return graphService.estimate({
      docId: assertString(obj.docId, 'docId'),
      agentId: typeof obj.agentId === 'string' ? obj.agentId : 'mock',
      modelId: obj.modelId == null ? null : String(obj.modelId),
      thinkingEffort: obj.thinkingEffort == null ? null : String(obj.thinkingEffort),
      precision: (obj.precision as 'structure') ?? 'structure',
      nodeLimit: typeof obj.nodeLimit === 'number' ? obj.nodeLimit : undefined,
      chunkTokens: typeof obj.chunkTokens === 'number' ? obj.chunkTokens : undefined,
      concurrency: typeof obj.concurrency === 'number' ? obj.concurrency : undefined,
      entityThreshold: typeof obj.entityThreshold === 'number' ? obj.entityThreshold : undefined,
      edgeKinds: Array.isArray(obj.edgeKinds) ? (obj.edgeKinds as string[]) : undefined,
      locale: typeof obj.locale === 'string' ? obj.locale : undefined
    })
  })
  handle(CH.graph.generate, async (_e, request) => {
    const obj = assertObject(request, 'request')
    const taskId = assertString(obj.taskId ?? '', 'taskId') || undefined
    const registration = agentRegistry.get(String(obj.agentId ?? ''))
    const payload = {
      docId: assertString(obj.docId, 'docId'),
      graphId: obj.graphId == null ? null : String(obj.graphId),
      agentId: assertString(obj.agentId, 'agentId'),
      agentName: registration?.displayName ?? String(obj.agentId),
      modelId: obj.modelId == null ? null : String(obj.modelId),
      thinkingEffort: obj.thinkingEffort == null ? null : String(obj.thinkingEffort),
      precision: (obj.precision as 'structure') ?? 'structure',
      scope: (obj.scope as 'full') ?? 'full',
      sectionIds: Array.isArray(obj.sectionIds) ? (obj.sectionIds as string[]) : undefined,
      fromPage: typeof obj.fromPage === 'number' ? obj.fromPage : undefined,
      nodeLimit: typeof obj.nodeLimit === 'number' ? obj.nodeLimit : undefined,
      chunkTokens: typeof obj.chunkTokens === 'number' ? obj.chunkTokens : undefined,
      concurrency: typeof obj.concurrency === 'number' ? obj.concurrency : undefined,
      entityThreshold: typeof obj.entityThreshold === 'number' ? obj.entityThreshold : undefined,
      edgeKinds: Array.isArray(obj.edgeKinds) ? (obj.edgeKinds as string[]) : undefined,
      locale: typeof obj.locale === 'string' ? obj.locale : undefined
    }
    try {
      const graph = await graphService.generate(payload, (progress) => broadcast(CH.graph.progress, progress), taskId)
      return graph
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      broadcast(CH.graph.progress, { taskId: taskId ?? '', phase: 'error', done: 0, total: 0, detail: message, error: message })
      throw error
    }
  })
  handle(CH.graph.cancel, (_e, taskId) => {
    graphService.cancel(assertString(taskId, 'taskId'))
  })
  handle(CH.graph.refine, async (_e, request) => {
    const obj = assertObject(request, 'request')
    const registration = agentRegistry.get(String(obj.agentId ?? ''))
    return graphService.refine(
      {
        docId: assertString(obj.docId, 'docId'),
        graphId: obj.graphId == null ? null : String(obj.graphId),
        agentId: assertString(obj.agentId, 'agentId'),
        agentName: registration?.displayName,
        modelId: obj.modelId == null ? null : String(obj.modelId),
        thinkingEffort: obj.thinkingEffort == null ? null : String(obj.thinkingEffort),
        precision: (obj.precision as 'panorama') ?? 'panorama',
        scope: 'section',
        sectionIds: Array.isArray(obj.sectionIds) ? (obj.sectionIds as string[]) : undefined,
        nodeLimit: typeof obj.nodeLimit === 'number' ? obj.nodeLimit : undefined,
        concurrency: typeof obj.concurrency === 'number' ? obj.concurrency : undefined,
        locale: typeof obj.locale === 'string' ? obj.locale : undefined
      },
      (progress) => broadcast(CH.graph.progress, progress)
    )
  })
  handle(CH.graph.retryFailedChunks, async (_e, request) => {
    const obj = assertObject(request, 'request')
    return graphService.generate(
      {
        docId: assertString(obj.docId, 'docId'),
        graphId: assertString(obj.graphId, 'graphId'),
        agentId: assertString(obj.agentId, 'agentId'),
        modelId: obj.modelId == null ? null : String(obj.modelId),
        thinkingEffort: obj.thinkingEffort == null ? null : String(obj.thinkingEffort),
        precision: (obj.precision as 'structure') ?? 'structure',
        scope: 'full'
      },
      (progress) => broadcast(CH.graph.progress, progress)
    )
  })
  handle(CH.graph.exportFile, async (_e, graphId, format, targetPath) => {
    const id = assertString(graphId, 'graphId')
    const kind = assertString(format, 'format')
    if (kind === 'json') {
      const graph = storeService.graphGet(id)
      if (!graph) throw new Error('关系图不存在')
      await fsService.writeText(assertPath(targetPath), JSON.stringify(graph, null, 2))
      return targetPath
    }
    if (kind === 'markdown') {
      await fsService.writeText(assertPath(targetPath), graphService.exportMarkdown(id))
      return targetPath
    }
    if (kind === 'svg') {
      await fsService.writeText(assertPath(targetPath), graphService.exportSvg(id))
      return targetPath
    }
    throw new Error('不支持的导出格式：' + kind)
  })
  // 图片导出：主进程只给 SVG 文本，渲染进程用 Chromium 的 canvas 光栅化成 PNG / JPG
  handle(CH.graph.renderSvg, (_e, graphId, options) => {
    const id = assertString(graphId, 'graphId')
    const background = (options as { background?: unknown } | undefined)?.background
    return graphService.renderSvg(id, {
      background: typeof background === 'string' ? background : null
    })
  })
  handle(CH.graph.importFile, async (_e, filePath) => {
    const text = await fsService.readText(assertPath(filePath))
    return graphService.importFromJson(JSON.parse(text))
  })
  handle(CH.graph.applyLayout, (_e, graphId, positions) => {
    const graph = storeService.graphGet(assertString(graphId, 'graphId'))
    if (!graph) throw new Error('关系图不存在')
    const map = assertObject(positions, 'positions') as Record<string, { x: number; y: number }>
    for (const node of graph.nodes) {
      const point = map[node.id]
      if (!point) continue
      node.x = point.x
      node.y = point.y
      node.pinned = { ...(node.pinned ?? {}), position: true }
    }
    storeService.graphSave(graph)
  })
  handle(CH.graph.nlpLayout, () => {
    throw new Error('自然语言布局请通过命令面板的"布局"入口调用')
  })
  handle(CH.graph.presets, () => {
    const raw = storeService.getSetting('graph.presets')
    return raw ? JSON.parse(raw) : []
  })
  handle(CH.graph.savePreset, (_e, preset) => {
    const obj = assertObject(preset, 'preset')
    const raw = storeService.getSetting('graph.presets')
    const list = raw ? (JSON.parse(raw) as Record<string, unknown>[]) : []
    const name = assertString(obj.name, 'name')
    const next = list.filter((item) => item.name !== name).concat([{ ...obj, name }])
    storeService.setSetting('graph.presets', JSON.stringify(next))
    return next
  })

  // -------------------------------------------------------------- theme
  nativeTheme.on('updated', () => {
    broadcast(CH.theme.systemChanged, {
      theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      prefersDark: nativeTheme.shouldUseDarkColors
    })
  })

  logMain('info', 'ipc', 'IPC 路由注册完成')
}
