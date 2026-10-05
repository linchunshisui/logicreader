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
  /*
   * 绑定文档（恢复这篇文档的默认会话）：从选区提问时面板可能还没打开过 ——
   * 不绑的话 send 会另起一条新会话，而不是落在文档默认会话里。
   *
   * ★ 只在**选区明确指向另一篇文档**时才换绑。
   * 旧写法把目标写成 `options.selection?.docId ?? null` —— 于是在**面板里直接打字**
   * （没有选区 → null）时，会把当前绑定从"这篇论文"换成 **null（全局会话）**：
   * 论文那条默认会话连同消息一起被清掉，面板立刻回到空态（用户看到的是"消息没了 / 界面跳了"）。
   * 冒烟 `smoke.assertAgentScroll` 的 `docIdBefore/docIdAfter` 就是照这个来的。
   */
  const selectionDocId = options.selection?.docId ?? null
  if (selectionDocId && useAgent.getState().docId !== selectionDocId) {
    await useAgent.getState().bindDocument(selectionDocId)
  }
  /*
   * 这里**不再**顺手发起"通读全文"。
   *
   * 旧实现会先跑一轮通读（整篇全文进上下文），用户的提问跟在它后面 ——
   * 结果是"问一句选中的话"也要先花一次模型调用来通读全文，用户没有同意过。
   * 现在通读要由用户在面板里点「开始通读」；从选区直接提问就是这条会话的第一轮，
   * 文档默认会话照样成立（`send()` 建会话时会把当前文档的目录作为工作目录）。
   */
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
/**
 * 我们**注入**的前导块的头标记（授权模式提醒 + 上下文各段，见 lib/contextBuilder.ts 与
 * shared/permissions.ts 的 planModeReminder）。回放历史会话时要靠它把这些块摘掉。
 */
const INJECTED_HEADS = [
  /^【授权模式：/,
  /^\[Permission mode:/,
  /^【引用位置】/,
  /^\[LOCATION\]/,
  /^【引用原文】/,
  /^\[QUOTE\]/,
  /^【文档全文】/,
  /^\[FULL TEXT\]/,
  /^【文档摘要/,
  /^\[SUMMARY\]/,
  /^【关系图子图】/,
  /^\[SUBGRAPH\]/,
  /^【关系】/,
  /^\[RELATIONS\]/,
  /^【对话历史】/,
  /^\[HISTORY\]/
]

/** 内部**可能带空行**的大块（全文 / 摘要 / 历史 / 子图）：不能按"第一个空行"切 */
const BIG_BLOCK_HEADS = [/^【文档全文】/, /^\[FULL TEXT\]/, /^【文档摘要/, /^\[SUMMARY\]/, /^【对话历史】/, /^\[HISTORY\]/, /^【关系图子图】/, /^\[SUBGRAPH\]/]

const startsWithInjected = (text: string): boolean => INJECTED_HEADS.some((pattern) => pattern.test(text))

/** 最后一段（提问总是拼在最末尾：`systemContext + '\n\n' + 问题`） */
const lastParagraph = (text: string): string => {
  const parts = text.split('\n\n')
  return (parts[parts.length - 1] ?? '').trim()
}

/**
 * 摘掉**我们注入的**前导块，返回用户真正问的那句。
 *
 * 为什么必须有：历史会话回放读的是 **Agent 自己的报文日志**（dsh 的 session 日志 / CLI 的会话记录），
 * 那里的"用户消息"其实是我们拼好的 `systemContext + '\n\n' + 问题`
 * （拼装见 sdk.ts 的 prompt：`input.systemContext + '\n\n' + input.text`）。
 * 直接拿开头 80 字当核心诉求，用户看到的就是「【授权模式：计划】- 先判断这个任务是否真的需要计划…」——
 * 一句他从来没打过、也看不懂的话（用户报的正是这个："行为与后续回答对应"）。
 *
 * 规则：
 *  - 头不是我们注入的 → 原样返回（绝大多数提问走这条）；
 *  - 短块（授权模式提醒 / 引用位置 / 引用原文）逐块按空行切掉；
 *  - 大块（全文 / 历史 / 子图）内部本来就有空行，按空行切会切进正文 —— 这时取**最后一段**。
 */
export function stripInjectedPreamble(question: string): string {
  let rest = (question ?? '').replace(/^\s+/, '')
  for (let guard = 0; guard < 8 && startsWithInjected(rest); guard += 1) {
    if (BIG_BLOCK_HEADS.some((pattern) => pattern.test(rest))) return lastParagraph(rest)
    const cut = rest.indexOf('\n\n')
    if (cut < 0) return ''
    rest = rest.slice(cut + 2).replace(/^\s+/, '')
  }
  return rest
}

export function coreIntentOf(question: string, maxChars = 80): string {
  const text = stripInjectedPreamble(question ?? '')
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
