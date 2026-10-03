import { create } from 'zustand'
import { basename, describeFormat, stripExtension, type DocumentFormat } from '@logicreader/shared'
import {
  finalizeDocumentModel,
  relocateAnchor,
  type Anchor,
  type Block,
  type DocumentModel
} from '@logicreader/document-model'

export interface BlockRecordLike {
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
import { api } from '../lib/api'
import { PARSER_VERSION, parseDocument } from '../parsers'
import { useNotifications } from './notifications.store'

export interface OpenDocumentResult {
  docId: string
  model: DocumentModel
  fromCache: boolean
  relocated: number
  stale: number
}

interface DocumentsState {
  models: Record<string, DocumentModel>
  status: Record<string, 'loading' | 'ready' | 'error'>
  errors: Record<string, string>
  loadingDetail: Record<string, { page: number; total: number }>
  open: (filePath: string, options?: { force?: boolean }) => Promise<OpenDocumentResult | null>
  get: (docId: string) => DocumentModel | null
  /**
   * 只把"文本层映射"合并进已加载的模型。
   *
   * 为什么需要它：命中数据库缓存时不会重新解析，而映射表是解析阶段算出来的。
   * 阅读器补建映射后必须把它并回模型（只并映射、**不动块与正文**），
   * 否则"模型文本 A + 补建映射对应文本 B"会让除第 1 页外的所有页都判为不一致。
   */
  mergeTextLayerMapping: (docId: string, mapping: unknown) => void
  setStatus: (docId: string, status: 'loading' | 'ready' | 'error', error?: string) => void
  forget: (docId: string) => void
}

function recordToBlock(record: {
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
}): Block {
  return {
    id: record.id,
    docId: record.docId,
    seq: record.seq,
    kind: record.kind as Block['kind'],
    level: record.level ?? undefined,
    text: record.text,
    charStart: record.charStart,
    charEnd: record.charEnd,
    locator: JSON.parse(record.locatorJson),
    parentId: record.parentId ?? undefined
  }
}

function blockToRecord(block: Block): BlockRecordLike {
  return {
    id: block.id,
    docId: block.docId,
    seq: block.seq,
    kind: block.kind,
    level: block.level ?? null,
    text: block.text,
    charStart: block.charStart,
    charEnd: block.charEnd,
    locatorJson: JSON.stringify(block.locator),
    parentId: block.parentId ?? null
  }
}

export const useDocuments = create<DocumentsState>((set, get) => ({
  models: {},
  status: {},
  errors: {},
  loadingDetail: {},

  setStatus: (docId, status, error) =>
    set((state) => ({
      status: { ...state.status, [docId]: status },
      errors: error ? { ...state.errors, [docId]: error } : state.errors
    })),

  get: (docId) => get().models[docId] ?? null,

  forget: (docId) =>
    set((state) => {
      const models = { ...state.models }
      delete models[docId]
      return { models }
    }),

  mergeTextLayerMapping: (docId, mapping) =>
    set((state) => {
      const model = state.models[docId]
      if (!model || !mapping) return state
      return {
        models: {
          ...state.models,
          [docId]: { ...model, meta: { ...model.meta, textLayerMapping: mapping } }
        }
      }
    }),

  open: async (filePath, options) => {
    const stat = await api.fs.stat(filePath)
    if (!stat || !stat.isFile) {
      throw new Error('文件未找到：' + filePath)
    }
    const docHash = await api.fs.hash(filePath)
    const docId = 'doc_' + docHash.slice(0, 16)
    const cached = get().models[docId]
    if (cached && !options?.force) {
      return { docId, model: cached, fromCache: true, relocated: 0, stale: 0 }
    }

    const descriptor = describeFormat(filePath)
    const format: DocumentFormat = descriptor?.format ?? 'text'
    const title = stripExtension(basename(filePath)) || basename(filePath)

    set((state) => ({
      status: { ...state.status, [docId]: 'loading' },
      loadingDetail: { ...state.loadingDetail, [docId]: { page: 0, total: 0 } }
    }))

    try {
      // 命中数据库缓存则直接重建模型，避免重复解析
      const existing = await api.store.getDocument(docId)
      let model: DocumentModel | null = null
      // 解析器行为变化后，旧缓存必须作废，否则"旧块序 + 新映射"会错位
      const cachedMeta = existing?.metaJson ? (JSON.parse(existing.metaJson) as Record<string, unknown>) : {}
      const parserStale = cachedMeta.parserVersion !== PARSER_VERSION
      if (parserStale && existing) {
        void api.log.write('info', 'store', '解析器版本已更新，重新解析并覆盖缓存：' + filePath)
      }
      /**
       * 解析器行为变化后，**整个缓存必须作废**（块、正文、派生映射一起重算）。
       *
       * 这里曾经有个致命疏漏：parserStale 为真时虽然走了重新解析分支，
       * 但没有把 model 置空 —— 于是后面 `if (!model)` 里的"保存块"整段被跳过，
       * 库里留着旧解析器的 blocks（161334 字），内存里却是新解析器的正文（161435 字），
       * 派生出来的文本层映射自然整页错位（实测第 31 页偏 246 个字符）。
       * 教训：**"版本变了要重算"必须连持久化的那一份一起换掉**，只换内存等于没换。
       */
      const forceReparse = Boolean(existing) && (parserStale || Boolean(options?.force))
      if (existing && existing.docHash === docHash && !forceReparse) {
        const blocks = await api.store.getBlocks(docId)
        if (blocks.length > 0) {
          const outline = existing.outlineJson ? JSON.parse(existing.outlineJson) : []
          model = finalizeDocumentModel({
            docId,
            docHash,
            format: existing.format as DocumentFormat,
            title: existing.title,
            filePath,
            blocks: blocks.map(recordToBlock),
            text: '',
            outline,
            pageCount: existing.pageCount,
            meta: existing.metaJson ? JSON.parse(existing.metaJson) : {}
          })
        }
      }

      let fromCache = true
      if (!model) {
        fromCache = false
        // .doc / .ppt / .odt 等需要 LibreOffice 转 PDF 后复用 PDF 管线（规划书 §4.3）
        let readPath: string | undefined
        if (descriptor?.needsLibreOffice) {
          const availability = await api.convert.availability()
          if (!availability.available) {
            throw new Error(
              availability.reason ??
                '未检测到 LibreOffice，无法读取该格式。可在设置中指定 soffice.exe，或改用 .docx / .pptx。'
            )
          }
          readPath = await api.convert.toPdf(filePath, docHash)
        }
        model = await parseDocument({
          filePath,
          readPath,
          docId,
          docHash,
          format,
          title,
          onProgress: (info) =>
            set((state) => ({ loadingDetail: { ...state.loadingDetail, [docId]: info } }))
        })
        model.meta = { ...model.meta, parserVersion: PARSER_VERSION }
        await api.store.saveBlocks(docId, model.blocks.map(blockToRecord) as never)
        await api.store.upsertDocument({
          id: docId,
          path: filePath,
          format: model.format,
          title: model.title,
          docHash,
          sizeBytes: stat.size,
          pageCount: model.pageCount,
          textLength: model.text.length,
          outlineJson: JSON.stringify(model.outline),
          openedAt: Date.now(),
          lastPage: existing?.lastPage ?? 1,
          metaJson: JSON.stringify(model.meta)
        })
      }

      // 文档被外部修改：走锚点重定位
      let relocated = 0
      let stale = 0
      if (existing && existing.docHash !== docHash) {
        const anchors = await api.store.listAnchors(docId)
        const updates: typeof anchors = []
        for (const anchor of anchors) {
          const result = relocateRecord(anchor, model)
          if (result.method === 'stale') stale += 1
          else relocated += 1
          updates.push(result.record)
        }
        if (updates.length > 0) await api.store.saveAnchors(updates)
      }

      await api.fs.pushRecent({ path: filePath, title: model.title })

      set((state) => ({
        models: { ...state.models, [docId]: model as DocumentModel },
        status: { ...state.status, [docId]: 'ready' },
        errors: { ...state.errors, [docId]: '' }
      }))
      return { docId, model, fromCache, relocated, stale }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set((state) => ({
        status: { ...state.status, [docId]: 'error' },
        errors: { ...state.errors, [docId]: message }
      }))
      useNotifications.getState().notify({ message, severity: 'error', timeoutMs: 0 })
      return null
    }
  }
}))

/** 在渲染进程侧对锚点做一次重定位（与 document-model 的 relocateAnchor 等价，但作用于存储记录）。 */
function relocateRecord(
  anchor: {
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
  },
  model: DocumentModel
): { record: typeof anchor; method: 'hash' | 'exact' | 'fuzzy' | 'stale' } {
  const rebuilt: Anchor = {
    id: anchor.id,
    docId: anchor.docId,
    docHash: anchor.docHash,
    blockIds: JSON.parse(anchor.blockIds) as string[],
    charStart: anchor.charStart,
    charEnd: anchor.charEnd,
    quote: anchor.quote,
    quoteHash: anchor.quoteHash,
    primary: JSON.parse(anchor.primaryJson),
    extras: anchor.extrasJson ? JSON.parse(anchor.extrasJson) : [],
    status: anchor.status
  }
  const result = relocateAnchor(rebuilt, model)
  return {
    method: result.method,
    record: {
      ...anchor,
      docHash: result.anchor.docHash,
      blockIds: JSON.stringify(result.anchor.blockIds),
      charStart: result.anchor.charStart,
      charEnd: result.anchor.charEnd,
      quote: result.anchor.quote,
      quoteHash: result.anchor.quoteHash,
      primaryJson: JSON.stringify(result.anchor.primary),
      extrasJson: JSON.stringify(result.anchor.extras),
      status: result.anchor.status
    }
  }
}
