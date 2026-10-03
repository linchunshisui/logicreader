/**
 * "就选中内容提问"的问题文本构造（纯函数，可单测）。
 *
 * 两条规矩都是被真实反馈打出来的：
 *  1. **不许悄悄截断选区文本** —— 老实现是 `selection.text.slice(0, 60)`：
 *     用户选中了一整行标题（77 字），送给 Agent 的却只有前 60 字，断在半个词组上；
 *  2. 真到了必须截断的长度，也要**说清楚**：截了多少、完整内容在哪。
 *     上下文里没带完整引用时更不能撒谎说"见【引用原文】"。
 */
export const MAX_QUESTION_SELECTION_CHARS = 8000

export interface SelectionQuestion {
  question: string
  /** 实际放进问题的选区字数 */
  included: number
  truncated: boolean
}

export function buildSelectionQuestion(input: {
  /** 动作名，如"翻译选中的内容"（由调用方按界面语言给） */
  label: string
  text: string
  /** 上下文里是否带了完整引用（决定截断时那句提示怎么写） */
  fullQuoteInContext: boolean
  maxChars?: number
}): SelectionQuestion {
  const max = input.maxChars ?? MAX_QUESTION_SELECTION_CHARS
  const text = input.text ?? ''
  const truncated = text.length > max
  const body = truncated ? text.slice(0, max) : text
  let question = input.label + '：\n' + body
  if (truncated) {
    question +=
      '\n（选区较长，以上为前 ' +
      max +
      ' 字' +
      (input.fullQuoteInContext ? '，完整选区见上文【引用原文】' : '，建议缩小选区后重试') +
      '）'
  }
  return { question, included: body.length, truncated }
}
