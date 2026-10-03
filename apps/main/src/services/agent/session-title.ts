/**
 * 历史会话的"人能看懂的名字" —— 纯函数（可单测），主进程与界面都按这一份规则。
 *
 * 各通道给的命名信息参差不齐（实测）：
 *  - Claude（SDK `listSessions`）：`customTitle` / `summary` / `firstPrompt` 可能有；
 *  - dsh（ACP `session/list`）：**只有 sessionId 与 cwd** —— 直接显示就是一串 UUID。
 *
 * 所以按优先级取第一个能用的：用户/AI 命名的名字 > Agent 自己给的 > 我们自己记的会话标题 > 首条提问。
 * 全都没有时返回 null，由界面显示"未命名会话 + 短 id"，而不是把整串 UUID 摆出来。
 */

export type SessionTitleSource = 'stored' | 'agent' | 'ours' | 'prompt'

export interface SessionTitleInput {
  /** 我们自己存的（用户手改或 AI 总结；优先级最高） */
  stored?: string | null
  /** Agent 自己给的名字（Claude 的 customTitle / summary） */
  agentTitle?: string | null
  /** 我们自己的会话标题（发送第一条消息时记下的前 40 字） */
  ourTitle?: string | null
  /** Agent 给的"首条提问"（可能是我们拼过的完整提示词，需要清洗） */
  firstPrompt?: string | null
}

export interface ResolvedSessionTitle {
  title: string | null
  source: SessionTitleSource | null
}

/** 位置描述头 / 引用块的标记：这些是我们拼进提示词的，不该出现在标题里。 */
const NOISE_MARKERS = [
  '【问题】',
  '【引用原文】',
  '【文档】',
  '【当前选区】',
  '【上下文】',
  '【授权模式',
  '【计划模式',
  'Question:',
  'Selected text:'
]

/**
 * 清洗成一句能当标题的话：
 *  - 只取"问题"那一段（提示词里带引用块/位置头，取最后一段通常才是用户真正问的）；
 *  - 去掉 markdown 记号、@文件引用、换行与多余空白；
 *  - 截断到 `max` 字（默认 40），超出加省略号。
 */
export function cleanSessionTitle(raw: string | null | undefined, max = 40): string | null {
  let text = String(raw ?? '')
  if (text.trim().length === 0) return null

  // 提示词里带"【问题】"之类的分段：优先取最后一个标记之后的内容（那才是用户问的）
  for (const marker of NOISE_MARKERS) {
    const index = text.lastIndexOf(marker)
    if (index >= 0) text = text.slice(index + marker.length)
  }

  text = text
    .replace(/```[\s\S]*?```/g, ' ') // 代码块整段丢弃
    .replace(/`([^`]*)`/g, '$1') // 行内代码只留内容
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接留文字
    .replace(/^\s{0,3}#{1,6}\s*/gm, '') // 标题记号
    .replace(/^\s{0,3}>\s?/gm, '') // 引用记号
    .replace(/^\s{0,3}[-*+]\s+/gm, '') // 列表记号
    .replace(/\*\*|__|\*|_/g, '') // 加粗/斜体
    // @文件引用：带分隔符的整段路径（可能含中文目录名）整块丢掉，再兜一遍简单的 @词
    .replace(/@[^\s]*[/\\][^\s]*/g, ' ')
    .replace(/@[A-Za-z0-9_.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // 去掉常见的引号包裹
  text = text.replace(/^["'“”『「]+|["'“”』」]+$/g, '').trim()
  if (text.length === 0) return null
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** 按优先级挑一个标题；都没有就 null（界面显示"未命名会话"）。 */
export function resolveSessionTitle(input: SessionTitleInput): ResolvedSessionTitle {
  const candidates: { source: SessionTitleSource; value: string | null | undefined }[] = [
    { source: 'stored', value: input.stored },
    { source: 'agent', value: input.agentTitle },
    { source: 'ours', value: input.ourTitle },
    { source: 'prompt', value: input.firstPrompt }
  ]
  for (const candidate of candidates) {
    const cleaned = cleanSessionTitle(candidate.value)
    if (cleaned) return { title: cleaned, source: candidate.source }
  }
  return { title: null, source: null }
}

/** 列表里显示不出来名字时的兜底：短 id + 一句"未命名"，总比一串 UUID 强。 */
export function shortSessionId(sessionId: string, length = 8): string {
  const text = String(sessionId ?? '')
  return text.length <= length ? text : text.slice(0, length)
}

/**
 * 我们自己跑的内部任务（不是"用户会话"）—— 历史列表里要把它们滤掉。
 *
 * 实测踩到：图谱抽取走的是 `runOnce`（一次性会话），CLI 照样把每次抽取存成一条会话，
 * 于是历史列表里塞满"你是严谨的文档逻辑结构抽取器…"这种条目（用户压根没聊过它们）。
 * 判据用**我们自己的提示词特征**；命中就当内部任务，不列给用户。
 */
const INTERNAL_PROMPT_MARKERS = [
  '你是严谨的文档逻辑结构抽取器',
  '只输出 JSON，不要输出任何解释',
  'Output JSON only',
  '你是文档逻辑图的布局助手'
]

export function isInternalSession(firstPrompt: string | null | undefined): boolean {
  const text = String(firstPrompt ?? '')
  if (text.trim().length === 0) return false
  return INTERNAL_PROMPT_MARKERS.some((marker) => text.includes(marker))
}
