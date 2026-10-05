/** IPC 通道名与 preload 暴露给渲染进程的 API 契约。 */

export const CH = {
  app: {
    info: 'app:info',
    openExternal: 'app:open-external',
    quit: 'app:quit',
    relaunch: 'app:relaunch',
    setUiScale: 'app:set-ui-scale',
    /** 编辑菜单：undo / redo / cut / copy / paste / selectAll（由主进程的 webContents 执行） */
    edit: 'app:edit',
    openFiles: 'app:open-files',
    takePendingFiles: 'app:take-pending-files',
    menuCommand: 'app:menu-command'
  },
  win: {
    minimize: 'win:minimize',
    toggleMaximize: 'win:toggle-maximize',
    close: 'win:close',
    setFullScreen: 'win:set-fullscreen',
    state: 'win:state',
    stateChanged: 'win:state-changed'
  },
  dialog: {
    openFiles: 'dialog:open-files',
    openFolder: 'dialog:open-folder',
    saveFile: 'dialog:save-file',
    message: 'dialog:message'
  },
  fs: {
    stat: 'fs:stat',
    readBinary: 'fs:read-binary',
    readText: 'fs:read-text',
    writeText: 'fs:write-text',
    writeBinary: 'fs:write-binary',
    hash: 'fs:hash',
    exists: 'fs:exists',
    reveal: 'fs:reveal',
    openPath: 'fs:open-path',
    readDir: 'fs:read-dir',
    watch: 'fs:watch',
    unwatch: 'fs:unwatch',
    changed: 'fs:changed',
    recent: 'fs:recent',
    pushRecent: 'fs:push-recent'
  },
  settings: {
    all: 'settings:all',
    patch: 'settings:patch',
    reset: 'settings:reset',
    changed: 'settings:changed',
    secretSet: 'settings:secret-set',
    secretHas: 'settings:secret-has',
    secretDelete: 'settings:secret-delete'
  },
  session: {
    load: 'session:load',
    save: 'session:save',
    flush: 'session:flush',
    clear: 'session:clear',
    restored: 'session:restored'
  },
  store: {
    upsertDocument: 'store:upsert-document',
    listDocuments: 'store:list-documents',
    getDocument: 'store:get-document',
    removeDocument: 'store:remove-document',
    saveBlocks: 'store:save-blocks',
    getBlocks: 'store:get-blocks',
    searchBlocks: 'store:search-blocks',
    saveAnchors: 'store:save-anchors',
    getAnchor: 'store:get-anchor',
    listAnchors: 'store:list-anchors',
    updateAnchor: 'store:update-anchor',
    annotations: 'store:annotations',
    annotationUpsert: 'store:annotation-upsert',
    annotationDelete: 'store:annotation-delete',
    graphSave: 'store:graph-save',
    graphGet: 'store:graph-get',
    graphList: 'store:graph-list',
    graphPatch: 'store:graph-patch',
    graphDelete: 'store:graph-delete',
    conversationUpsert: 'store:conversation-upsert',
    conversationRemoteSession: 'store:conversation-remote-session',
    conversationList: 'store:conversation-list',
    conversationGet: 'store:conversation-get',
    messageAppend: 'store:message-append',
    messageList: 'store:message-list',
    agentUpsert: 'store:agent-upsert',
    agentList: 'store:agent-list',
    stats: 'store:stats'
  },
  log: {
    write: 'log:write',
    read: 'log:read',
    clear: 'log:clear',
    entry: 'log:entry'
  },
  theme: {
    systemChanged: 'theme:system-changed'
  },
  convert: {
    availability: 'convert:availability',
    toPdf: 'convert:to-pdf',
    pickLibreOffice: 'convert:pick-libreoffice',
    progress: 'convert:progress'
  },
  agent: {
    list: 'agent:list',
    probe: 'agent:probe',
    probeAll: 'agent:probe-all',
    register: 'agent:register',
    update: 'agent:update',
    upsert: 'agent:upsert',
    changed: 'agent:list-changed',
    remove: 'agent:remove',
    sessionCreate: 'agent:session-create',
    sessionDispose: 'agent:session-dispose',
    sessionList: 'agent:session-list',
    prompt: 'agent:prompt',
    cancel: 'agent:cancel',
    permissionRespond: 'agent:permission-respond',
    event: 'agent:event',
    configOptions: 'agent:config-options',
    setConfigOption: 'agent:set-config-option',
    models: 'agent:models',
    probeModels: 'agent:probe-models',
    contextUsage: 'agent:context-usage',
    commands: 'agent:commands',
    history: 'agent:history',
    historyRename: 'agent:history-rename',
    historyName: 'agent:history-name',
    historyTranscript: 'agent:history-transcript',
    historyDelete: 'agent:history-delete',
    files: 'agent:files',
    workdir: 'agent:workdir',
    revertHunks: 'agent:revert-hunks',
    rewind: 'agent:rewind'
  },
  graph: {
    generate: 'graph:generate',
    cancel: 'graph:cancel',
    progress: 'graph:progress',
    retryFailedChunks: 'graph:retry-failed-chunks',
    refine: 'graph:refine',
    aggregate: 'graph:aggregate',
    exportFile: 'graph:export-file',
    /** 取关系图 SVG 文本（图片导出在渲染进程做：只有 Chromium 能离线把 SVG 光栅化） */
    renderSvg: 'graph:render-svg',
    importFile: 'graph:import-file',
    estimate: 'graph:estimate',
    presets: 'graph:presets',
    savePreset: 'graph:save-preset',
    applyLayout: 'graph:apply-layout',
    nlpLayout: 'graph:nlp-layout'
  }
} as const

export interface AppInfo {
  name: string
  productName: string
  version: string
  electron: string
  chrome: string
  node: string
  v8: string
  platform: string
  arch: string
  locale: string
  isPackaged: boolean
  userDataPath: string
  appPath: string
  logsPath: string
  totalMemMb: number
}

export interface WindowState {
  maximized: boolean
  fullscreen: boolean
  focused: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

export interface FileStat {
  path: string
  size: number
  mtimeMs: number
  isFile: boolean
  isDirectory: boolean
}

export interface RecentEntry {
  path: string
  title: string
  at: number
}

export interface LogEntry {
  id: string
  at: number
  level: 'debug' | 'info' | 'warn' | 'error'
  scope: string
  message: string
  detail?: string
}

export type Unsubscribe = () => void

export interface MessageDialogOptions {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning'
  title?: string
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
}

export interface SaveDialogOptions {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

export interface DocumentRecord {
  id: string
  path: string
  format: string
  title: string
  docHash: string
  sizeBytes: number
  pageCount: number | null
  textLength: number
  outlineJson: string | null
  openedAt: number
  lastPage: number
  metaJson: string | null
}

export interface BlockRecord {
  id: string
  docId: string
  seq: number
  kind: string
  level: number | null
  text: string
  charStart: number
  charEnd: number
  locatorJson: string
  parentId: string | null
}

/**
 * 跨文档全文检索的一条命中（库级检索，不是当前文档内的查找）。
 *
 * 带上 `docId` / `charStart` / `charEnd` 是刻意的：拿到命中之后要能直接跳回原文并高亮，
 * 而这一跳靠的就是 (docId, 字符区间) —— 与关系图节点跳转共用同一条 `requestReveal` 通道。
 */
export interface SearchHit {
  docId: string
  docTitle: string
  /** 文档在磁盘上的路径：命中的文档若还没打开，调用方要先用它把文档打开才谈得上跳转 */
  docPath: string
  blockId: string
  blockKind: string
  seq: number
  text: string
  charStart: number
  charEnd: number
  /** 命中的第一个字在块内的偏移（用于把结果窗口滚到命中处）；找不到时为 -1 */
  matchStart: number
}

export interface AnchorRecord {
  id: string
  docId: string
  docHash: string
  blockIds: string
  charStart: number
  charEnd: number
  quote: string
  quoteHash: string
  primaryJson: string
  extrasJson: string | null
  status: 'ok' | 'stale'
}

export interface AnnotationRecord {
  id: string
  docId: string
  kind: string
  color: string
  anchorId: string
  note: string | null
  createdAt: number
  /** 页面与矩形等渲染附加信息（JSON） */
  extraJson?: string | null
}
