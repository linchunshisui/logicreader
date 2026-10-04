/**
 * 提问流程：选区/节点 → 上下文 → Agent → 提问入图（规划书 §5.6 / §5.8 / FR-8）。
 */
import { createAnchor } from '@logicreader/document-model'
import { api } from '../lib/api'
import { buildContext } from '../lib/contextBuilder'
import { buildSelectionQuestion } from '../lib/askPreset'
import { useAgent } from './agent.store'
import { useDocuments } from './documents.store'
import { useGraph } from './graph.store'
import { useTabs } from './tabs.store'
import { useUiStore } from './ui.store'
import { useSettings } from './settings.store'
import { notify } from './notifications.store'
import { openGraphTab } from '../commands'
import i18n from '../i18n'

export interface AskOptions {
  question: string
  /** 提问来源节点（图谱模式） */
  nodeId?: string | null
  /** 选区文本（自由选区提问） */
  selection?: { docId: string; charStart: number; charEnd: number; text: string } | null
  openGraph?: boolean
}

/** 保证存在锚点记录（选区提问时首次创建）。 */
async function ensureAnchor(docId: string, charStart: number, charEnd: number): Promise<string | null> {
  const documents = useDocuments.getState()
  const model = documents.models[docId]
  if (!model) return null
  const anchor = createAnchor({ model, charStart, charEnd, origin: 'selection' })
  await api.store.saveAnchors([
    {
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
    }
  ])
  return anchor.id
}

export async function ask(options: AskOptions): Promise<void> {
  const agent = useAgent.getState()
  await agent.init()
  if (!agent.selectedAgentId || agent.agents.filter((item) => item.capability?.available).length === 0) {
    notify(i18n.t('agent.unavailableHint'), 'warning', { timeoutMs: 8000 })
    return
  }
  // 绑定文档（恢复这篇文档的默认会话）：从选区提问时面板可能还没打开过——
  // 不绑的话 send 会另起一条新会话，而不是落在文档默认会话里
  if (useAgent.getState().docId !== (options.selection?.docId ?? null)) {
    await useAgent.getState().bindDocument(options.selection?.docId ?? null)
  }
  // 确保默认会话已在（首轮通读若还没跑，先跑它——用户的提问会紧跟着落在同一会话里）
  await useAgent.getState().ensureDocumentSession()
  const tabs = useTabs.getState()
  const activeTab = tabs.activeTab()
  const docId = activeTab && activeTab.kind !== 'welcome' && activeTab.kind !== 'settings' ? activeTab.docId : null
  const documents = useDocuments.getState()
  const graph = useGraph.getState()
  const model = docId ? documents.models[docId] ?? null : null
  const settings = useSettings.getState().settings

  let anchor = null
  let anchorId: string | null = null
  if (options.selection && options.selection.docId === docId) {
    anchorId = await ensureAnchor(options.selection.docId, options.selection.charStart, options.selection.charEnd)
    const stored = anchorId ? await api.store.getAnchor(anchorId) : null
    if (stored) {
      anchor = {
        id: stored.id,
        docId: stored.docId,
        docHash: stored.docHash,
        blockIds: JSON.parse(stored.blockIds) as string[],
        charStart: stored.charStart,
        charEnd: stored.charEnd,
        quote: stored.quote,
        quoteHash: stored.quoteHash,
        primary: JSON.parse(stored.primaryJson),
        extras: stored.extrasJson ? JSON.parse(stored.extrasJson) : [],
        status: stored.status
      }
    }
  } else if (options.nodeId && graph.graph) {
    const node = graph.graph.nodes.find((item) => item.id === options.nodeId)
    const first = node?.anchorIds[0]
    if (first) {
      const stored = await api.store.getAnchor(first)
      if (stored) {
        anchorId = stored.id
        anchor = {
          id: stored.id,
          docId: stored.docId,
          docHash: stored.docHash,
          blockIds: JSON.parse(stored.blockIds) as string[],
          charStart: stored.charStart,
          charEnd: stored.charEnd,
          quote: stored.quote,
          quoteHash: stored.quoteHash,
          primary: JSON.parse(stored.primaryJson),
          extras: stored.extrasJson ? JSON.parse(stored.extrasJson) : [],
          status: stored.status
        }
      }
    }
  }

  const payload = buildContext({
    mode: agent.contextMode,
    document: model,
    graph: graph.graph,
    anchor,
    nodeId: options.nodeId ?? null,
    history: agent.messages.map((message) => ({ role: message.role, content: message.content })),
    question: options.question,
    contextParagraphsBefore: settings.reader.contextParagraphsBefore,
    contextParagraphsAfter: settings.reader.contextParagraphsAfter,
    includeLocationHeader: settings.reader.includeLocationHeader
  })

  /**
   * 核心诉求 = 用户真正想问的那句话（"解释选中的内容：Maximum Compound Divergence (MCD)"），
   * 历史回放与关系图节点显示它；实际发给 Agent 的仍是完整提问（含引用材料与位置头，不精简）。
   * 纯文本提问（没有材料前缀）的摘要就是原文本身。
   */
  const summary = coreIntentOf(options.question)

  await agent.send(options.question, {
    systemContext: payload.systemContext,
    locationLabel: payload.locationLabel,
    anchorIds: payload.anchorIds,
    summary
  })

  // 提问入图（FR-8.2）：回答完成后新增 inquiry 节点（标题=核心诉求，摘要=回答开头）并与来源节点连边
  const messages = useAgent.getState().messages
  const answer = [...messages].reverse().find((message) => message.role === 'assistant')
  if (graph.graph && docId === graph.graph.docId) {
    const nodeId = await graph.addInquiryNode({
      title: summary.slice(0, 28),
      summary: (answer?.content ?? '').slice(0, 120),
      anchorIds: anchorId ? [anchorId] : [],
      fromNodeId: options.nodeId ?? null
    })
    if (nodeId && options.openGraph) openGraphTab(graph.graph.docId)
  }
  if (anchorId) {
    useUiStore.getState().setSelection(
      useUiStore.getState().selection ? { ...useUiStore.getState().selection!, anchorId } : null
    )
  }
}

const PRESET_LABEL_KEYS: Record<'explain' | 'ask' | 'translate' | 'graph', string> = {
  explain: 'agent.presetExplain',
  ask: 'agent.presetAsk',
  translate: 'agent.presetTranslate',
  graph: 'agent.presetToGraph'
}

/**
 * 从一条提问里提取**核心诉求**（纯函数，可单测）。
 *
 * 带引用材料的提问长这样（§5.6.3 的预设构造）：
 *   "解释选中的内容：\n<选区原文可能很长>"
 * 核心诉求 = 动作标签 + 选区**开头一小段**（让"选的哪段"可辨认，但不把整段材料摆进历史）。
 * 没有材料前缀的普通提问，核心诉求就是原文（截到 80 字）。
 */
export function coreIntentOf(question: string, maxChars = 80): string {
  const text = question ?? ''
  const labelEnd = text.indexOf('：')
  if (labelEnd <= 0 || labelEnd > 30) return text.slice(0, maxChars)
  const label = text.slice(0, labelEnd).trim()
  if (label.length === 0) return text.slice(0, maxChars)
  const body = text.slice(labelEnd + 1).replace(/\s+/g, ' ').trim()
  if (body.length === 0) return label
  const keep = Math.max(20, maxChars - label.length - 1)
  const bodyPart = body.length > keep ? body.slice(0, keep) + '…' : body
  return label + '：' + bodyPart
}

/**
 * 组装"就选中内容提问"的问题文本 —— UI 与冒烟共用这一个函数，
 * 这样"冒烟断言的问题"就是"用户点按钮时发出去的问题"。
 *
 * 老实现有两个坑（都被真实反馈打出来）：
 *   1. 用的是 `agent.translateSelection` 这种**不存在的键**（那些键在 `cmd.` 命名空间下）
 *      → 问题文本里出现的是字面的 "agent.translateSelection："（日志里还有缺键告警）；
 *   2. 选区文本被 `slice(0, 60)` 砍断，一整行标题断在"…of SQL"上。
 */
export function selectionQuestion(
  kind: 'explain' | 'ask' | 'translate' | 'graph' | 'custom',
  selection: { docId: string; text: string }
): string {
  const settings = useSettings.getState().settings
  const model = useDocuments.getState().models[selection.docId] ?? null
  const label = i18n.t(PRESET_LABEL_KEYS[kind as keyof typeof PRESET_LABEL_KEYS] ?? 'agent.presetAsk')
  return buildSelectionQuestion({
    label,
    text: selection.text,
    // 与 buildContext 的判据保持一致：带了完整引用才敢说"完整内容见【引用原文】"
    fullQuoteInContext: Boolean(model) && settings.reader.includeLocationHeader
  }).question
}

export async function askFromSelection(kind: 'explain' | 'ask' | 'translate' | 'graph' | 'custom', question?: string): Promise<void> {
  const selection = useUiStore.getState().selection
  if (!selection) {
    notify(i18n.t('agent.noSelection'), 'info')
    return
  }
  const preset = question ?? selectionQuestion(kind, selection)
  await ask({
    question: preset,
    selection: {
      docId: selection.docId,
      charStart: selection.charStart,
      charEnd: selection.charEnd,
      text: selection.text
    },
    openGraph: kind === 'graph'
  })
}

export async function askFromNode(nodeId: string, question: string): Promise<void> {
  await ask({ question, nodeId })
}
