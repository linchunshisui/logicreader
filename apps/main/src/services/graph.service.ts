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
  NODE_KIND_COLOR,
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
  /** 增量重试：只重跑这些下标的分块（其余实体/连线从 graphId 对应的旧图继承） */
  retryChunkIndexes?: number[]
  locale?: string
}

export interface GraphProgress {
  taskId: string
  phase: 'prepare' | 'map' | 'reduce' | 'anchors' | 'persist' | 'done' | 'error'
  done: number
  total: number
  detail: string
  /** 预计剩余毫秒（运行中按已完成分块的实测速率滚动估计；null = 还没有可靠样本） */
  etaMs?: number | null
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
  /** 单块目标体量（字符），供界面展示"每块约多久" */
  chunkChars: number
  /** 依据历史统计的校准说明（首次使用为 null） */
  basis: 'history' | 'heuristic'
  /** 历史校准样本数（同文档 / 同模型的过去几轮） */
  historySamples: number
}

/** 取文档所在目录（Agent 工作目录 / --add-dir 用）。 */
function documentDirOf(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index > 0 ? normalized.slice(0, index) : null
}

function loadModel(docId: string, options: { fresh?: boolean } = {}): DocumentModel {
  const record = storeService.getDocument(docId)
  if (!record) throw new Error('文档未入库：' + docId)
  const cached = modelCache.get(docId)
  // fresh（generate 路径）不走缓存：文档可能被重新解析而 docHash 未变（块切分策略升级等），必须以库里最新块为准
  if (!options.fresh && cached && cached.hash === record.docHash) return cached.model
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
  const model = finalizeDocumentModel({
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
  /**
   * 按文档缓存（docHash 失效即弃）：生成对话框里**每一次**下拉变化都会发一次 estimate IPC，
   * 每次都全量读块 + JSON.parse + 重拼全文是纯重复劳动；同文档反复预估是常态路径。
   * 只缓存最近 4 篇 —— 阅读器场景足够，内存不会滚大。
   */
  modelCache.delete(docId)
  modelCache.set(docId, { hash: record.docHash, model })
  if (modelCache.size > 4) modelCache.delete(modelCache.keys().next().value as string)
  return model
}
const modelCache = new Map<string, { hash: string; model: DocumentModel }>()

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

/**
 * 思考强度对**耗时**的放大系数（对 token 同样适用——思考 token 也计费）。
 * 依据 §53/§54 实测：同机同模型 xhigh 单块 88~300 秒，low 一次 21.7 秒，medium 介于其间。
 * 未指定档位时按 medium 系数（用户全局 effortLevel 生效的现实，取偏保守值）。
 */
export function effortTimeFactor(effort: string | null | undefined): number {
  switch (effort) {
    case 'off':
    case 'none':
      return 0.7
    case 'low':
    case 'minimal':
      return 0.9
    case 'medium':
    case null:
    case undefined:
      return 1
    case 'high':
      return 1.6
    case 'xhigh':
    case 'max':
      return 2.6
    default:
      return 1
  }
}

/** 档位抽取密度（实体数 / 千字符），决定输出 token 量与提示词里的数量指导。 */
export function profileDensityPerKiloChars(profile: { id: GraphPrecision }): number {
  switch (profile.id) {
    case 'skeleton':
      return 1.5
    case 'structure':
      return 3.5
    case 'panorama':
      return 7
    default:
      return 4
  }
}

/** runOnce 超时中断的错误标识（与 agent runtime 的超时文案对应）。 */
function isChunkTimeout(message: string): boolean {
  return message.startsWith('分块请求超时')
}

/**
 * 用历史耗时样本校准整篇预估：样本折成"单波耗时"，按本轮波数外推。
 * 纯函数（样本由调用方从 graphs 表取），便于单测钉住行为。
 */
export function estimateMinutesFromHistory(
  samples: { elapsedMs: number; chunkCount: number; concurrency: number }[],
  chunkCount: number,
  concurrency: number
): { minutes: [number, number]; samples: number } | null {
  if (samples.length === 0) return null
  // 单波耗时 = 整篇耗时 / 波数；耗时随波数近似线性（并发恒定时单块耗时稳定）
  const perWave = samples
    .map((s) => s.elapsedMs / Math.max(1, Math.ceil(s.chunkCount / Math.max(1, s.concurrency))))
    .filter((v) => Number.isFinite(v) && v > 0)
  if (perWave.length === 0) return null
  perWave.sort((a, b) => a - b)
  const mid = perWave[Math.floor(perWave.length / 2)]
  const waves = Math.ceil(chunkCount / concurrency)
  const low = Math.max(1, Math.round((waves * mid * 0.7) / 60000))
  const high = Math.max(low + 1, Math.round((waves * mid * 1.6) / 60000))
  return { minutes: [low, high], samples: perWave.length }
}

/**
 * 无历史时的启发式：一次性会话冷启动 ~12 秒 + 单块处理时间（随块体量与思考强度），乘波数。
 * 速率依据 §54 实测（xhigh）：1k 字符 ≈ 88 秒、4.6k ≈ 131 秒 —— 折算约「60 秒基础 + 15 秒/千字符」，
 * 思考强度系数作用在处理时间上（冷启动与思考强度无关），整篇再留 15% 波间抖动余量。
 */
export function heuristicMinutes(chunkCount: number, concurrency: number, chunkChars: number, effortFactor: number): [number, number] {
  const perChunkMs = (60000 + chunkChars * 0.015) * effortFactor + 12000
  const waves = Math.ceil(chunkCount / concurrency)
  const totalMs = waves * perChunkMs * 1.15
  return [Math.max(1, Math.round((totalMs / 60000) * 0.75)), Math.max(2, Math.round((totalMs / 60000) * 1.5))]
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
  /** 档位抽取密度（实体数/千字符），给模型一个"抽多细"的数量指导 */
  density: number
}): string {
  const zh = input.locale.startsWith('zh')
  const kindList = input.nodeKinds.join(' | ')
  const edgeList = input.edgeKinds.join(' | ')
  const expected = Math.max(3, Math.round((input.chunkText.length / 1000) * input.density))
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
      '6. 本片段体量约 ' + Math.round(input.chunkText.length / 1000) + ' 千字符，期望抽取约 ' + expected + ' 个实体（允许 ±40% 浮动；内容确实不足时可以更少，但不要为凑数编造）；',
      '7. 节点名称必须与片段中的原文用词一致，同一概念在片段内多次出现时只建一个节点；',
      '8. 只输出 JSON，不要输出任何解释文字或 Markdown 代码围栏。',
      '9. 不要使用任何工具（不要读写文件、不要执行命令、不要联网检索），直接把 JSON 作为回答正文输出。',
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
    '6. This fragment is about ' + Math.round(input.chunkText.length / 1000) + 'k characters; expect roughly ' + expected + ' entities (±40% is fine; fewer if the content truly warrants it, but never invent filler).',
    '7. Node names must use the fragment\'s own wording; mention the same concept multiple times → one node only.',
    '8. Output JSON only, no prose, no code fences.',
    '9. Do not use any tool (no file reads or writes, no shell commands, no web search); answer with the JSON body directly.',
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

  /**
   * 生成前的成本与耗时预估（规划书 §5.5.3.3：预估值基于本机历史统计，首次使用给保守区间）。
   *
   * 两层模型：
   *  - **token 预估**：Map 阶段把整篇文档送进模型（含每块的提示词框架与标题路径），
   *    输出按抽取密度（实体数 / 每千字符，随档位与思考强度走）估计；
   *  - **耗时预估**：优先用**同文档的历史生成记录**校准 —— 历史里存了
   *    `chunkCount × waveCount` 波的总耗时，能折出"单块 × 并发"的真实速率；
   *    没有历史时退到常数启发式（每波 = 会话冷启动 + 单块处理时间，随块体量增长）。
   *    思考强度是耗时的大头（实测 xhigh 是 low 的 2~4 倍），两档都乘系数。
   */
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
    const concurrency = Math.max(1, Math.min(6, request.concurrency ?? settingsService.all().graph.concurrency))
    const effortFactor = effortTimeFactor(request.thinkingEffort)

    // ---- token 预估：输入 = 文档全文 + 每块的提示词框架；输出 = 抽取密度 × 体量
    const chunkChars = chunks.length > 0 ? Math.round(chunks.reduce((sum, c) => sum + c.text.length, 0) / chunks.length) : 0
    const entityDensity = profileDensityPerKiloChars(profile)
    const nodeScale = Math.min(2.2, Math.max(0.5, documentTokens / 18000))
    const estNodes: [number, number] = [Math.round(profile.targetNodes[0] * nodeScale), Math.round(profile.targetNodes[1] * nodeScale)]
    const outputTokens = Math.round((documentTokens * 0.22 + (estNodes[0] + estNodes[1]) / 2 * (60 + entityDensity * 8)) * effortFactor)
    const inputTokens = Math.round((documentTokens * 1.05 + chunks.length * 420) * effortFactor)
    const totalTokens = inputTokens + outputTokens

    // ---- 耗时预估：历史优先，启发式兜底
    const history = estimateMinutesFromHistory(
      storeService.graphHistoryElapsed(request.docId, 3),
      chunks.length,
      concurrency
    )
    const minutes: [number, number] = history
      ? history.minutes
      : heuristicMinutes(chunks.length, concurrency, chunkChars, effortFactor)

    return {
      precision: request.precision,
      chunkCount: chunks.length,
      documentTokens,
      inputTokens,
      outputTokens,
      totalTokens,
      minutes,
      nodes: estNodes,
      edges: [Math.round(estNodes[0] * 1.8), Math.round(estNodes[1] * 1.9)],
      costLevel: profile.relativeCost,
      chunkChars,
      basis: history ? 'history' : 'heuristic',
      historySamples: history ? history.samples : 0
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
    // fresh：生成必须以库里最新块为准（文档可能被重新解析而 docHash 未变）；缓存只服务 estimate
    const model = loadModel(request.docId, { fresh: true })
    if (model.text.trim().length === 0) throw new Error('文档没有可抽取的文本（扫描版 PDF 需要 OCR，属于二期能力）')

    /**
     * 增量重试（规划书 §5.5.3.5"重试失败块"）的**第一步是复现原图的生成配置**：
     * failedChunkIndexes 是相对"那一次"分块边界的下标 —— 分块大小 / 关系白名单 / 抽取范围
     * 只要有一项变了，下标就会指到别的分块上（轻则重跑错块，重则把失败块又漏掉）。
     * 所以这里先读出旧图的 generation，用它覆盖本次请求里的对应字段；
     * request 显式传了的字段仍以请求为准（用户在"相同配置"下微调是显式意图）。
     */
    const isRetry = Array.isArray(request.retryChunkIndexes) && request.retryChunkIndexes.length > 0
    const previousGraph = request.graphId && isRetry ? storeService.graphGet(request.graphId) : null
    const retryBasis = previousGraph?.generation ?? null
    const effective: GraphGenerateRequest = retryBasis
      ? {
          ...request,
          /**
           * 重试 = **原配置复现**：分块坐标系相关的字段（精度 / 分块大小 / 关系白名单 / 抽取范围）
           * 一律以旧图 generation 里记录的值为准 —— 无条件覆盖，请求里带了也不作数。
           * 想换配置就走整篇重新生成（不带 retryChunkIndexes），两条路语义分明。
           * 不影响分块坐标系的字段（并发 / 消解阈值 / 节点上限）允许请求微调。
           */
          precision: (retryBasis.precision as GraphGenerateRequest['precision']) || request.precision,
          chunkTokens: retryBasis.chunkTokens ?? request.chunkTokens,
          edgeKinds: retryBasis.edgeKinds ?? request.edgeKinds,
          scope: (retryBasis.scope as GraphGenerateRequest['scope']) ?? request.scope,
          sectionIds: retryBasis.sectionIds ?? request.sectionIds,
          fromPage: retryBasis.fromPage ?? request.fromPage,
          concurrency: request.concurrency ?? retryBasis.concurrency ?? undefined,
          entityThreshold: request.entityThreshold ?? retryBasis.entityThreshold ?? undefined,
          nodeLimit: request.nodeLimit ?? retryBasis.nodeLimit ?? undefined
        }
      : request

    onProgress({ taskId, phase: 'prepare', done: 0, total: 1, detail: isRetry ? '按原图分块复现中' : '分块中' })
    const profile = PRECISION_PROFILES[effective.precision] ?? PRECISION_PROFILES.structure
    const allChunks = chunkDocument(model, {
      targetTokens: effective.chunkTokens ?? profile.targetTokens,
      overlap: profile.overlap,
      headingLevel: profile.headingLevel
    })
    let chunks = allChunks
    if (effective.scope === 'section' && effective.sectionIds && effective.sectionIds.length > 0) {
      chunks = chunks.filter((chunk) => chunk.sectionId && effective.sectionIds?.includes(chunk.sectionId))
    }
    if (effective.scope === 'from-page' && effective.fromPage) {
      const fromChar =
        model.blocks.find((block) => block.locator.kind === 'pdf' && block.locator.page >= (effective.fromPage ?? 1))?.charStart ?? 0
      chunks = chunks.filter((chunk) => chunk.charEnd > fromChar)
    }
    if (chunks.length === 0) throw new Error('没有可抽取的分块')
    const retryIndexes = isRetry
      ? new Set(request.retryChunkIndexes!.filter((i) => Number.isInteger(i) && i >= 0 && i < chunks.length))
      : null
    const pendingChunks = retryIndexes ? chunks.filter((_, index) => retryIndexes.has(index)) : chunks
    if (retryIndexes && pendingChunks.length === 0) {
      // 下标全部越界（文档重解析后分块边界变了）：明确报错，而不是静默跑一个空任务
      throw new Error('重试失败块：分块边界已变化（文档被重新解析？），请改用整篇重新生成')
    }
    const edgeWhitelist = (effective.edgeKinds && effective.edgeKinds.length > 0
      ? effective.edgeKinds
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
      /** 增量重试从上一张图继承的连线（不参与"重跑分块才保留"的过滤） */
      inherited?: boolean
      /** 继承连线的原权重（重跑分块新抽出的连线没有这个字段，从 1 计） */
      weight?: number
    }

    const entities: RawEntity[] = []
    const relations: RawRelation[] = []
    let failedChunks = 0
    let emptyChunks = 0
    const warnings: string[] = []
    const concurrency = Math.max(1, Math.min(6, effective.concurrency ?? settings.graph.concurrency))
    /**
     * 进度与 ETA：按"块下标完成数"计（增量重试时也自然是正确分母），
     * 用已完成分块的实测耗时滚动估计剩余时间 —— 一次性会话冷启动 3~12 秒、
     * 思考型模型单块分钟级，进度条光有"第 N/M 块"完全不足以判断还要等多久。
     */
    const pendingTotal = pendingChunks.length
    /** chunk → 全文分块下标（建一次映射；逐个 indexOf 是 O(待跑数 × 总块数)） */
    const indexOfChunk = new Map(allChunks.map((chunk, index) => [chunk, index] as const))
    const chunkIndexes = pendingChunks.map((chunk) => indexOfChunk.get(chunk) ?? -1)
    /** 已跑完（无论成败）的分块下标 → 耗时；失败记 0，成功的记真实耗时（ETA 用它算中位速率） */
    const chunkDuration = new Map<number, number>()
    const computeEta = (completed: number): number | null => {
      if (completed < 1 || completed >= pendingTotal) return completed >= pendingTotal ? 0 : null
      const samples = [...chunkDuration.values()].filter((v) => v > 0)
      if (samples.length === 0) return null
      samples.sort((a, b) => a - b)
      const median = samples[Math.floor(samples.length / 2)]
      const remainingWaves = Math.ceil((pendingTotal - completed) / concurrency)
      return Math.round(remainingWaves * median + 2000)
    }
    /**
     * 每个分块收尾时统一报一次进度（成功 / 合法空 / 校验失败 / 异常四条路都走这里）。
     * 成功记真实耗时，失败记 0 —— 下面 failedChunkIndexes 就靠"时长为 0"判失败，
     * ETA 只统计 > 0 的样本。
     */
    const finishChunk = (index: number, elapsedMs: number, failure: string | null): void => {
      chunkDuration.set(index, failure ? 0 : Math.max(1, elapsedMs))
      const done = chunkDuration.size
      onProgress({
        taskId,
        phase: 'map',
        done: Math.min(done, pendingTotal),
        total: pendingTotal,
        etaMs: computeEta(done),
        detail: failure ?? '已抽取 ' + entities.length + ' 个节点'
      })
    }

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
        locale,
        density: profileDensityPerKiloChars(profile)
      })
      let raw = ''
      let parsed: ReturnType<typeof parseExtraction> | null = null
      let lastTimedOut = false
      let lastChunkError: string | null = null
      const chunkStarted = Date.now()
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
        if (lastTimedOut && (effective.thinkingEffort ?? null) !== 'low') {
          attempts.push({ modelId: effective.modelId ?? null, effort: 'low', note: '上次请求超时，已降低思考强度重试' })
        }
        attempts.push({ modelId: effective.modelId ?? null, effort: effective.thinkingEffort ?? null, note: null })
        /**
         * 超时两连击后不再原样再试一轮：同样的输入、同样的配置，第三轮大概率还是空转
         * （§53/§54 实测空转是代理端行为，与运气有关但概率稳定）。这里直接放弃该分块，
         * 把 3×timeout 的最坏等待压到 2×timeout —— 与其空烧十分钟，不如把失败原因亮给用户。
         */
        if (lastTimedOut) {
          lastChunkError = lastChunkError ?? '分块请求连续超时'
          break
        }
        if ((effective.thinkingEffort ?? null) !== null) {
          attempts.push({ modelId: effective.modelId ?? null, effort: null, note: '思考强度不被支持，已自动降级' })
        }
        if ((effective.modelId ?? null) !== null) {
          attempts.push({ modelId: null, effort: null, note: '指定模型档位不被支持，已改用默认模型' })
        }
        let result: { text: string; sessionId: string } | null = null
        let lastError: unknown = null
        let timedOut = false
        for (const attempt of attempts) {
          try {
            result = await agentRuntime.runOnce({
              agentId: effective.agentId,
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
          // 分块原文：锚点彻底坏了时按 evidence 引文在本块内重新定位（弱模型最常见失败模式的直接对策）
          chunkText: chunk.text,
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
        finishChunk(index, Date.now() - chunkStarted, message)
        return
      }
      if (parsed.value.entities.length === 0) {
        emptyChunks += 1
        logMain('debug', 'graph', '分块 ' + index + ' 返回合法空结果（该块没有可抽取的实体）')
        finishChunk(index, Date.now() - chunkStarted, null)
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
      finishChunk(index, Date.now() - chunkStarted, null)
    }

    let cursor = 0
    const workers = Array.from({ length: concurrency }, async () => {
      while (cursor < chunkIndexes.length && !this.cancelled.has(taskId)) {
        const slot = cursor
        cursor += 1
        const index = chunkIndexes[slot]
        try {
          await runChunk(index)
        } catch (error) {
          // 与校验失败同一条收尾路（finishChunk 统一计数 / ETA / failedChunkIndexes）
          failedChunks += 1
          const message = '分块 ' + index + ' 失败：' + (error instanceof Error ? error.message : String(error))
          warnings.push(message)
          logMain('warn', 'graph', message)
          finishChunk(index, 0, '分块失败，继续')
        }
      }
    })
    await Promise.all(workers)

    if (this.cancelled.has(taskId)) throw new Error('cancelled')
    const failedChunkIndexes = chunkIndexes.filter((index) => {
      // 失败 = 既没进 entities 也没记成功时长（成功/合法空都会写 chunkDuration）
      return !chunkDuration.has(index) || chunkDuration.get(index) === 0
    })

    onProgress({ taskId, phase: 'reduce', done: 0, total: 1, detail: '实体消解与合并' })
    const threshold = effective.entityThreshold ?? settings.graph.entityResolutionThreshold
    const canonical = new Map<string, RawEntity>()
    let mergedEntities = 0
    /**
     * 增量重试：继承节点的**全部出处**先收在这里（key → 位置列表），
     * 等本轮分块的新抽取并进来后一起参与"节点多锚点"的合并。
     */
    const entityPositionsInherited = new Map<string, { charStart: number; charEnd: number }[]>()
    /**
     * 增量重试：上一张图的成功抽取先入列，再合并本轮重跑分块的新抽取。
     * 旧实体标记 originChunk = -1（不属于本轮任何分块），合并/去重逻辑天然复用。
     */
    if (previousGraph) {
      let inherited = 0
      for (const oldNode of previousGraph.nodes) {
        if (oldNode.meta?.isSection) continue
        const firstAnchor = oldNode.anchors?.[0]
        if (!firstAnchor) continue
        const inheritedEntity: RawEntity = {
          name: oldNode.title,
          kind: oldNode.kind,
          summary: oldNode.summary,
          evidence: firstAnchor.quote,
          charStart: firstAnchor.charStart,
          charEnd: firstAnchor.charEnd,
          chunkIndex: -1,
          headingPath: (oldNode.meta?.headingPath as string[] | undefined) ?? [],
          weight: Number(oldNode.meta?.weight ?? 1)
        }
        inherited += 1
        const key = normalizeName(inheritedEntity.name)
        if (key.length === 0) continue
        if (!canonical.has(key)) canonical.set(key, inheritedEntity)
        // 多位置节点：把旧图的其余锚点也带进"出处集合"（否则重试一轮就把多锚点打回单锚点）
        const positions = entityPositionsInherited.get(key) ?? []
        for (const anchor of oldNode.anchors ?? []) {
          if (!positions.some((item) => Math.abs(item.charStart - anchor.charStart) < 8)) {
            positions.push({ charStart: anchor.charStart, charEnd: anchor.charEnd })
          }
        }
        entityPositionsInherited.set(key, positions)
      }
      for (const oldEdge of previousGraph.edges) {
        const from = previousGraph.nodes.find((node) => node.id === oldEdge.from)
        const to = previousGraph.nodes.find((node) => node.id === oldEdge.to)
        if (!from || !to || from.meta?.isSection || to.meta?.isSection) continue
        const firstAnchor = oldEdge.anchors?.[0]
        relations.push({
          from: from.title,
          to: to.title,
          kind: oldEdge.kind,
          label: oldEdge.label,
          evidence: firstAnchor ? firstAnchor.quote : '',
          charStart: firstAnchor ? firstAnchor.charStart : 0,
          charEnd: firstAnchor ? firstAnchor.charEnd : 1,
          inherited: true,
          weight: oldEdge.weight
        })
      }
      if (inherited > 0) logMain('info', 'graph', '增量重试：从上一张图继承 ' + inherited + ' 个节点与 ' + previousGraph.edges.length + ' 条连线')
    }
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

    /**
     * 节点多锚点（规划书 §5.5.7 / R-12 的"位置选择器"）：同名实体在多个分块出现时
     * 保留**全部**出处（此前只留第一条，跨章节复现的关键概念只有一个锚点，位置选择器形同虚设）。
     * 增量重试时继承出处（entityPositionsInherited）与新抽取的出处在这里汇合。
     */
    const entityPositions = new Map<string, { charStart: number; charEnd: number }[]>()
    for (const entity of entities) {
      const key = resolveKey(entity.name)
      if (!key) continue
      const list = entityPositions.get(key) ?? []
      const span = { charStart: entity.charStart, charEnd: entity.charEnd }
      if (!list.some((item) => Math.abs(item.charStart - span.charStart) < 8)) list.push(span)
      entityPositions.set(key, list)
    }
    for (const [key, positions] of entityPositionsInherited) {
      const list = entityPositions.get(key) ?? []
      for (const span of positions) {
        if (!list.some((item) => Math.abs(item.charStart - span.charStart) < 8)) list.push(span)
      }
      entityPositions.set(key, list)
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
    /** 节点 id → 出处列表（建锚点阶段用；避免锚点循环里逐节点反查 key） */
    const nodePositionsById = new Map<string, { charStart: number; charEnd: number }[]>()
    for (const [key, node] of nodeByKey) {
      const positions = entityPositions.get(key)
      if (positions && positions.length > 0) nodePositionsById.set(node.id, positions)
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
        /**
         * 增量重试：继承连线带**原权重**入场（而不是从 1 重新数起）——
         * 否则 weight≥2 才能过的阈值过滤会把上一轮确认过多处的边误判成"只出现一次"而删掉，
         * 重试一轮反而丢边。
         */
        weight: relation.inherited ? Math.max(1, Number(relation.weight ?? 1)) : 1,
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

    const limit = effective.nodeLimit ?? settings.graph.targetNodeLimit
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
      const primary = persistAnchor(charStart, charEnd)
      const ids = [primary]
      // 同名实体的其余出处（最多再补 5 处，超过的重复出处对位置选择器没有增量价值）
      if (!node.meta?.isSection) {
        const positions = nodePositionsById.get(node.id)
        if (positions) {
          for (const span of positions.slice(0, 6)) {
            if (Math.abs(span.charStart - charStart) < 8 && Math.abs(span.charEnd - charEnd) < 8) continue
            ids.push(persistAnchor(span.charStart, span.charEnd))
            if (ids.length >= 6) break
          }
        }
      }
      node.anchorIds = ids
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
    /**
     * failedChunks 与 failedChunkIndexes 分开记：前者是"本轮重跑的分块里失败的数量"（用户视角），
     * 后者是"全文分块坐标系里失败的下标"（增量重试视角 —— 下一轮只重跑这些）。
     */
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
      elapsedMs: Date.now() - started,
      chunkCount: pendingChunks.length,
      waveCount: Math.max(1, Math.ceil(pendingChunks.length / concurrency)),
      chunkChars: pendingChunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
      failedChunkIndexes: [...new Set(failedChunkIndexes)].sort((a, b) => a - b)
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
        agentId: effective.agentId,
        agentName: request.agentName ?? effective.agentId,
        modelId: effective.modelId ?? null,
        thinkingEffort: effective.thinkingEffort ?? null,
        precision: effective.precision,
        promptVersion: PROMPT_VERSION,
        scope: effective.scope ?? 'full',
        /**
         * 生成配置随图落库：增量重试要按**同一套分块**跑 —— failedChunkIndexes 是相对
         * 那一次分块边界的下标，分块大小 / 白名单 / 范围一变，下标就会指错块。
         * （重试入口缺省时优先用这里的值，而不是 UI 上的当前设置。）
         */
        chunkTokens: effective.chunkTokens ?? profile.targetTokens,
        edgeKinds: edgeWhitelist,
        concurrency,
        entityThreshold: effective.entityThreshold ?? settings.graph.entityResolutionThreshold,
        nodeLimit: effective.nodeLimit ?? settings.graph.targetNodeLimit,
        sectionIds: effective.scope === 'section' ? effective.sectionIds ?? null : null,
        fromPage: effective.scope === 'from-page' ? effective.fromPage ?? null : null
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
      if (previous) {
        mergeHumanEdits(graph, previous)
        // 同一张图（重试 / 增量补抽）保留原始创建时间，"updatedAt 才是本轮"的语义才成立
        graph.createdAt = previous.createdAt
      }
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

  importFromJson(payload: unknown): LogicGraph {
    const result = validateGraphDocument(payload)
    if (!result.ok || !result.value) {
      throw new Error('导入失败：' + result.issues.slice(0, 5).map((issue) => issue.path + ' ' + issue.message).join('; '))
    }
    const graph = result.value
    /** 导入图的锚点先按导出格式原样入锚点表，再把 id 挂回节点 / 连线（节点与连线同一套转换）。 */
    const anchors: Record<string, unknown>[] = []
    const importAnchors = (refs: { docId: string; docHash: string; charStart: number; charEnd: number; quote: string; primary?: unknown; extras?: unknown[] }[] | undefined): string[] => {
      const ids: string[] = []
      for (const anchor of refs ?? []) {
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
      return ids
    }
    for (const node of graph.nodes) {
      const ids = importAnchors(node.anchors)
      if (ids.length > 0) node.anchorIds = ids
    }
    for (const edge of graph.edges) {
      const ids = importAnchors(edge.anchors)
      if (ids.length > 0) edge.anchorIds = ids
    }
    if (anchors.length > 0) storeService.saveAnchors(anchors as never)
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
          '<rect x="' + point.x + '" y="' + point.y + '" width="3" height="56" fill="' + (NODE_KIND_COLOR[node.kind as NodeKind] ?? '#8a8a8a') + '"/>' +
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

function escapeXml(value: string): string {
  return value.replace(/[<>&"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[char] ?? char)
}

/**
 * 重生成时保留人工编辑（规划书 §5.5.3.6）。
 *
 * 同时**继承上一张图的提问节点**（`inquiry`，来自文档默认会话的对话——用户要求：
 * "每增加对话都需要在关系图中增加对话内容"，重生成不能把已有的对话内容冲掉）：
 * 这些节点是"可读的对话记录"，没有人工 pinned 标记也照样带过来。
 */
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
  // 边签名按"端点标题"比对：先建 next 的 id→标题表，避免 filter 里每条边两次 nodes.find（O(边×节点)）
  const nextTitleOf = new Map(next.nodes.map((node) => [node.id, normalizeName(node.title)]))
  next.edges = next.edges.filter((edge) => {
    const signature = (nextTitleOf.get(edge.from) ?? edge.from) + '>' + (nextTitleOf.get(edge.to) ?? edge.to) + '#' + edge.kind
    return !ignored.has(signature)
  })
  // 继承提问节点（对话内容）：next 里没有同标题节点时整条搬过来（节点 + 它的 inquiry 连边）
  const nextTitles = new Set([...next.nodes].map((node) => normalizeName(node.title)))
  for (const oldNode of previous.nodes) {
    if (oldNode.kind !== 'inquiry') continue
    if (nextTitles.has(normalizeName(oldNode.title))) continue
    const carried: typeof oldNode = { ...oldNode, id: createId('n'), pinned: undefined }
    next.nodes.push(carried)
    const oldTitleById = new Map(previous.nodes.map((node) => [node.id, node.title]))
    for (const oldEdge of previous.edges) {
      if (oldEdge.from !== oldNode.id && oldEdge.to !== oldNode.id) continue
      const otherId = oldEdge.from === oldNode.id ? oldEdge.to : oldEdge.from
      const otherTitle = oldTitleById.get(otherId) ?? ''
      const otherNext = next.nodes.find((node) => normalizeName(node.title) === normalizeName(otherTitle))
      if (!otherNext) continue
      const from = oldEdge.from === oldNode.id ? carried.id : otherNext.id
      const to = oldEdge.from === oldNode.id ? otherNext.id : carried.id
      next.edges.push({ ...oldEdge, id: createId('e'), from, to, anchors: undefined })
    }
  }
}

export const graphService = new GraphService()
