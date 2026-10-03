/**
 * 关系图服务（主进程）—— 规划书 §5.5：抽取管线、校验、合并、聚合、导出。
 * Map/Reduce 通过 AgentRuntime 调用本机 Agent，严格遵循"无锚点不入图"。
 */
import { createId } from '@logicreader/shared'
import type { GraphPrecision } from '@logicreader/shared'
import {
  chunkDocument,
  createAnchor,
  finalizeDocumentModel,
  estimateTokens,
  similarity,
  type Anchor,
  type Block,
  type DocumentModel
} from '@logicreader/document-model'
import {
  EDGE_KINDS,
  PRECISION_PROFILES,
  PROMPT_VERSION,
  emptyStats,
  parseExtraction,
  validateGraphDocument,
  type EdgeKind,
  type GraphEdge,
  type GraphNode,
  type GraphStats,
  type LogicGraph,
  type NodeKind
} from '@logicreader/graph-schema'
import { storeService } from './store.service'
import { agentRuntime } from './agent/runtime'
import { settingsService } from './settings.service'
import { logMain } from '../util/ipc'
import { resolveLocale } from '../util/locale'

export interface GraphGenerateRequest {
  docId: string
  graphId?: string | null
  agentId: string
  /** Agent 展示名（写入图谱元数据，便于复现） */
  agentName?: string
  modelId?: string | null
  thinkingEffort?: string | null
  precision: GraphPrecision
  scope?: 'full' | 'section' | 'from-page'
  sectionIds?: string[]
  fromPage?: number
  nodeLimit?: number
  edgeKinds?: string[]
  chunkTokens?: number
  concurrency?: number
  entityThreshold?: number
  locale?: string
}

export interface GraphProgress {
  taskId: string
  phase: 'prepare' | 'map' | 'reduce' | 'anchors' | 'persist' | 'done' | 'error'
  done: number
  total: number
  detail: string
  error?: string
}

export interface GraphEstimate {
  precision: GraphPrecision
  chunkCount: number
  documentTokens: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  minutes: [number, number]
  nodes: [number, number]
  edges: [number, number]
  costLevel: number
}

/** 取文档所在目录（Agent 工作目录 / --add-dir 用）。 */
function documentDirOf(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index > 0 ? normalized.slice(0, index) : null
}

function loadModel(docId: string): DocumentModel {
  const record = storeService.getDocument(docId)
  if (!record) throw new Error('文档未入库：' + docId)
  const blocks: Block[] = storeService.getBlocks(docId).map((row) => ({
    id: row.id,
    docId: row.docId,
    seq: row.seq,
    kind: row.kind as Block['kind'],
    level: row.level ?? undefined,
    text: row.text,
    charStart: row.charStart,
    charEnd: row.charEnd,
    locator: JSON.parse(row.locatorJson),
    parentId: row.parentId ?? undefined
  }))
  const outline = record.outlineJson ? JSON.parse(record.outlineJson) : []
  return finalizeDocumentModel({
    docId,
    docHash: record.docHash,
    format: record.format as DocumentModel['format'],
    title: record.title,
    filePath: record.path,
    blocks,
    text: '',
    outline,
    pageCount: record.pageCount,
    meta: record.metaJson ? JSON.parse(record.metaJson) : {}
  })
}

/** 代理套餐对「档位别名 / 思考强度」组合的拒付特征（403 / does not support / Token Plan 等）。 */
function isPlanRejection(message: string): boolean {
  return /403|does not support|token plan|not supported|unsupported/i.test(message)
}

/**
 * 单分块请求的最长等待：思考型代理模型偶发长时间空转，必须有兜底中断；
 * 但**上限不能拍脑袋定成一个常数** —— 它必须随分块体量走（§35 实测）：
 *
 * | 分块 | 实测耗时（xhigh） |
 * | --- | --- |
 * | 1.0k 字符 | 88~95 秒 |
 * | 4.6k 字符 | 131~134 秒 |
 * | 7.7k 字符（structure 档 ~3000 token 的英文块） | 推算 220 秒+，实测确实会顶穿 300 秒 |
 *
 * 早先固定 180 秒（后改 300 秒）时，大分块"其实做得出来却被掐掉"，三轮回试全被掐 → 分块全灭。
 * 现在按长度给预算：`60 秒 + 40 秒/千字符`（约为实测速率的 1.4 倍余量），
 * 下限 3 分钟（小分块也要给思考留时间）、上限 15 分钟（空转型模型仍会被中断）。
 */
const CHUNK_TIMEOUT_BASE_MS = 60000
const CHUNK_TIMEOUT_MS_PER_1K_CHARS = 40000
const CHUNK_TIMEOUT_MIN_MS = 180000
const CHUNK_TIMEOUT_MAX_MS = 900000

export function chunkTimeoutFor(chars: number): number {
  const budget = CHUNK_TIMEOUT_BASE_MS + CHUNK_TIMEOUT_MS_PER_1K_CHARS * (Math.max(0, chars) / 1000)
  return Math.round(Math.min(CHUNK_TIMEOUT_MAX_MS, Math.max(CHUNK_TIMEOUT_MIN_MS, budget)))
}

/** runOnce 超时中断的错误标识（与 agent runtime 的超时文案对应）。 */
function isChunkTimeout(message: string): boolean {
  return message.startsWith('分块请求超时')
}

function mapPrompt(input: {
  chunkText: string
  headingPath: string[]
  title: string
  charStart: number
  charEnd: number
  nodeKinds: string[]
  edgeKinds: string[]
  locale: string
}): string {
  const zh = input.locale.startsWith('zh')
  const kindList = input.nodeKinds.join(' | ')
  const edgeList = input.edgeKinds.join(' | ')
  if (zh) {
    return [
      '你是严谨的文档逻辑结构抽取器。下面给出《' + input.title + '》的一个片段。',
      '片段所属章节：' + (input.headingPath.length > 0 ? input.headingPath.join(' > ') : '（无标题）'),
      '该片段在全文中的字符范围：[ ' + input.charStart + ', ' + input.charEnd + ' )',
      '',
      '抽取要求：',
      '1. 只抽取片段中明确出现的内容，不要脑补；',
      '2. 节点类型只能是：' + kindList + '；',
      '3. 关系类型只能是：' + edgeList + '；',
      '4. 每个节点与每条关系都必须给出原文摘句 evidence，以及 spans（相对全文的字符范围，必须落在上面给出的区间内）；',
      '5. 无法给出原文依据的条目一律不要输出；',
      '6. 只输出 JSON，不要输出任何解释文字或 Markdown 代码围栏。',
      '7. 不要使用任何工具（不要读写文件、不要执行命令、不要联网检索），直接把 JSON 作为回答正文输出。',
      '',
      '输出结构：',
      '{"entities":[{"name":"简短名称(不超过14字)","type":"claim","summary":"一句话摘要(不超过40字)","evidence":"原文摘句","spans":[{"charStart":0,"charEnd":0}]}],',
      ' "relations":[{"from":"实体name","to":"实体name","type":"supports","label":"简短标签","evidence":"原文摘句","spans":[{"charStart":0,"charEnd":0}]}]}',
      '',
      '【片段原文】',
      input.chunkText
    ].join('\n')
  }
  return [
    'You are a rigorous document logic extractor. Below is a fragment of "' + input.title + '".',
    'Section: ' + (input.headingPath.length > 0 ? input.headingPath.join(' > ') : '(untitled)'),
    'Global character range: [ ' + input.charStart + ', ' + input.charEnd + ' )',
    '',
    'Rules:',
    '1. Extract only what is explicitly present.',
    '2. Node kinds: ' + kindList,
    '3. Edge kinds: ' + edgeList,
    '4. Every entity and relation must carry verbatim evidence and spans (global character offsets inside the range above).',
    '5. Drop anything without a source anchor.',
    '6. Output JSON only, no prose, no code fences.',
    '7. Do not use any tool (no file reads or writes, no shell commands, no web search); answer with the JSON body directly.',
    '',
    '{"entities":[{"name":"...","type":"claim","summary":"...","evidence":"...","spans":[{"charStart":0,"charEnd":0}]}],"relations":[{"from":"...","to":"...","type":"supports","label":"...","evidence":"...","spans":[{"charStart":0,"charEnd":0}]}]}',
    '',
    '[FRAGMENT]',
    input.chunkText
  ].join('\n')
}

/** 归一化实体名：去标点、去空白、小写（中文不做分词）。 */
function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u3000-\u303f\uff00-\uffef!-\/:-@\[-\x60{-\x7e]/g, '')
    .replace(/\s+/g, '')
    .trim()
}

export class GraphService {
  private cancelled = new Set<string>()

  cancel(taskId: string): void {
    this.cancelled.add(taskId)
  }

  estimate(request: GraphGenerateRequest): GraphEstimate {
    const model = loadModel(request.docId)
    const profile = PRECISION_PROFILES[request.precision] ?? PRECISION_PROFILES.structure
    const chunkTokens = request.chunkTokens ?? profile.targetTokens
    const chunks = chunkDocument(model, {
      targetTokens: chunkTokens,
      overlap: profile.overlap,
      headingLevel: profile.headingLevel
    })
    const documentTokens = estimateTokens(model.text)
    const weight = request.thinkingEffort === 'max' || request.thinkingEffort === 'xhigh' ? 1.8 : request.thinkingEffort === 'high' ? 1.35 : 1
    // Map 阶段把整篇文档送进模型；Reduce 阶段再消耗一部分
    const inputTokens = Math.round((documentTokens * 1.05 + chunks.length * 420) * weight)
    const outputTokens = Math.round((documentTokens * 0.28 + chunks.length * 260) * weight)
    const totalTokens = inputTokens + outputTokens
    const minutes: [number, number] = [
      Math.max(1, Math.round(totalTokens / 42000)),
      Math.max(2, Math.round(totalTokens / 16000))
    ]
    const scale = Math.min(2.2, Math.max(0.5, documentTokens / 18000))
    const nodeRange = profile.targetNodes
    return {
      precision: request.precision,
      chunkCount: chunks.length,
      documentTokens,
      inputTokens,
      outputTokens,
      totalTokens,
      minutes,
      nodes: [Math.round(nodeRange[0] * scale), Math.round(nodeRange[1] * scale)],
      edges: [Math.round(nodeRange[0] * scale * 1.8), Math.round(nodeRange[1] * scale * 1.9)],
      costLevel: profile.relativeCost
    }
  }

  async generate(
    request: GraphGenerateRequest,
    onProgress: (progress: GraphProgress) => void,
    taskId = createId('task')
  ): Promise<LogicGraph> {
    const started = Date.now()
    this.cancelled.delete(taskId)
    const locale = request.locale ?? resolveLocale()
    const settings = settingsService.all()
    const profile = PRECISION_PROFILES[request.precision] ?? PRECISION_PROFILES.structure
    const model = loadModel(request.docId)
    if (model.text.trim().length === 0) throw new Error('文档没有可抽取的文本（扫描版 PDF 需要 OCR，属于二期能力）')

    onProgress({ taskId, phase: 'prepare', done: 0, total: 1, detail: '分块中' })
    let chunks = chunkDocument(model, {
      targetTokens: request.chunkTokens ?? profile.targetTokens,
      overlap: profile.overlap,
      headingLevel: profile.headingLevel
    })
    if (request.scope === 'section' && request.sectionIds && request.sectionIds.length > 0) {
      chunks = chunks.filter((chunk) => chunk.sectionId && request.sectionIds?.includes(chunk.sectionId))
    }
    if (request.scope === 'from-page' && request.fromPage) {
      const fromChar =
        model.blocks.find((block) => block.locator.kind === 'pdf' && block.locator.page >= (request.fromPage ?? 1))?.charStart ?? 0
      chunks = chunks.filter((chunk) => chunk.charEnd > fromChar)
    }
    if (chunks.length === 0) throw new Error('没有可抽取的分块')

    const edgeWhitelist = (request.edgeKinds && request.edgeKinds.length > 0
      ? request.edgeKinds
      : profile.edgeKindWhitelist ?? [...EDGE_KINDS]) as EdgeKind[]
    const nodeWhitelist = profile.nodeKindWhitelist

    interface RawEntity {
      name: string
      kind: NodeKind
      summary: string
      evidence: string
      charStart: number
      charEnd: number
      chunkIndex: number
      headingPath: string[]
      weight: number
    }
    interface RawRelation {
      from: string
      to: string
      kind: EdgeKind
      label: string
      evidence: string
      charStart: number
      charEnd: number
    }

    const entities: RawEntity[] = []
    const relations: RawRelation[] = []
    let failedChunks = 0
    let emptyChunks = 0
    const warnings: string[] = []
    const concurrency = Math.max(1, Math.min(6, request.concurrency ?? settings.graph.concurrency))

    const runChunk = async (index: number): Promise<void> => {
      const chunk = chunks[index]
      if (this.cancelled.has(taskId)) return
      const prompt = mapPrompt({
        chunkText: chunk.text,
        headingPath: chunk.headingPath,
        title: model.title,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
        nodeKinds: nodeWhitelist ?? ['claim', 'conclusion', 'evidence', 'definition', 'data', 'method'],
        edgeKinds: edgeWhitelist,
        locale
      })
      let raw = ''
      let parsed: ReturnType<typeof parseExtraction> | null = null
      let lastTimedOut = false
      let lastChunkError: string | null = null
      for (let tryIndex = 0; tryIndex < 3; tryIndex += 1) {
        const suffix =
          tryIndex === 0
            ? ''
            : '\n\n注意：上一次输出未通过校验（' +
              (parsed?.issues.slice(0, 3).map((issue) => issue.path + ' ' + issue.message).join('; ') ?? '') +
              '），请严格按要求只输出合法 JSON。'
        // 代理套餐可能对「档位别名 / 思考强度」组合拒付（403 does not support …）：
        // 自动降级重试 —— 先去掉思考强度、再落到默认模型；每步降级记入 warnings（图报告可见）
        const attempts: { modelId: string | null; effort: string | null; note: string | null }[] = []
        // 思考型代理模型在高强度下偶发长时间空转：上次超时后，先把思考强度压到 low 抢一次快答
        if (lastTimedOut && (request.thinkingEffort ?? null) !== 'low') {
          attempts.push({ modelId: request.modelId ?? null, effort: 'low', note: '上次请求超时，已降低思考强度重试' })
        }
        attempts.push({ modelId: request.modelId ?? null, effort: request.thinkingEffort ?? null, note: null })
        if ((request.thinkingEffort ?? null) !== null) {
          attempts.push({ modelId: request.modelId ?? null, effort: null, note: '思考强度不被支持，已自动降级' })
        }
        if ((request.modelId ?? null) !== null) {
          attempts.push({ modelId: null, effort: null, note: '指定模型档位不被支持，已改用默认模型' })
        }
        let result: { text: string; sessionId: string } | null = null
        let lastError: unknown = null
        let timedOut = false
        for (const attempt of attempts) {
          try {
            result = await agentRuntime.runOnce({
              agentId: request.agentId,
              prompt: prompt + suffix,
              modelId: attempt.modelId,
              thinkingEffort: attempt.effort,
              contextMode: 'fulltext',
              documentDir: documentDirOf(model.filePath),
              // 超时预算随分块长度走：大块需要更长的思考时间，小块不必等那么久（见 chunkTimeoutFor）
              timeoutMs: chunkTimeoutFor(chunk.text.length)
            })
            if (attempt.note) {
              warnings.push('分块 ' + index + '：' + attempt.note)
              logMain('warn', 'graph', '分块 ' + index + ' ' + attempt.note)
            }
            break
          } catch (error) {
            lastError = error
            const message = error instanceof Error ? error.message : String(error)
            if (isPlanRejection(message)) continue
            if (isChunkTimeout(message)) {
              // 超时不判死：当前会话已被中断，记入告警后跳到下一轮重试（思考强度自动降级）
              timedOut = true
              lastTimedOut = true
              lastChunkError = message
              warnings.push('分块 ' + index + '：' + message)
              logMain('warn', 'graph', '分块 ' + index + ' ' + message)
              break
            }
            throw error
          }
        }
        if (timedOut) continue
        if (!result) throw lastError ?? new Error('分块请求失败')
        raw = result.text
        parsed = parseExtraction(raw, {
          charStart: chunk.charStart,
          charEnd: chunk.charEnd,
          nodeKindWhitelist: nodeWhitelist,
          edgeKindWhitelist: edgeWhitelist
        })
        /**
         * 合法的空结果（只含标题 / 参考文献的短分块最常见）就是最终答案，不再重试：
         * 一轮抽取动辄分钟级，拿「0 实体」当失败反复重试既没有信息增量，又把整篇拖成几倍时长。
         * 只有**压根没解析出 JSON**（模型跑题、空响应）才值得再换一轮。
         */
        if (parsed.ok && parsed.value) break
      }
      if (!parsed || !parsed.ok || !parsed.value) {
        failedChunks += 1
        // 排障关键证据：解析问题 + 模型原文开头（截断）。没有这两样，代理模型的输出问题无从定位
        const detail =
          parsed && parsed.issues.length > 0
            ? parsed.issues.slice(0, 3).map((issue) => issue.path + ' ' + issue.message).join('; ')
            : (lastChunkError ?? '模型未产出任何实体')
        const head = raw.replace(/\s+/g, ' ').slice(0, 160)
        const message = '分块 ' + index + ' 校验失败：' + detail + '｜原文开头：' + head
        warnings.push(message)
        logMain('warn', 'graph', message)
        return
      }
      if (parsed.value.entities.length === 0) {
        emptyChunks += 1
        logMain('debug', 'graph', '分块 ' + index + ' 返回合法空结果（该块没有可抽取的实体）')
        return
      }
      const extracted = parsed.value
      for (const entity of extracted.entities) {
        const span = entity.spans[0]
        entities.push({
          name: entity.name.slice(0, 28),
          kind: entity.kind,
          summary: entity.summary.slice(0, 120),
          evidence: entity.evidence,
          charStart: span.charStart,
          charEnd: span.charEnd,
          chunkIndex: index,
          headingPath: chunk.headingPath,
          weight: entity.spans.length
        })
      }
      for (const relation of extracted.relations) {
        const span = relation.spans[0]
        relations.push({
          from: relation.from,
          to: relation.to,
          kind: relation.kind,
          label: relation.label.slice(0, 24),
          evidence: relation.evidence,
          charStart: span.charStart,
          charEnd: span.charEnd
        })
      }
      onProgress({
        taskId,
        phase: 'map',
        done: index + 1,
        total: chunks.length,
        detail: '已抽取 ' + entities.length + ' 个节点'
      })
    }

    let cursor = 0
    const workers = Array.from({ length: concurrency }, async () => {
      while (cursor < chunks.length && !this.cancelled.has(taskId)) {
        const index = cursor
        cursor += 1
        try {
          await runChunk(index)
        } catch (error) {
          failedChunks += 1
          warnings.push('分块 ' + index + ' 失败：' + (error instanceof Error ? error.message : String(error)))
          onProgress({ taskId, phase: 'map', done: index + 1, total: chunks.length, detail: '分块失败，继续' })
        }
      }
    })
    await Promise.all(workers)

    if (this.cancelled.has(taskId)) throw new Error('cancelled')

    onProgress({ taskId, phase: 'reduce', done: 0, total: 1, detail: '实体消解与合并' })
    const threshold = request.entityThreshold ?? settings.graph.entityResolutionThreshold
    const canonical = new Map<string, RawEntity>()
    let mergedEntities = 0
    for (const entity of entities) {
      const key = normalizeName(entity.name)
      if (key.length === 0) continue
      if (canonical.has(key)) {
        const existing = canonical.get(key) as RawEntity
        existing.weight += 1
        if (entity.summary.length > existing.summary.length) existing.summary = entity.summary
        mergedEntities += 1
        continue
      }
      let mergedInto: string | null = null
      for (const otherKey of canonical.keys()) {
        if (Math.abs(otherKey.length - key.length) > 4) continue
        if (similarity(otherKey, key) >= threshold) {
          mergedInto = otherKey
          break
        }
      }
      if (mergedInto) {
        const existing = canonical.get(mergedInto) as RawEntity
        existing.weight += 1
        mergedEntities += 1
        continue
      }
      canonical.set(key, { ...entity })
    }

    // 名称 → 规范键（保证 relations 能找到节点）
    const nameToKey = new Map<string, string>()
    const resolveKey = (name: string): string | null => {
      const key = normalizeName(name)
      if (key.length === 0) return null
      if (canonical.has(key)) return key
      const cached = nameToKey.get(key)
      if (cached) return cached
      for (const candidate of canonical.keys()) {
        if (Math.abs(candidate.length - key.length) > 4) continue
        if (similarity(candidate, key) >= threshold) {
          nameToKey.set(key, candidate)
          return candidate
        }
      }
      return null
    }

    const nodeByKey = new Map<string, GraphNode>()
    for (const [key, entity] of canonical) {
      nodeByKey.set(key, {
        id: createId('n'),
        kind: entity.kind,
        title: entity.name.slice(0, 28),
        summary: entity.summary,
        anchorIds: [],
        parentId: null,
        clusterId: null,
        x: null,
        y: null,
        collapsed: false,
        meta: {
          charStart: entity.charStart,
          charEnd: entity.charEnd,
          headingPath: entity.headingPath,
          weight: entity.weight,
          evidence: entity.evidence
        }
      })
    }

    const edgeMap = new Map<string, GraphEdge>()
    for (const relation of relations) {
      const fromKey = resolveKey(relation.from)
      const toKey = resolveKey(relation.to)
      if (!fromKey || !toKey || fromKey === toKey) continue
      const fromId = nodeByKey.get(fromKey)?.id
      const toId = nodeByKey.get(toKey)?.id
      if (!fromId || !toId) continue
      const key = fromId + '>' + toId + '#' + relation.kind
      const existing = edgeMap.get(key)
      if (existing) {
        existing.weight += 1
        const spans = ((existing.meta?.spans as { charStart: number; charEnd: number }[] | undefined) ?? []).concat([
          { charStart: relation.charStart, charEnd: relation.charEnd }
        ])
        existing.meta = { ...(existing.meta ?? {}), spans }
        continue
      }
      edgeMap.set(key, {
        id: createId('e'),
        from: fromId,
        to: toId,
        kind: relation.kind,
        label: relation.label,
        anchorIds: [],
        weight: 1,
        meta: {
          evidence: relation.evidence,
          charStart: relation.charStart,
          charEnd: relation.charEnd,
          spans: [{ charStart: relation.charStart, charEnd: relation.charEnd }]
        }
      })
    }

    // 丢弃孤立节点（结论类型除外）
    const degree = new Map<string, number>()
    for (const edge of edgeMap.values()) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + edge.weight)
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + edge.weight)
    }
    let isolatedNodes = 0
    for (const [key, node] of [...nodeByKey]) {
      if ((degree.get(node.id) ?? 0) === 0 && node.kind !== 'conclusion') {
        nodeByKey.delete(key)
        isolatedNodes += 1
      }
    }

    const limit = request.nodeLimit ?? settings.graph.targetNodeLimit
    if (nodeByKey.size > limit) {
      const sorted = [...nodeByKey.values()].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
      const keep = new Set(sorted.slice(0, limit).map((node) => node.id))
      for (const [key, node] of [...nodeByKey]) if (!keep.has(node.id)) nodeByKey.delete(key)
    }

    const keptIds = new Set([...nodeByKey.values()].map((node) => node.id))
    for (const [key, edge] of [...edgeMap]) {
      if (!keptIds.has(edge.from) || !keptIds.has(edge.to)) edgeMap.delete(key)
    }

    onProgress({ taskId, phase: 'anchors', done: 0, total: 1, detail: '建立锚点与层级' })
    const sectionNodes = new Map<string, GraphNode>()
    for (const node of nodeByKey.values()) {
      const path = (node.meta?.headingPath as string[] | undefined) ?? []
      if (path.length === 0) continue
      const sectionTitle = path[path.length - 1]
      if (!sectionNodes.has(sectionTitle)) {
        const heading = model.blocks.find((block) => block.kind === 'heading' && block.text.includes(sectionTitle.slice(0, 12)))
        if (!heading) continue
        sectionNodes.set(sectionTitle, {
          id: createId('sec'),
          kind: 'definition',
          title: sectionTitle.slice(0, 28),
          summary: '',
          anchorIds: [],
          parentId: null,
          clusterId: null,
          x: null,
          y: null,
          collapsed: true,
          meta: {
            isSection: true,
            charStart: heading.charStart,
            charEnd: Math.min(heading.charEnd, heading.charStart + 200),
            evidence: heading.text
          }
        })
      }
      node.parentId = sectionNodes.get(sectionTitle)?.id ?? null
    }

    const anchorRecords: Anchor[] = []
    const persistAnchor = (charStart: number, charEnd: number): string => {
      const anchor = createAnchor({
        model,
        charStart: Math.max(0, charStart),
        charEnd: Math.max(charStart + 1, charEnd),
        origin: 'graph'
      })
      anchorRecords.push(anchor)
      return anchor.id
    }

    for (const node of [...sectionNodes.values(), ...nodeByKey.values()]) {
      const charStart = Number(node.meta?.charStart ?? 0)
      const charEnd = Number(node.meta?.charEnd ?? charStart + 1)
      node.anchorIds = [persistAnchor(charStart, charEnd)]
    }
    for (const edge of edgeMap.values()) {
      const meta = edge.meta ?? {}
      const spans = (meta.spans as { charStart: number; charEnd: number }[] | undefined) ?? []
      const ids: string[] = []
      for (const span of spans.slice(0, 8)) ids.push(persistAnchor(span.charStart, span.charEnd))
      if (ids.length === 0) {
        const charStart = Number(meta.charStart ?? 0)
        ids.push(persistAnchor(charStart, charStart + 1))
      }
      edge.anchorIds = ids
    }

    for (const [key, edge] of [...edgeMap]) {
      if (edgeWhitelist.length > 0 && !edgeWhitelist.includes(edge.kind)) edgeMap.delete(key)
    }
    // 权重阈值：短文档或单轮抽取时每条边只出现一次，
    // 直接按 minEdgeWeight 过滤会把所有连线清空（图就失去了意义），因此保底保留权重 1 的边。
    const weightThreshold = chunks.length > 3 ? profile.minEdgeWeight : 1
    const byWeight = new Map([...edgeMap].filter(([, edge]) => edge.weight >= weightThreshold))
    if (byWeight.size === 0 && edgeMap.size > 0) {
      logMain('info', 'graph', '按权重阈值过滤后无连线，已回退为保留全部连线（阈值 ' + weightThreshold + '）')
    } else {
      edgeMap.clear()
      for (const [key, edge] of byWeight) edgeMap.set(key, edge)
    }

    onProgress({ taskId, phase: 'persist', done: 0, total: 1, detail: '写入数据库' })
    storeService.saveAnchors(
      anchorRecords.map((anchor) => ({
        id: anchor.id,
        docId: anchor.docId,
        docHash: anchor.docHash,
        blockIds: JSON.stringify(anchor.blockIds),
        charStart: anchor.charStart,
        charEnd: anchor.charEnd,
        quote: anchor.quote,
        quoteHash: anchor.quoteHash,
        primaryJson: JSON.stringify(anchor.primary),
        extrasJson: JSON.stringify(anchor.extras),
        status: anchor.status
      }))
    )

    const nodes = [...sectionNodes.values(), ...nodeByKey.values()]
    const edges = [...edgeMap.values()]
    const covered = nodes.filter((node) => node.anchorIds.length > 0).length
    if (nodes.length === 0 && edges.length === 0 && failedChunks === 0) {
      // 全部分块都「解析成功但没实体」不是技术故障，得把话说清楚，别让用户以为工具坏了
      warnings.push('所有分块都返回了合法但空的抽取结果：模型没有抽到任何实体（可换更高精度档位或换模型）')
    }
    const stats: GraphStats = {
      ...emptyStats(),
      nodeCount: nodes.length,
      edgeCount: edges.length,
      anchorCoverage: nodes.length > 0 ? covered / nodes.length : 0,
      failedChunks,
      isolatedNodes,
      avgEvidenceLength:
        edges.length > 0
          ? Math.round(edges.reduce((sum, edge) => sum + String(edge.meta?.evidence ?? '').length, 0) / edges.length)
          : 0,
      mergedEntities,
      elapsedMs: Date.now() - started
    }

    const graph: LogicGraph = {
      id: request.graphId && request.graphId.length > 0 ? request.graphId : createId('graph'),
      docId: request.docId,
      docHash: model.docHash,
      title: graphDisplayTitle(model.title, locale),
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: failedChunks > 0 ? 'partial' : 'done',
      generation: {
        agentId: request.agentId,
        agentName: request.agentName ?? request.agentId,
        modelId: request.modelId ?? null,
        thinkingEffort: request.thinkingEffort ?? null,
        precision: request.precision,
        promptVersion: PROMPT_VERSION,
        scope: request.scope ?? 'full'
      },
      nodes,
      edges,
      stats,
      ignoredEdges: [],
      error: warnings.length > 0 ? warnings.slice(0, 12).join('\n') : null
    }

    if (nodes.length === 0 && edges.length === 0) {
      // 空结果不入库：否则会盖掉历史里的好图（reload 总取最新一条）；失败证据留在日志与返回值里
      logMain('warn', 'graph', '生成结果为空（失败分块 ' + failedChunks + '），不入库：' + (graph.error ?? ''))
    } else {
      const previous = request.graphId ? storeService.graphGet(request.graphId) : null
      if (previous) mergeHumanEdits(graph, previous)
      storeService.graphSave(graph)
    }
    onProgress({ taskId, phase: 'done', done: 1, total: 1, detail: '关系图已生成' })
    logMain(
      'info',
      'graph',
      '关系图生成完成：' + nodes.length + ' 节点 / ' + edges.length + ' 连线，失败分块 ' + failedChunks + '，空结果分块 ' + emptyChunks
    )
    return graph
  }

  async refine(
    request: GraphGenerateRequest,
    onProgress: (progress: GraphProgress) => void,
    taskId = createId('task')
  ): Promise<LogicGraph> {
    return this.generate({ ...request, graphId: request.graphId ?? null }, onProgress, taskId)
  }

  importFromJson(payload: unknown): LogicGraph {
    const result = validateGraphDocument(payload)
    if (!result.ok || !result.value) {
      throw new Error('导入失败：' + result.issues.slice(0, 5).map((issue) => issue.path + ' ' + issue.message).join('; '))
    }
    const graph = result.value
    const anchors: {
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
    }[] = []
    for (const node of graph.nodes) {
      const ids: string[] = []
      for (const anchor of node.anchors ?? []) {
        const id = createId('anc')
        ids.push(id)
        anchors.push({
          id,
          docId: anchor.docId,
          docHash: anchor.docHash,
          blockIds: '[]',
          charStart: anchor.charStart,
          charEnd: anchor.charEnd,
          quote: anchor.quote,
          quoteHash: '',
          primaryJson: JSON.stringify(anchor.primary ?? { kind: 'text', line: 1, column: 0 }),
          extrasJson: JSON.stringify(anchor.extras ?? []),
          status: 'ok'
        })
      }
      node.anchorIds = ids.length > 0 ? ids : node.anchorIds
    }
    for (const edge of graph.edges) {
      const ids: string[] = []
      for (const anchor of edge.anchors ?? []) {
        const id = createId('anc')
        ids.push(id)
        anchors.push({
          id,
          docId: anchor.docId,
          docHash: anchor.docHash,
          blockIds: '[]',
          charStart: anchor.charStart,
          charEnd: anchor.charEnd,
          quote: anchor.quote,
          quoteHash: '',
          primaryJson: JSON.stringify(anchor.primary ?? { kind: 'text', line: 1, column: 0 }),
          extrasJson: JSON.stringify(anchor.extras ?? []),
          status: 'ok'
        })
      }
      if (ids.length > 0) edge.anchorIds = ids
    }
    if (anchors.length > 0) storeService.saveAnchors(anchors)
    storeService.graphSave(graph)
    return graph
  }

  exportMarkdown(graphId: string): string {
    const graph = storeService.graphGet(graphId)
    if (!graph) throw new Error('关系图不存在')
    const byId = new Map(graph.nodes.map((node) => [node.id, node]))
    const lines: string[] = [
      '# ' + (graph.title || '逻辑关系图'),
      '',
      '> 由 ' + (graph.generation.agentName || graph.generation.agentId) + ' · ' + (graph.generation.modelId ?? '-') + ' 生成',
      ''
    ]
    const render = (node: GraphNode, depth: number): void => {
      const indent = '  '.repeat(depth)
      const anchor = node.anchors?.[0]
      lines.push(indent + '- **' + node.title + '**' + (node.summary ? '：' + node.summary : ''))
      if (anchor) lines.push(indent + '  - 出处：' + anchor.quote.slice(0, 80).replace(/\s+/g, ' '))
      for (const edge of graph.edges.filter((item) => item.from === node.id)) {
        const target = byId.get(edge.to)
        if (!target) continue
        lines.push(indent + '  - ' + edge.kind + ' → ' + target.title + (edge.label ? '（' + edge.label + '）' : ''))
      }
      for (const child of graph.nodes.filter((item) => item.parentId === node.id)) render(child, depth + 1)
    }
    const sections = graph.nodes.filter((node) => node.meta?.isSection)
    for (const section of sections) {
      lines.push('## ' + section.title)
      for (const child of graph.nodes.filter((node) => node.parentId === section.id)) render(child, 0)
      lines.push('')
    }
    for (const root of graph.nodes.filter((node) => !node.meta?.isSection && !node.parentId)) render(root, 0)
    return lines.join('\n')
  }

  /**
   * 关系图 → SVG 文本。
   *
   * @param options.background 底色：传颜色画一层底（导出 `.svg` 用白色、`.jpg` 用界面画布色）；
   *        传 `null` / 不传则不画底 —— 导出 `.png` 时保持透明。
   *        这个值会被拼进 SVG 属性里，所以只接受白名单形式（见 normalizeSvgColor）。
   */
  renderSvg(graphId: string, options: { background?: string | null } = {}): string {
    const graph = storeService.graphGet(graphId)
    if (!graph) throw new Error('关系图不存在')
    const positions = new Map<string, { x: number; y: number }>()
    graph.nodes.forEach((node, index) => {
      positions.set(node.id, { x: node.x ?? (index % 8) * 300, y: node.y ?? Math.floor(index / 8) * 140 })
    })
    const width = Math.max(1200, ...[...positions.values()].map((point) => point.x + 320))
    const height = Math.max(800, ...[...positions.values()].map((point) => point.y + 200))
    const background = normalizeSvgColor(options.background)
    const parts: string[] = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">',
      '<defs><marker id="arrow" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 z" fill="#888"/></marker></defs>'
    ]
    // 不画底 = 透明（PNG）；画底 = 白（.svg）或用户界面上的画布色（JPG）
    if (background) parts.push('<rect width="100%" height="100%" fill="' + background + '"/>')
    for (const edge of graph.edges) {
      const from = positions.get(edge.from)
      const to = positions.get(edge.to)
      if (!from || !to) continue
      parts.push(
        '<line x1="' + (from.x + 130) + '" y1="' + (from.y + 28) + '" x2="' + (to.x + 130) + '" y2="' + (to.y + 28) + '" stroke="#9a9a9a" stroke-width="1.5" marker-end="url(#arrow)"/>'
      )
      parts.push(
        '<text x="' + ((from.x + to.x) / 2 + 130) + '" y="' + ((from.y + to.y) / 2 + 20) + '" font-size="11" fill="#666" text-anchor="middle">' +
          escapeXml(edge.label || edge.kind) +
          '</text>'
      )
    }
    for (const node of graph.nodes) {
      const point = positions.get(node.id)
      if (!point) continue
      parts.push(
        '<g><rect x="' + point.x + '" y="' + point.y + '" width="260" height="56" rx="8" fill="#ffffff" stroke="#d4d4d4"/>' +
          '<rect x="' + point.x + '" y="' + point.y + '" width="3" height="56" fill="' + kindColor(node.kind) + '"/>' +
          '<text x="' + (point.x + 14) + '" y="' + (point.y + 24) + '" font-size="13" fill="#1f1f1f">' + escapeXml(node.title) + '</text>' +
          '<text x="' + (point.x + 14) + '" y="' + (point.y + 44) + '" font-size="11" fill="#777">' + escapeXml(node.summary.slice(0, 30)) + '</text></g>'
      )
    }
    parts.push('</svg>')
    return parts.join('\n')
  }

  /** 导出 `.svg`：保持原有的白底（历史行为，不改） */
  exportSvg(graphId: string): string {
    return this.renderSvg(graphId, { background: '#ffffff' })
  }
}

/**
 * 只放行白名单形式的颜色：`#rgb` / `#rrggbb` / `rgb()` / `rgba()`。
 *
 * 这个值来自渲染进程（`getComputedStyle` 读到的画布底色）并会被拼进 SVG 标记里，
 * 不做校验就等于把任意字符串写进标记（可注入属性/脚本）。
 * 完全透明（alpha=0）视为"不画底"。
 */
function normalizeSvgColor(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (/^#[0-9a-f]{3}$/i.test(text) || /^#[0-9a-f]{6}$/i.test(text)) return text
  const match = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([01]|0?\.\d+)\s*)?\)$/i.exec(text)
  if (!match) return null
  const alpha = match[4] == null ? 1 : Number(match[4])
  if (!(alpha > 0)) return null
  return text
}

/**
 * 关系图的落库标题：**文档名 + 逻辑关系图**（与渲染进程的 `lib/graphName` 同一规则）。
 *
 * 主进程这边按系统/界面语言取后缀 —— 这个标题会出现在导出产物里
 * （Markdown 的 H1、导出对话框的默认文件名），只写文档名的话认不出这是图还是原文。
 */
const GRAPH_TITLE_SUFFIX: Record<'zh-CN' | 'en-US', string> = {
  'zh-CN': '逻辑关系图',
  'en-US': 'Logic Graph'
}

function graphDisplayTitle(docTitle: string, locale: string): string {
  const suffix = GRAPH_TITLE_SUFFIX[locale.toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN']
  const name = (docTitle || '').trim()
  return name ? name + ' · ' + suffix : suffix
}

function kindColor(kind: string): string {
  const map: Record<string, string> = {
    claim: '#3d7fd1',
    conclusion: '#c98a2e',
    evidence: '#3f9e46',
    definition: '#2aa5a5',
    data: '#8a5cd1',
    method: '#5b7f95',
    inquiry: '#e0713a',
    selection: '#8a8a8a'
  }
  return map[kind] ?? '#8a8a8a'
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[char] ?? char)
}

/** 重生成时保留人工编辑（规划书 §5.5.3.6）。 */
function mergeHumanEdits(next: LogicGraph, previous: LogicGraph): void {
  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]))
  const byTitle = new Map(previous.nodes.map((node) => [normalizeName(node.title), node]))
  for (const node of next.nodes) {
    const old = previousNodes.get(node.id) ?? byTitle.get(normalizeName(node.title))
    if (!old) continue
    if (old.pinned?.title) node.title = old.title
    if (old.pinned?.position && old.x != null && old.y != null) {
      node.x = old.x
      node.y = old.y
    }
    if (old.collapsed) node.collapsed = true
    node.pinned = old.pinned
  }
  const titleOf = new Map(previous.nodes.map((node) => [node.id, normalizeName(node.title)]))
  const ignored = new Set(
    (previous.ignoredEdges ?? []).map((edge) => (titleOf.get(edge.from) ?? edge.from) + '>' + (titleOf.get(edge.to) ?? edge.to) + '#' + edge.kind)
  )
  next.ignoredEdges = previous.ignoredEdges ?? []
  next.edges = next.edges.filter((edge) => {
    const signature = normalizeName(byTitleId(next, edge.from)) + '>' + normalizeName(byTitleId(next, edge.to)) + '#' + edge.kind
    return !ignored.has(signature)
  })
}

function byTitleId(graph: LogicGraph, id: string): string {
  return graph.nodes.find((node) => node.id === id)?.title ?? id
}

export const graphService = new GraphService()
