/** preload：以白名单方式把主进程能力暴露给渲染进程（contextIsolation + sandbox）。 */
import { contextBridge, ipcRenderer } from 'electron'
import { API_GLOBAL, CH } from '@logicreader/shared'
import type {
  AgentCapabilityView, AgentConfigOption, AgentEventPayload, AgentModelView, AgentRegistrationView, AgentSessionInfoView, WorkspaceFileView,
  AppInfo, AppSettings, AnnotationRecord, AnchorRecord, BlockRecord, DocumentRecord,
  FileStat, LogEntry, MessageDialogOptions, RecentEntry, RestoreReport, SaveDialogOptions,
  SessionSnapshot, Unsubscribe, WindowState, LogicReaderApi, FsChangeEvent, ResolvedTheme, SearchHit
} from '@logicreader/shared'

type InvokeArgs = unknown[]

function invoke<T>(channel: string, ...args: InvokeArgs): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>
}

function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): Unsubscribe {
  const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => {
    cb(...(args as T))
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: LogicReaderApi = {
  app: {
    info: () => invoke<AppInfo>(CH.app.info),
    openExternal: (url) => invoke<void>(CH.app.openExternal, url),
    quit: () => invoke<void>(CH.app.quit),
    relaunch: () => invoke<void>(CH.app.relaunch),
    setUiScale: (scale) => invoke<void>(CH.app.setUiScale, scale),
    edit: (action) => invoke<void>(CH.app.edit, action),
    onOpenFiles: (cb) => subscribe<[string[]]>(CH.app.openFiles, cb),
    takePendingFiles: () => invoke<string[]>(CH.app.takePendingFiles),
    onMenuCommand: (cb) => subscribe<[{ commandId: string; args?: unknown }]>(CH.app.menuCommand, cb)
  },
  win: {
    minimize: () => {
      void invoke<void>(CH.win.minimize)
    },
    toggleMaximize: () => {
      void invoke<void>(CH.win.toggleMaximize)
    },
    close: () => {
      void invoke<void>(CH.win.close)
    },
    setFullScreen: (value) => invoke<void>(CH.win.setFullScreen, value),
    state: () => invoke<WindowState>(CH.win.state),
    onState: (cb) => subscribe<[WindowState]>(CH.win.stateChanged, cb)
  },
  dialog: {
    openFiles: () => invoke<string[]>(CH.dialog.openFiles),
    openFolder: () => invoke<string | null>(CH.dialog.openFolder),
    saveFile: (options: SaveDialogOptions) => invoke<string | null>(CH.dialog.saveFile, options),
    message: (options: MessageDialogOptions) => invoke<number>(CH.dialog.message, options)
  },
  fs: {
    stat: (path) => invoke<FileStat | null>(CH.fs.stat, path),
    exists: (path) => invoke<boolean>(CH.fs.exists, path),
    readBinary: (path) => invoke<Uint8Array>(CH.fs.readBinary, path),
    readText: (path) => invoke<string>(CH.fs.readText, path),
    writeText: (path, text) => invoke<void>(CH.fs.writeText, path, text),
    writeBinary: (path, data) => invoke<void>(CH.fs.writeBinary, path, data),
    hash: (path) => invoke<string>(CH.fs.hash, path),
    reveal: (path) => invoke<void>(CH.fs.reveal, path),
    openPath: (path) => invoke<string>(CH.fs.openPath, path),
    readDir: (path) => invoke<{ name: string; path: string; isDirectory: boolean }[]>(CH.fs.readDir, path),
    watch: (path) => invoke<void>(CH.fs.watch, path),
    unwatch: (path) => invoke<void>(CH.fs.unwatch, path),
    onChanged: (cb) => subscribe<[FsChangeEvent]>(CH.fs.changed, cb),
    recent: () => invoke<RecentEntry[]>(CH.fs.recent),
    pushRecent: (entry) => invoke<RecentEntry[]>(CH.fs.pushRecent, entry)
  },
  settings: {
    all: () => invoke<AppSettings>(CH.settings.all),
    patch: (patch) => invoke<AppSettings>(CH.settings.patch, patch),
    reset: () => invoke<AppSettings>(CH.settings.reset),
    onChange: (cb) => subscribe<[AppSettings]>(CH.settings.changed, cb),
    setSecret: (key, value) => invoke<void>(CH.settings.secretSet, key, value),
    hasSecret: (key) => invoke<boolean>(CH.settings.secretHas, key),
    deleteSecret: (key) => invoke<void>(CH.settings.secretDelete, key)
  },
  session: {
    load: () => invoke<RestoreReport | null>(CH.session.load),
    save: (patch) => invoke<void>(CH.session.save, patch, false),
    flush: (reason) => invoke<void>(CH.session.flush, reason),
    clear: () => invoke<void>(CH.session.clear)
  },
  store: {
    upsertDocument: (doc: DocumentRecord) => invoke<void>(CH.store.upsertDocument, doc),
    listDocuments: (limit) => invoke<DocumentRecord[]>(CH.store.listDocuments, limit),
    getDocument: (id) => invoke<DocumentRecord | null>(CH.store.getDocument, id),
    removeDocument: (id) => invoke<void>(CH.store.removeDocument, id),
    saveBlocks: (docId, blocks: BlockRecord[]) => invoke<void>(CH.store.saveBlocks, docId, blocks),
    getBlocks: (docId) => invoke<BlockRecord[]>(CH.store.getBlocks, docId),
    searchBlocks: (query, limit) => invoke<SearchHit[]>(CH.store.searchBlocks, query, limit),
    saveAnchors: (anchors: AnchorRecord[]) => invoke<void>(CH.store.saveAnchors, anchors),
    getAnchor: (id) => invoke<AnchorRecord | null>(CH.store.getAnchor, id),
    listAnchors: (docId) => invoke<AnchorRecord[]>(CH.store.listAnchors, docId),
    updateAnchor: (anchor: AnchorRecord) => invoke<void>(CH.store.updateAnchor, anchor),
    listAnnotations: (docId) => invoke<AnnotationRecord[]>(CH.store.annotations, docId),
    upsertAnnotation: (annotation: AnnotationRecord) => invoke<void>(CH.store.annotationUpsert, annotation),
    deleteAnnotation: (id) => invoke<void>(CH.store.annotationDelete, id),
    graphSave: (payload) => invoke<void>(CH.store.graphSave, payload),
    graphGet: (graphId) => invoke<unknown | null>(CH.store.graphGet, graphId),
    graphList: (docId) => invoke<unknown[]>(CH.store.graphList, docId),
    graphPatch: (graphId, patch) => invoke<void>(CH.store.graphPatch, graphId, patch),
    graphDelete: (graphId) => invoke<void>(CH.store.graphDelete, graphId),
    conversationUpsert: (payload) => invoke<void>(CH.store.conversationUpsert, payload),
    conversationSetRemoteSession: (conversationId, remoteSessionId) =>
      invoke<void>(CH.store.conversationRemoteSession, conversationId, remoteSessionId),
    conversationList: (docId) => invoke<unknown[]>(CH.store.conversationList, docId),
    conversationGet: (id) => invoke<unknown | null>(CH.store.conversationGet, id),
    messageAppend: (payload) => invoke<void>(CH.store.messageAppend, payload),
    messageList: (conversationId) => invoke<unknown[]>(CH.store.messageList, conversationId),
    agentUpsert: (payload) => invoke<void>(CH.store.agentUpsert, payload),
    agentList: () => invoke<unknown[]>(CH.store.agentList),
    stats: () => invoke<Record<string, number>>(CH.store.stats)
  },
  agent: {
    list: () => invoke<AgentRegistrationView[]>(CH.agent.list),
    probe: (agentId, force) => invoke<AgentCapabilityView>(CH.agent.probe, agentId, Boolean(force)),
    probeAll: (force) => invoke<AgentCapabilityView[]>(CH.agent.probeAll, Boolean(force)),
    upsert: (registration) => invoke<AgentRegistrationView[]>(CH.agent.upsert, registration),
    remove: (agentId) => invoke<AgentRegistrationView[]>(CH.agent.remove, agentId),
    sessionCreate: (request) =>
      invoke<{ sessionId: string; capability: AgentCapabilityView; configOptions: AgentConfigOption[]; workspaceDir: string }>(
        CH.agent.sessionCreate,
        request
      ),
    sessionDispose: (sessionId) => invoke<void>(CH.agent.sessionDispose, sessionId),
    models: (sessionId) => invoke<AgentModelView[]>(CH.agent.models, sessionId),
    probeModels: (agentId) => invoke<AgentModelView[]>(CH.agent.probeModels, agentId),
    contextUsage: (sessionId) => invoke<{ used: number; size: number | null } | null>(CH.agent.contextUsage, sessionId),
    commands: (sessionId) => invoke<{ name: string; description?: string; argumentHint?: string }[]>(CH.agent.commands, sessionId),
    history: (dir, limit, agentId) => invoke<AgentSessionInfoView[]>(CH.agent.history, dir, limit ?? 30, agentId ?? null),
    historyRename: (agentId, sessionId, title) => invoke<void>(CH.agent.historyRename, agentId, sessionId, title),
    historyName: (agentId, sessionId, firstPrompt) =>
      invoke<string | null>(CH.agent.historyName, agentId, sessionId, firstPrompt ?? null),
    historyTranscript: (agentId, sessionId, cwd) =>
      invoke<
        { role: 'user' | 'assistant'; text: string; thinking: string; at: number }[]
      >(CH.agent.historyTranscript, agentId, sessionId, cwd),
    historyDelete: (agentId, sessionId, cwd) =>
      invoke<boolean>(CH.agent.historyDelete, agentId, sessionId, cwd),
    files: (dir, query, limit) => invoke<WorkspaceFileView[]>(CH.agent.files, dir, query ?? '', limit ?? 12),
    workdir: (documentDir) => invoke<string>(CH.agent.workdir, documentDir),
    revertHunks: (sessionId, toolUseId, indices) =>
      invoke<{ ok: boolean; conflict?: string }>(CH.agent.revertHunks, sessionId, toolUseId, indices),
    rewind: (sessionId, userMessageId, dryRun) => invoke<unknown>(CH.agent.rewind, sessionId, userMessageId, Boolean(dryRun)),
    sessionList: () => invoke<{ sessionId: string; agentId: string; contextMode: string; createdAt: number }[]>(CH.agent.sessionList),
    prompt: (sessionId, input) => invoke<void>(CH.agent.prompt, sessionId, input),
    cancel: (sessionId) => invoke<void>(CH.agent.cancel, sessionId),
    permissionRespond: (requestId, optionId) => invoke<void>(CH.agent.permissionRespond, requestId, optionId),
    setConfigOption: (sessionId, optionId, value) => invoke<void>(CH.agent.setConfigOption, sessionId, optionId, value),
    onEvent: (cb) => subscribe<[AgentEventPayload]>(CH.agent.event, cb),
    onChanged: (cb) => subscribe<[]>(CH.agent.changed, () => cb())
  },
  convert: {
    availability: (force) =>
      invoke<{ available: boolean; path: string | null; version: string | null; reason: string | null }>(
        CH.convert.availability,
        Boolean(force)
      ),
    toPdf: (path, hash) => invoke<string>(CH.convert.toPdf, path, hash),
    pickLibreOffice: () =>
      invoke<{ available: boolean; path: string | null; version: string | null; reason: string | null } | null>(
        CH.convert.pickLibreOffice
      )
  },
  graph: {
    estimate: (request) => invoke<unknown>(CH.graph.estimate, request),
    generate: (request) => invoke<unknown>(CH.graph.generate, request),
    cancel: (taskId) => invoke<void>(CH.graph.cancel, taskId),
    refine: (request) => invoke<unknown>(CH.graph.refine, request),
    retryFailedChunks: (request) => invoke<unknown>(CH.graph.retryFailedChunks, request),
    exportFile: (graphId, format, targetPath) => invoke<string>(CH.graph.exportFile, graphId, format, targetPath),
    renderSvg: (graphId, options) => invoke<string>(CH.graph.renderSvg, graphId, options ?? {}),
    importFile: (filePath) => invoke<unknown>(CH.graph.importFile, filePath),
    applyLayout: (graphId, positions) => invoke<void>(CH.graph.applyLayout, graphId, positions),
    presets: () => invoke<unknown[]>(CH.graph.presets),
    savePreset: (preset) => invoke<unknown[]>(CH.graph.savePreset, preset),
    onProgress: (cb) =>
      subscribe<
        [{ taskId: string; phase: string; done: number; total: number; detail: string; etaMs?: number | null; error?: string }]
      >(CH.graph.progress, cb)
  },
  log: {
    write: (level, scope, message, detail) => invoke<void>(CH.log.write, level, scope, message, detail),
    read: (limit) => invoke<LogEntry[]>(CH.log.read, limit),
    clear: () => invoke<void>(CH.log.clear),
    onEntry: (cb) => subscribe<[LogEntry]>(CH.log.entry, cb)
  },
  theme: {
    onSystemChange: (cb) => subscribe<[ResolvedTheme, boolean]>(CH.theme.systemChanged, (theme, prefersDark) => cb(theme, prefersDark))
  }
}

contextBridge.exposeInMainWorld(API_GLOBAL, api)

// 会话快照：页面卸载前尽力再写一次（主进程 before-quit 是主路径，这里作为双保险）
const globalScope = globalThis as unknown as {
  addEventListener?: (type: string, listener: () => void) => void
}
globalScope.addEventListener?.('beforeunload', () => {
  void invoke<void>(CH.session.flush, 'quit')
})

export type { SessionSnapshot }
