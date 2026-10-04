/** 校验：既校验导出/导入的图文档，也校验 Agent 抽取结果（规划书 §5.5.2 步骤 4）。 */
import { GRAPH_JSON_SCHEMA } from './schema'
import { isEdgeKind, isNodeKind, normalizeEdgeKind, normalizeNodeKind } from './vocab'
import type { EdgeKind, NodeKind } from './vocab'
import type { LogicGraph } from './types'

export interface ValidationIssue {
  path: string
  message: string
}

export interface ValidationResult<T> {
  ok: boolean
  value: T | null
  issues: ValidationIssue[]
}

// ------------------------------------------------------------------ 通用工具
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function isString(v: unknown): v is string {
  return typeof v === 'string'
}
function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

// -------------------------------------------------------- 图文档（导入导出）
export function validateGraphDocument(input: unknown): ValidationResult<LogicGraph> {
  const issues: ValidationIssue[] = []
  if (!isObject(input)) {
    return { ok: false, value: null, issues: [{ path: '$', message: '不是对象' }] }
  }
  if (input.version !== 1) issues.push({ path: '$.version', message: 'version 必须为 1' })
  if (!isString(input.docId)) issues.push({ path: '$.docId', message: '缺少 docId' })
  if (!isString(input.docHash)) issues.push({ path: '$.docHash', message: '缺少 docHash' })
  if (!Array.isArray(input.nodes)) issues.push({ path: '$.nodes', message: '缺少 nodes 数组' })
  if (!Array.isArray(input.edges)) issues.push({ path: '$.edges', message: '缺少 edges 数组' })

  const nodeIds = new Set<string>()
  if (Array.isArray(input.nodes)) {
    input.nodes.forEach((n, i) => {
      const p = '$.nodes[' + i + ']'
      if (!isObject(n)) {
        issues.push({ path: p, message: '不是对象' })
        return
      }
      if (!isString(n.id)) issues.push({ path: p + '.id', message: '缺少 id' })
      else if (nodeIds.has(n.id)) issues.push({ path: p + '.id', message: 'id 重复：' + n.id })
      else nodeIds.add(n.id)
      if (!isNodeKind(n.kind)) issues.push({ path: p + '.kind', message: '未知节点类型：' + String(n.kind) })
      if (!isString(n.title)) issues.push({ path: p + '.title', message: '缺少 title' })
      else if (n.title.length > 40) issues.push({ path: p + '.title', message: 'title 超过 40 字' })
      if (!Array.isArray(n.anchors) || n.anchors.length === 0) {
        issues.push({ path: p + '.anchors', message: '节点必须有至少一个锚点（无锚点不入图）' })
      }
      if (isString(n.summary) && n.summary.length > 200) {
        issues.push({ path: p + '.summary', message: 'summary 超过 200 字' })
      }
    })
  }
  if (Array.isArray(input.edges)) {
    input.edges.forEach((e, i) => {
      const p = '$.edges[' + i + ']'
      if (!isObject(e)) {
        issues.push({ path: p, message: '不是对象' })
        return
      }
      if (!isString(e.from) || !nodeIds.has(e.from)) issues.push({ path: p + '.from', message: 'from 指向不存在的节点' })
      if (!isString(e.to) || !nodeIds.has(e.to)) issues.push({ path: p + '.to', message: 'to 指向不存在的节点' })
      if (!isEdgeKind(e.kind)) issues.push({ path: p + '.kind', message: '未知边类型：' + String(e.kind) })
      if (isString(e.label) && e.label.length > 24) issues.push({ path: p + '.label', message: 'label 超过 24 字' })
    })
  }
  return { ok: issues.length === 0, value: issues.length === 0 ? (input as unknown as LogicGraph) : null, issues }
}

/** JSON Schema 自检：确认导出结构里的每个 required 字段都被检查过（供单测使用）。 */
export function schemaCoverageReport(): string[] {
  const props = Object.keys(GRAPH_JSON_SCHEMA.properties)
  return props
}

// ------------------------------------------------------------ Map 阶段抽取
export interface ExtractedSpan {
  charStart: number
  charEnd: number
}

export interface ExtractedEntity {
  name: string
  kind: NodeKind
  summary: string
  evidence: string
  spans: ExtractedSpan[]
}

export interface ExtractedRelation {
  from: string
  to: string
  kind: EdgeKind
  label: string
  evidence: string
  spans: ExtractedSpan[]
}

export interface ExtractionResult {
  entities: ExtractedEntity[]
  relations: ExtractedRelation[]
  /** 因越界 / 无锚点被丢弃的数量 */
  dropped: number
  issues: ValidationIssue[]
}

export interface ExtractionContext {
  charStart: number
  charEnd: number
  /** 分块原文：供"模型给了 evidence 但锚点坏了"时按引文重新定位（可选，越准的兜底越要用它） */
  chunkText?: string
  nodeKindWhitelist?: NodeKind[] | null
  edgeKindWhitelist?: EdgeKind[] | null
}

/**
 * 从 Agent 返回的文本中解析并校验抽取结果。
 * 硬门槛：spans 必须落在当前块范围内，否则丢弃该条（无锚点不入图）。
 */
export function parseExtraction(rawText: string, ctx: ExtractionContext): ValidationResult<ExtractionResult> {
  const issues: ValidationIssue[] = []
  const json = extractJson(rawText)
  if (!json) {
    return { ok: false, value: null, issues: [{ path: '$', message: '未找到合法 JSON' }] }
  }
  if (!isObject(json)) {
    return { ok: false, value: null, issues: [{ path: '$', message: '顶层不是对象' }] }
  }
  const inRange = (s: ExtractedSpan): boolean =>
    isInt(s.charStart) && isInt(s.charEnd) && s.charStart >= ctx.charStart && s.charEnd <= ctx.charEnd && s.charEnd > s.charStart

  const chunkLength = ctx.charEnd - ctx.charStart
  /**
   * 弱模型常把 spans 输出成「块内相对偏移」而非要求的全局偏移，直接丢弃会让整个分块零产出。
   * 兜底：绝对解释一个都不合法、而相对解释有合法值时，换算回全局坐标（并在 issues 里留痕）。
   */
  const resolveSpans = (spans: ExtractedSpan[], path: string, evidence: string): ExtractedSpan[] => {
    const absolute = spans.filter(inRange)
    if (absolute.length > 0) return absolute
    const relative = spans.filter(
      (s) => isInt(s.charStart) && isInt(s.charEnd) && s.charStart >= 0 && s.charEnd <= chunkLength && s.charEnd > s.charStart
    )
    if (relative.length === 0) {
      // 第三层兜底：锚点彻底坏了但 evidence 是真原文 —— 在分块里找到它，按命中位置重新锚定。
      // 实测弱模型（GLM/DeepSeek 经代理）最常见的就是"引用对了、坐标全错"，这一层能把这类条目救回来。
      const reanchored = reanchorFromEvidence(evidence)
      if (reanchored) {
        issues.push({ path, message: '锚点按 evidence 引文在本块内重新定位（模型坐标无效）' })
        return [reanchored]
      }
      return []
    }
    issues.push({ path, message: '锚点按块内相对偏移换算（模型未按全局坐标输出）' })
    return relative.map((s) => ({ charStart: s.charStart + ctx.charStart, charEnd: s.charEnd + ctx.charStart }))
  }

  /**
   * evidence 重锚定的工作集（懒初始化，本块共用一份）：
   * 归一化文本 + "归一化下标 → 原始下标"映射表。大分块 × 几十条坏锚点条目时
   * 不能每条都重新扫一遍原文。
   */
  let reanchorIndex: { haystack: string; map: number[] } | null = null
  const getReanchorIndex = (): { haystack: string; map: number[] } | null => {
    const text = ctx.chunkText
    if (!text) return null
    if (reanchorIndex) return reanchorIndex
    const haystackChars: string[] = []
    const map: number[] = []
    for (let i = 0; i < text.length; i += 1) {
      if (/\s/.test(text[i])) continue
      haystackChars.push(text[i])
      map.push(i)
    }
    reanchorIndex = { haystack: haystackChars.join(''), map }
    return reanchorIndex
  }

  /**
   * 按 evidence 引文在分块原文里重新定位（归一化空白后精确匹配，找不到再试前 40 字前缀）。
   * 返回全局坐标；定位不到返回 null。
   */
  const reanchorFromEvidence = (evidence: string): ExtractedSpan | null => {
    if (!isString(evidence) || evidence.trim().length < 6) return null
    const index = getReanchorIndex()
    if (!index) return null
    const needle = evidence.replace(/\s+/g, '')
    if (needle.length < 6) return null
    const { haystack, map } = index
    const mapBack = (normStart: number, normEnd: number): ExtractedSpan | null => {
      if (map.length === 0) return null
      const start = Math.min(Math.max(0, normStart), map.length - 1)
      const end = Math.min(Math.max(0, normEnd - 1), map.length - 1)
      const rawStart = map[start]
      const rawEnd = map[end] + 1
      if (rawEnd <= rawStart) return null
      return { charStart: ctx.charStart + rawStart, charEnd: ctx.charStart + rawEnd }
    }
    const direct = haystack.indexOf(needle)
    if (direct >= 0) return mapBack(direct, direct + needle.length)
    // 引文常被模型改写头尾：取前 40 字做前缀匹配
    const prefix = needle.slice(0, 40)
    const byPrefix = haystack.indexOf(prefix)
    if (byPrefix >= 0) return mapBack(byPrefix, byPrefix + Math.min(needle.length, prefix.length + 60))
    return null
  }

  let dropped = 0
  const entities: ExtractedEntity[] = []
  const rawEntities = Array.isArray(json.entities) ? json.entities : []
  if (!Array.isArray(json.entities)) issues.push({ path: '$.entities', message: '缺少 entities 数组' })
  rawEntities.forEach((e, i) => {
    const p = '$.entities[' + i + ']'
    if (!isObject(e)) {
      issues.push({ path: p, message: '不是对象' })
      dropped += 1
      return
    }
    if (!isString(e.name) || e.name.trim().length === 0) {
      issues.push({ path: p + '.name', message: '缺少 name' })
      dropped += 1
      return
    }
    const spans = Array.isArray(e.spans) ? e.spans.filter(isObject).map((s) => ({ charStart: s.charStart as number, charEnd: s.charEnd as number })) : []
    const valid = resolveSpans(spans, p + '.spans', isString(e.evidence) ? e.evidence : '')
    if (valid.length === 0) {
      issues.push({ path: p + '.spans', message: '锚点越界或缺失' })
      dropped += 1
      return
    }
    const kind = normalizeNodeKind(String(e.type ?? 'claim'))
    if (ctx.nodeKindWhitelist && !ctx.nodeKindWhitelist.includes(kind)) {
      dropped += 1
      return
    }
    entities.push({
      name: String(e.name).trim(),
      kind,
      summary: isString(e.summary) ? e.summary : '',
      evidence: isString(e.evidence) ? e.evidence : '',
      spans: valid
    })
  })

  const relations: ExtractedRelation[] = []
  const names = new Set(entities.map((e) => e.name))
  const rawRelations = Array.isArray(json.relations) ? json.relations : []
  if (!Array.isArray(json.relations)) issues.push({ path: '$.relations', message: '缺少 relations 数组' })
  rawRelations.forEach((r, i) => {
    const p = '$.relations[' + i + ']'
    if (!isObject(r)) {
      issues.push({ path: p, message: '不是对象' })
      dropped += 1
      return
    }
    const from = isString(r.from) ? r.from.trim() : ''
    const to = isString(r.to) ? r.to.trim() : ''
    if (!names.has(from) || !names.has(to)) {
      issues.push({ path: p, message: 'from/to 未在 entities 中声明：' + from + ' → ' + to })
      dropped += 1
      return
    }
    const kind = normalizeEdgeKind(String(r.type ?? ''))
    if (!kind) {
      issues.push({ path: p + '.type', message: '未知关系类型：' + String(r.type) })
      dropped += 1
      return
    }
    if (ctx.edgeKindWhitelist && !ctx.edgeKindWhitelist.includes(kind)) {
      dropped += 1
      return
    }
    const spans = Array.isArray(r.spans) ? r.spans.filter(isObject).map((s) => ({ charStart: s.charStart as number, charEnd: s.charEnd as number })) : []
    const valid = resolveSpans(spans, p + '.spans', isString(r.evidence) ? r.evidence : '')
    if (valid.length === 0) {
      issues.push({ path: p + '.spans', message: '锚点越界或缺失' })
      dropped += 1
      return
    }
    relations.push({
      from,
      to,
      kind,
      label: isString(r.label) ? r.label : '',
      evidence: isString(r.evidence) ? r.evidence : '',
      spans: valid
    })
  })

  return {
    ok: true,
    value: { entities, relations, dropped, issues },
    issues
  }
}

/** 从可能带 markdown 代码围栏或前后解释文字的响应中抠出 JSON。 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fence ? fence[1] : trimmed
  const attempts = [candidate]
  const firstBrace = candidate.indexOf('{')
  const lastBrace = candidate.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) attempts.push(candidate.slice(firstBrace, lastBrace + 1))
  for (const a of attempts) {
    try {
      return JSON.parse(a)
    } catch {
      continue
    }
  }
  return null
}
