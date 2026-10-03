/** 受控词表：节点类型与边类型（规划书 §5.5.2）。 */
import type { GraphPrecision } from '@logicreader/shared'

export const NODE_KINDS = [
  'claim', 'conclusion', 'evidence', 'definition', 'data', 'method', 'inquiry', 'selection'
] as const
export type NodeKind = (typeof NODE_KINDS)[number]

export const EDGE_KINDS = [
  'causes', 'supports', 'refutes', 'elaborates', 'contrasts', 'sequences', 'defines', 'references', 'inquiry'
] as const
export type EdgeKind = (typeof EDGE_KINDS)[number]

export interface Bilingual {
  zh: string
  en: string
}

export const NODE_KIND_LABEL: Record<NodeKind, Bilingual> = {
  claim: { zh: '论点', en: 'Claim' },
  conclusion: { zh: '结论', en: 'Conclusion' },
  evidence: { zh: '证据', en: 'Evidence' },
  definition: { zh: '定义', en: 'Definition' },
  data: { zh: '数据', en: 'Data' },
  method: { zh: '方法', en: 'Method' },
  inquiry: { zh: '提问', en: 'Inquiry' },
  selection: { zh: '选区', en: 'Selection' }
}

export const NODE_KIND_COLOR: Record<NodeKind, string> = {
  claim: '#3d7fd1',
  conclusion: '#c98a2e',
  evidence: '#3f9e46',
  definition: '#2aa5a5',
  data: '#8a5cd1',
  method: '#5b7f95',
  inquiry: '#e0713a',
  selection: '#8a8a8a'
}

export interface EdgeStyle {
  label: Bilingual
  color: string
  /** 线型 */
  dash: string | null
  /** 是否双向 */
  bidirectional: boolean
  width: number
}

export const EDGE_STYLE: Record<EdgeKind, EdgeStyle> = {
  causes: { label: { zh: '因果', en: 'Causes' }, color: '#e0a458', dash: null, bidirectional: false, width: 1.5 },
  supports: { label: { zh: '论据支持', en: 'Supports' }, color: '#6fbf73', dash: null, bidirectional: false, width: 1.5 },
  refutes: { label: { zh: '反驳', en: 'Refutes' }, color: '#e06c75', dash: '6 3', bidirectional: false, width: 1.5 },
  elaborates: { label: { zh: '展开说明', en: 'Elaborates' }, color: '#61afef', dash: null, bidirectional: false, width: 1.5 },
  contrasts: { label: { zh: '对比', en: 'Contrasts' }, color: '#c678dd', dash: '4 3', bidirectional: true, width: 1.5 },
  sequences: { label: { zh: '递进', en: 'Sequences' }, color: '#7f9fb5', dash: null, bidirectional: false, width: 1.5 },
  defines: { label: { zh: '定义', en: 'Defines' }, color: '#56b6c2', dash: '2 3', bidirectional: false, width: 1.5 },
  references: { label: { zh: '引用', en: 'References' }, color: '#9a9a9a', dash: '2 3', bidirectional: false, width: 1.5 },
  inquiry: { label: { zh: '提问', en: 'Inquiry' }, color: '#e5925f', dash: '8 4', bidirectional: false, width: 2 }
}

export function edgeLabel(kind: string, locale: string): string {
  const style = EDGE_STYLE[kind as EdgeKind]
  if (!style) return kind
  return locale.startsWith('zh') ? style.label.zh : style.label.en
}

export function nodeLabel(kind: string, locale: string): string {
  const label = NODE_KIND_LABEL[kind as NodeKind]
  if (!label) return kind
  return locale.startsWith('zh') ? label.zh : label.en
}

export function isEdgeKind(value: unknown): value is EdgeKind {
  return typeof value === 'string' && (EDGE_KINDS as readonly string[]).includes(value)
}

export function isNodeKind(value: unknown): value is NodeKind {
  return typeof value === 'string' && (NODE_KINDS as readonly string[]).includes(value)
}

/** 把 Agent 返回的自由文本边类型归一化到受控词表。 */
export function normalizeEdgeKind(raw: string): EdgeKind | null {
  const v = raw.trim().toLowerCase()
  if (isEdgeKind(v)) return v
  const alias: Record<string, EdgeKind> = {
    cause: 'causes', causal: 'causes', because: 'causes', '因果': 'causes',
    support: 'supports', supported_by: 'supports', evidence_for: 'supports', '支持': 'supports', '论据': 'supports',
    refute: 'refutes', contradict: 'refutes', rebut: 'refutes', '反驳': 'refutes',
    elaborate: 'elaborates', explain: 'elaborates', detail: 'elaborates', '展开': 'elaborates',
    contrast: 'contrasts', compare: 'contrasts', versus: 'contrasts', '对比': 'contrasts',
    sequence: 'sequences', then: 'sequences', next: 'sequences', '递进': 'sequences',
    define: 'defines', definition: 'defines', '定义': 'defines',
    reference: 'references', cite: 'references', see: 'references', '引用': 'references',
    inquiry: 'inquiry', question: 'inquiry', ask: 'inquiry', '提问': 'inquiry'
  }
  return alias[v] ?? null
}

export function normalizeNodeKind(raw: string): NodeKind {
  const v = raw.trim().toLowerCase()
  if (isNodeKind(v)) return v
  const alias: Record<string, NodeKind> = {
    thesis: 'claim', argument: 'claim', point: 'claim', '论点': 'claim', '主张': 'claim',
    result: 'conclusion', finding: 'conclusion', '结论': 'conclusion',
    proof: 'evidence', example: 'evidence', citation: 'evidence', '证据': 'evidence', '例证': 'evidence',
    term: 'definition', concept: 'definition', '定义': 'definition', '概念': 'definition',
    statistic: 'data', metric: 'data', table: 'data', '数据': 'data',
    approach: 'method', technique: 'method', algorithm: 'method', '方法': 'method',
    question: 'inquiry', '提问': 'inquiry',
    selection: 'selection', '选区': 'selection'
  }
  return alias[v] ?? 'claim'
}

/** 精度档位对抽取提示词的影响（规划书 §5.5.3.2）。 */
export interface PrecisionProfile {
  id: GraphPrecision
  label: Bilingual
  targetNodes: [number, number]
  relativeCost: number
  headingLevel: number
  targetTokens: number
  overlap: number
  byParagraph: boolean
  nodeKindWhitelist: NodeKind[] | null
  edgeKindWhitelist: EdgeKind[] | null
  minEdgeWeight: number
  description: Bilingual
}

export const PRECISION_PROFILES: Record<GraphPrecision, PrecisionProfile> = {
  skeleton: {
    id: 'skeleton',
    label: { zh: '骨架图', en: 'Skeleton' },
    targetNodes: [15, 40],
    relativeCost: 1,
    headingLevel: 1,
    targetTokens: 6000,
    overlap: 0.1,
    byParagraph: false,
    nodeKindWhitelist: ['claim', 'conclusion'],
    edgeKindWhitelist: ['causes', 'supports', 'sequences'],
    minEdgeWeight: 3,
    description: { zh: '仅章节级论点与主干逻辑边', en: 'Chapter-level claims and trunk logic only' }
  },
  structure: {
    id: 'structure',
    label: { zh: '结构图', en: 'Structure' },
    targetNodes: [60, 150],
    relativeCost: 3,
    headingLevel: 3,
    targetTokens: 3000,
    overlap: 0.15,
    byParagraph: false,
    nodeKindWhitelist: ['claim', 'conclusion', 'evidence', 'definition'],
    edgeKindWhitelist: null,
    minEdgeWeight: 2,
    description: { zh: '论点 + 关键证据，保留主要关系类型', en: 'Claims plus key evidence, main relation types' }
  },
  panorama: {
    id: 'panorama',
    label: { zh: '全景图', en: 'Panorama' },
    targetNodes: [200, 400],
    relativeCost: 10,
    headingLevel: 6,
    targetTokens: 1500,
    overlap: 0.2,
    byParagraph: true,
    nodeKindWhitelist: null,
    edgeKindWhitelist: null,
    minEdgeWeight: 1,
    description: { zh: '论点 / 证据 / 数据 / 定义 / 方法全量抽取', en: 'Full extraction of all node kinds' }
  },
  custom: {
    id: 'custom',
    label: { zh: '自定义', en: 'Custom' },
    targetNodes: [50, 300],
    relativeCost: 5,
    headingLevel: 3,
    targetTokens: 3000,
    overlap: 0.15,
    byParagraph: false,
    nodeKindWhitelist: null,
    edgeKindWhitelist: null,
    minEdgeWeight: 1,
    description: { zh: '用户指定目标节点数、抽取范围与边类型白名单', en: 'User-defined targets and whitelists' }
  }
}
