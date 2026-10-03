/**
 * 上下文构建（规划书 §5.7）：模式 A 全文本 / 模式 B 图谱。
 * 位置描述头遵循 §5.6.3 的格式。
 */
import { estimateTokens, describeLocator, type Anchor, type DocumentModel } from '@logicreader/document-model'
import type { GraphNode, LogicGraph } from '@logicreader/graph-schema'
import i18n from '../i18n'

export interface ContextInput {
  mode: 'fulltext' | 'graph'
  document: DocumentModel | null
  graph: LogicGraph | null
  anchor: Anchor | null
  nodeId: string | null
  history: { role: string; content: string }[]
  question: string
  contextParagraphsBefore: number
  contextParagraphsAfter: number
  includeLocationHeader: boolean
  /** 用户手动增删的上下文节点（模式 B） */
  selectedNodeIds?: string[]
}

export interface ContextPayload {
  systemContext: string
  /** 上下文构成，用于预览面板 */
  parts: { kind: 'document' | 'summary' | 'subgraph' | 'quote' | 'history' | 'question'; label: string; tokens: number }[]
  totalTokens: number
  locationLabel: string
  anchorIds: string[]
}

const MAX_FULLTEXT_TOKENS = 60000

function isZh(): boolean {
  return i18n.language.startsWith('zh')
}

/** 位置描述头（规划书 §5.6.3）。 */
export function buildLocationHeader(
  document: DocumentModel,
  anchor: Anchor,
  text: string,
  options: { before: number; after: number }
): { header: string; label: string } {
  const zh = isZh()
  const block = document.blocks.find((item) => item.charStart <= anchor.charStart && item.charEnd >= anchor.charStart)
  const index = block ? document.blocks.indexOf(block) : -1
  const label = block ? describeLocator(block.locator, { locale: i18n.language }) : ''
  const lines: string[] = []
  lines.push(
    (zh ? '【引用位置】《' : '[LOCATION] "') +
      document.title +
      (zh ? '》' : '" ') +
      label +
      (zh ? '（全文字符 ' : ' (chars ') +
      anchor.charStart +
      (zh ? '–' : '-') +
      anchor.charEnd +
      (zh ? '）' : ')')
  )
  lines.push(zh ? '【引用原文】' : '[QUOTE]')
  lines.push('"' + text + '"')
  if (block && index >= 0) {
    const before = document.blocks.slice(Math.max(0, index - options.before), index)
    const after = document.blocks.slice(index + 1, index + 1 + options.after)
    if (before.length > 0) {
      lines.push(zh ? '【上文】' : '[BEFORE]')
      lines.push(before.map((item) => '"' + item.text.slice(0, 200) + '"').join('\n'))
    }
    if (after.length > 0) {
      lines.push(zh ? '【下文】' : '[AFTER]')
      lines.push(after.map((item) => '"' + item.text.slice(0, 200) + '"').join('\n'))
    }
  }
  return { header: lines.join('\n'), label }
}

/** 模式 B：按节点裁剪相关子图（当前节点 + 一跳邻居 + 兄弟节点，最多 30 个）。 */
export function clipSubgraph(graph: LogicGraph, nodeId: string | null, extraIds: string[] = []): GraphNode[] {
  if (!graph) return []
  if (!nodeId) return graph.nodes.slice(0, 30)
  const keep = new Set<string>([nodeId, ...extraIds])
  for (const edge of graph.edges) {
    if (edge.from === nodeId) keep.add(edge.to)
    if (edge.to === nodeId) keep.add(edge.from)
  }
  const node = graph.nodes.find((item) => item.id === nodeId)
  if (node?.parentId) {
    for (const sibling of graph.nodes.filter((item) => item.parentId === node.parentId)) keep.add(sibling.id)
  }
  const byDegree = new Map<string, number>()
  for (const edge of graph.edges) {
    byDegree.set(edge.from, (byDegree.get(edge.from) ?? 0) + edge.weight)
    byDegree.set(edge.to, (byDegree.get(edge.to) ?? 0) + edge.weight)
  }
  const ordered = [...keep]
    .map((id) => graph.nodes.find((item) => item.id === id))
    .filter((item): item is GraphNode => Boolean(item))
    .sort((a, b) => (byDegree.get(b.id) ?? 0) - (byDegree.get(a.id) ?? 0))
  return ordered.slice(0, 30)
}

export function buildContext(input: ContextInput): ContextPayload {
  const parts: ContextPayload['parts'] = []
  const sections: string[] = []
  const zh = isZh()
  let anchorIds: string[] = []
  let locationLabel = ''

  if (input.anchor && input.document && input.includeLocationHeader) {
    const header = buildLocationHeader(input.document, input.anchor, input.anchor.quote, {
      before: input.contextParagraphsBefore,
      after: input.contextParagraphsAfter
    })
    locationLabel = header.label
    anchorIds = [input.anchor.id]
    sections.push(header.header)
    parts.push({ kind: 'quote', label: header.label || 'quote', tokens: estimateTokens(header.header) })
  }

  if (input.mode === 'fulltext') {
    if (input.document) {
      const tokens = estimateTokens(input.document.text)
      if (tokens <= MAX_FULLTEXT_TOKENS) {
        sections.push((zh ? '【文档全文】' : '[FULL TEXT]') + '\n' + input.document.text.slice(0, Math.round(MAX_FULLTEXT_TOKENS * 1.4)))
        parts.push({ kind: 'document', label: i18n.t('agent.contextFulltext', { tokens }), tokens })
      } else {
        const outlineText = input.document.blocks
          .filter((block) => block.kind === 'heading')
          .map((block) => '· ' + block.text)
          .join('\n')
        sections.push((zh ? '【文档摘要（全文超出窗口，改为大纲注入）】' : '[SUMMARY]') + '\n' + outlineText)
        parts.push({ kind: 'summary', label: i18n.t('agent.contextSummaryInjection'), tokens: Math.round(tokens / 12) })
      }
    }
  } else if (input.graph) {
    const subgraph = clipSubgraph(input.graph, input.nodeId, input.selectedNodeIds ?? [])
    if (subgraph.length > 0) {
      const byId = new Map(input.graph.nodes.map((node) => [node.id, node]))
      const lines = subgraph.map((node) => {
        const anchor = node.anchors?.[0]
        return (
          '- [' +
          node.kind +
          '] ' +
          node.title +
          (node.summary ? '：' + node.summary : '') +
          (anchor ? '（出处："' + anchor.quote.slice(0, 60).replace(/\s+/g, ' ') + '"）' : '')
        )
      })
      const relationLines = input.graph.edges
        .filter((edge) => subgraph.some((node) => node.id === edge.from) && subgraph.some((node) => node.id === edge.to))
        .map((edge) => '- ' + (byId.get(edge.from)?.title ?? '') + ' --' + edge.kind + '--> ' + (byId.get(edge.to)?.title ?? ''))
      sections.push(
        (zh ? '【关系图子图】' : '[SUBGRAPH]') +
          '\n' +
          lines.join('\n') +
          (relationLines.length > 0 ? '\n' + (zh ? '【关系】' : '[RELATIONS]') + '\n' + relationLines.join('\n') : '')
      )
      parts.push({
        kind: 'subgraph',
        label: i18n.t('agent.contextSubgraph', { count: subgraph.length }),
        tokens: estimateTokens(lines.join('\n'))
      })
    }
  }

  if (input.history.length > 0) {
    const historyText = input.history
      .slice(-8)
      .map((item) => (item.role === 'user' ? (zh ? '用户：' : 'User: ') : zh ? '助手：' : 'Assistant: ') + item.content.slice(0, 1200))
      .join('\n')
    sections.push((zh ? '【对话历史】' : '[HISTORY]') + '\n' + historyText)
    parts.push({ kind: 'history', label: i18n.t('agent.contextHistory', { count: input.history.length }), tokens: estimateTokens(historyText) })
  }

  const systemContext = sections.join('\n\n')
  const totalTokens = parts.reduce((sum, part) => sum + part.tokens, 0) + estimateTokens(input.question)
  return { systemContext, parts, totalTokens: Math.round(totalTokens), locationLabel, anchorIds }
}
