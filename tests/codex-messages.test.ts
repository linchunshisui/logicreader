import { describe, expect, it } from 'vitest'
import {
  approvalPolicyFor,
  newCodexTurn,
  toCodexApprovalDetail,
  toCodexApprovalResponse,
  translateCodexNotification
} from '../apps/main/src/services/agent/codex'
import { mapCodexModel } from '../apps/main/src/services/agent/model-view'
import type { AgentEvent } from '../apps/main/src/services/agent/types'

/**
 * Codex app-server 报文翻译的**确定性**验证。
 *
 * 报文形状全部取自本机实测（`codex app-server` 0.159.2）：真跑一轮要几十秒、
 * 还要消耗模型配额，用它验证"翻译层"会把测试变成碰运气。
 * 这里直接喂真实报文，断言语义。
 */
function collect(): { events: AgentEvent[]; emit: (event: AgentEvent) => void } {
  const events: AgentEvent[] = []
  return { events, emit: (event) => events.push(event) }
}

const textOf = (events: AgentEvent[]): string[] =>
  events.filter((event) => event.type === 'text-delta').map((event) => (event as { text: string }).text)

describe('Codex 通知翻译', () => {
  it('流式增量拼出正文，完整 item 不再重复输出', () => {
    const { events, emit } = collect()
    const state = newCodexTurn('t1')
    translateCodexNotification('item/agentMessage/delta', { itemId: 'm1', delta: 'p' }, emit, state)
    translateCodexNotification('item/agentMessage/delta', { itemId: 'm1', delta: 'ong' }, emit, state)
    translateCodexNotification('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'pong' } }, emit, state)
    expect(textOf(events)).toEqual(['p', 'ong'])
    expect(state.text).toBe('pong')
  })

  it('不吐增量的模型：完整正文仍要补发（一次性抽取的空文本兜底）', () => {
    const { events, emit } = collect()
    const state = newCodexTurn('t1')
    translateCodexNotification(
      'item/completed',
      { item: { type: 'agentMessage', id: 'm2', text: '{"entities":[]}', phase: 'final_answer' } },
      emit,
      state
    )
    expect(textOf(events)).toEqual(['{"entities":[]}'])
  })

  it('思考增量走 thinking；已经流式吐过的 reasoning 完整条目不再补', () => {
    const { events, emit } = collect()
    const state = newCodexTurn('t1')
    translateCodexNotification('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: '先看结构' }, emit, state)
    translateCodexNotification(
      'item/completed',
      { item: { type: 'reasoning', id: 'r1', summary: ['先看结构'], content: [] } },
      emit,
      state
    )
    const thinking = events.filter((event) => event.type === 'thinking').map((event) => (event as { text: string }).text)
    expect(thinking).toEqual(['先看结构'])
  })

  it('没有思考增量时，reasoning 的 content / summary 合并补发', () => {
    const { events, emit } = collect()
    translateCodexNotification(
      'item/completed',
      { item: { type: 'reasoning', id: 'r2', summary: ['总结'], content: ['正文思考'] } },
      emit,
      newCodexTurn('t1')
    )
    expect(events).toEqual([{ type: 'thinking', text: '总结\n正文思考' }])
  })

  it('命令执行：item/started 出工具卡片，item/completed 用同一个 id 出结果', () => {
    const { events, emit } = collect()
    const state = newCodexTurn('t1')
    translateCodexNotification(
      'item/started',
      {
        item: {
          type: 'commandExecution',
          id: 'call_1',
          command: 'pwsh -Command \'echo hi\'',
          cwd: 'D:/w',
          status: 'inProgress'
        }
      },
      emit,
      state
    )
    translateCodexNotification(
      'item/completed',
      {
        item: {
          type: 'commandExecution',
          id: 'call_1',
          command: 'pwsh -Command \'echo hi\'',
          cwd: 'D:/w',
          status: 'completed',
          aggregatedOutput: 'hi',
          exitCode: 0
        }
      },
      emit,
      state
    )
    expect(events[0]).toMatchObject({ type: 'tool-call', id: 'call_1', name: 'Bash', title: 'pwsh -Command \'echo hi\'' })
    expect(events[1]).toMatchObject({ type: 'tool-result', id: 'call_1', name: 'Bash', output: 'hi', isError: false })
  })

  it('文件改动的标题用人话路径（多个文件报数量）', () => {
    const { events, emit } = collect()
    translateCodexNotification(
      'item/started',
      { item: { type: 'fileChange', id: 'f1', changes: [{ path: 'D:/w/a.md' }, { path: 'D:/w/b.md' }] } },
      emit,
      newCodexTurn('t1')
    )
    expect(events[0]).toMatchObject({ type: 'tool-call', name: 'Edit', title: 'D:/w/a.md 等 2 个文件' })
  })

  it('失败的命令标成 isError', () => {
    const { events, emit } = collect()
    const state = newCodexTurn('t1')
    translateCodexNotification('item/started', { item: { type: 'commandExecution', id: 'c9', command: 'x' } }, emit, state)
    translateCodexNotification(
      'item/completed',
      { item: { type: 'commandExecution', id: 'c9', command: 'x', status: 'failed', aggregatedOutput: 'boom' } },
      emit,
      state
    )
    expect(events[1]).toMatchObject({ type: 'tool-result', isError: true, output: 'boom' })
  })

  it('计划（turn/plan/updated）翻成 plan 事件', () => {
    const { events, emit } = collect()
    translateCodexNotification(
      'turn/plan/updated',
      { plan: [{ step: '读文档', status: 'completed' }, { step: '抽取实体', status: 'inProgress' }] },
      emit,
      newCodexTurn('t1')
    )
    expect(events).toEqual([
      { type: 'plan', entries: [{ content: '读文档', status: 'completed' }, { content: '抽取实体', status: 'inProgress' }] }
    ])
  })

  it('用量取 last 分解（含缓存命中）', () => {
    const { events, emit } = collect()
    translateCodexNotification(
      'thread/tokenUsage/updated',
      { tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 7 } } },
      emit,
      newCodexTurn('t1')
    )
    expect(events).toEqual([{ type: 'usage', inputTokens: 120, outputTokens: 7 }])
  })

  it('回合结束给 done；失败回合先给 error', () => {
    const { events, emit } = collect()
    translateCodexNotification('turn/completed', { turn: { id: 'x', status: 'completed' } }, emit, newCodexTurn('t1'))
    expect(events).toEqual([{ type: 'done', stopReason: 'end_turn' }])

    const failed = collect()
    translateCodexNotification(
      'turn/completed',
      { turn: { id: 'y', status: 'failed', error: { message: 'model exploded' } } },
      failed.emit,
      newCodexTurn('t1')
    )
    expect(failed.events[0]).toEqual({ type: 'error', message: 'model exploded', retryable: true })
    expect(failed.events[1]).toMatchObject({ type: 'done' })
  })

  it('error 通知（app-server 顶层报错）走 error 事件', () => {
    const { events, emit } = collect()
    translateCodexNotification('error', { error: { message: 'rate limited' } }, emit, newCodexTurn('t1'))
    expect(events).toEqual([{ type: 'error', message: 'rate limited', retryable: true }])
  })

  it('thread/started 带出远端线程 id 与真实模型名', () => {
    const { events, emit } = collect()
    const state = newCodexTurn(null)
    translateCodexNotification(
      'thread/started',
      { thread: { id: 'th_1', model: 'deepseek-flash' } },
      emit,
      state
    )
    expect(events).toEqual([{ type: 'session', remoteSessionId: 'th_1', resumed: false, activeModel: 'deepseek-flash' }])
    expect(state.threadId).toBe('th_1')
  })
})

describe('Codex 授权档位映射', () => {
  it('manual / plan 一律问人，edit / auto 让 Agent 先动手', () => {
    expect(approvalPolicyFor('manual')).toBe('untrusted')
    expect(approvalPolicyFor('plan')).toBe('untrusted')
    expect(approvalPolicyFor('edit')).toBe('on-request')
    expect(approvalPolicyFor('auto')).toBe('on-request')
    expect(approvalPolicyFor(undefined)).toBe('untrusted')
  })
})

describe('Codex 审批往返', () => {
  it('命令审批：候选项来自 availableDecisions，卡片 id 用 app-server 的原值', () => {
    const detail = toCodexApprovalDetail('item/commandExecution/requestApproval', {
      command: 'echo hi',
      cwd: 'D:/w',
      availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['echo'] } }, 'cancel']
    })
    expect(detail).not.toBeNull()
    expect(detail?.kind).toBe('execute')
    expect(detail?.title).toBe('echo hi')
    expect(detail?.options.map((option) => option.optionId)).toEqual([
      'accept',
      'acceptWithExecpolicyAmendment',
      'cancel'
    ])
    // 策略层只认 kind：允许类必须以 allow_ 开头，拒绝类必须以 reject 开头
    expect(detail?.options[0].kind).toBe('allow_once')
    expect(detail?.options[2].kind.startsWith('reject')).toBe(true)
  })

  it('文件改动审批：四档齐全（含"本会话内始终允许"）', () => {
    const detail = toCodexApprovalDetail('item/fileChange/requestApproval', { itemId: 'i1' })
    expect(detail?.kind).toBe('write')
    expect(detail?.options.map((option) => option.optionId)).toEqual([
      'accept',
      'acceptForSession',
      'decline',
      'cancel'
    ])
  })

  it('不认识的服务器请求返回 null（调用方回错误，而不是猜形状）', () => {
    expect(toCodexApprovalDetail('mcpServer/elicitation/request', {})).toBeNull()
  })

  it('回执报文：直通 accept / acceptForSession / cancel，拒绝落到 decline', () => {
    const params = { command: 'echo hi' }
    expect(toCodexApprovalResponse('item/commandExecution/requestApproval', params, 'accept')).toEqual({ decision: 'accept' })
    expect(toCodexApprovalResponse('item/commandExecution/requestApproval', params, 'acceptForSession')).toEqual({
      decision: 'acceptForSession'
    })
    expect(toCodexApprovalResponse('item/commandExecution/requestApproval', params, 'cancel')).toEqual({ decision: 'cancel' })
    expect(toCodexApprovalResponse('item/commandExecution/requestApproval', params, null)).toEqual({ decision: 'decline' })
  })

  it('"记住这类命令"要原样带回 execpolicy 修正案', () => {
    const response = toCodexApprovalResponse(
      'item/commandExecution/requestApproval',
      { proposedExecpolicyAmendment: ['echo', 'hi'] },
      'acceptWithExecpolicyAmendment'
    )
    expect(response).toEqual({
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['echo', 'hi'] } }
    })
  })

  it('额外权限审批：放行时回传请求的权限，拒绝时回空档案', () => {
    const params = { permissions: { network: { enabled: true } } }
    expect(toCodexApprovalResponse('item/permissions/requestApproval', params, 'accept')).toEqual({
      permissions: { network: { enabled: true } },
      scope: 'turn'
    })
    expect(toCodexApprovalResponse('item/permissions/requestApproval', params, null)).toEqual({
      permissions: { fileSystem: null, network: null }
    })
  })
})

describe('Codex 模型清单映射', () => {
  it('真实模型名 + 逐模型思考强度档位都带进界面视图', () => {
    const view = mapCodexModel({
      id: 'deepseek-flash',
      model: 'deepseek-flash',
      displayName: 'DeepSeek V4.1 Flash',
      description: 'Latest frontier agentic coding model with image input.',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: '快' },
        { reasoningEffort: 'high', description: '更深' }
      ],
      defaultReasoningEffort: 'high'
    })
    expect(view.id).toBe('deepseek-flash')
    expect(view.name).toBe('DeepSeek V4.1 Flash')
    expect(view.supportsEffort).toBe(true)
    expect(view.effortLevels).toEqual(['low', 'high'])
    expect(view.thoughtLevels).toEqual([
      { id: 'low', name: 'low', description: '快' },
      { id: 'high', name: 'high', description: '更深' }
    ])
    expect(view.defaultThoughtLevel).toBe('high')
  })

  it('没声明思考强度的模型不会伪造档位', () => {
    const view = mapCodexModel({ id: 'gpt-5', displayName: 'gpt-5' })
    expect(view.supportsEffort).toBe(false)
    expect(view.thoughtLevels).toBeUndefined()
    expect(view.defaultThoughtLevel).toBeNull()
  })
})
