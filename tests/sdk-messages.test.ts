import { describe, expect, it, vi } from 'vitest'
import {
  baselinePathOf,
  buildQueryOptions,
  newTurn,
  translateMessage,
  toSdkPermissionMode,
  toolTitle
} from '../apps/main/src/services/agent/sdk'
import type { AgentEvent } from '../apps/main/src/services/agent/types'

/**
 * SDK 消息翻译的**确定性**验证。
 *
 * 为什么不用真实模型跑：第三方代理一轮要几十秒，用它验证"翻译层"会把测试变成碰运气。
 * 这里直接喂官方 SDK 真实形状的消息（字段取自实测报文），断言语义。
 */
function collect(): { events: AgentEvent[]; emit: (event: AgentEvent) => void } {
  const events: AgentEvent[] = []
  return { events, emit: (event) => events.push(event) }
}

describe('SDK 消息翻译', () => {
  it('流式增量拼出文本，完整消息不再重复输出', () => {
    const { events, emit } = collect()
    const state = newTurn()
    translateMessage(
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } } },
      emit,
      state
    )
    translateMessage(
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '好' } } },
      emit,
      state
    )
    // 随后到达的完整 assistant 消息里带着同样的文本：不能重复吐
    translateMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: '你好' }] } },
      emit,
      state
    )
    const texts = events.filter((event) => event.type === 'text-delta').map((event) => (event as { text: string }).text)
    expect(texts).toEqual(['你', '好'])
  })

  it('没有流式增量时，完整消息仍要输出（老 CLI 的路径）', () => {
    const { events, emit } = collect()
    const state = newTurn()
    translateMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '完整回答' }] } }, emit, state)
    expect(events).toEqual([{ type: 'text-delta', text: '完整回答' }])
  })

  it('工具调用与结果用同一个 tool_use_id 关联', () => {
    const { events, emit } = collect()
    const state = newTurn()
    translateMessage(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Edit', input: { file_path: 'D:/a/note.txt' } }] } },
      emit,
      state
    )
    translateMessage(
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok', is_error: false }] } },
      emit,
      state
    )
    const call = events.find((event) => event.type === 'tool-call')
    const result = events.find((event) => event.type === 'tool-result')
    expect(call).toMatchObject({ type: 'tool-call', id: 'tu_1', name: 'Edit' })
    expect(result).toMatchObject({ type: 'tool-result', id: 'tu_1', isError: false })
  })

  it('工具结果到达时触发"算差异"回调（内联 diff 的接线）', () => {
    const { emit } = collect()
    const onFileDiff = vi.fn()
    const state = newTurn(onFileDiff)
    translateMessage(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_9', name: 'Write', input: { file_path: 'x' } }] } },
      emit,
      state
    )
    translateMessage(
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_9', content: 'ok' }] } },
      emit,
      state
    )
    expect(onFileDiff).toHaveBeenCalledWith('tu_9')
  })

  it('失败的工具结果不算差异', () => {
    const { emit } = collect()
    const onFileDiff = vi.fn()
    const state = newTurn(onFileDiff)
    translateMessage(
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_x', is_error: true }] } },
      emit,
      state
    )
    expect(onFileDiff).not.toHaveBeenCalled()
  })

  it('子代理的工具调用带 parentId（子代理可观测性的数据源）', () => {
    const { events, emit } = collect()
    const state = newTurn()
    // 主线程的调用：没有 parent_tool_use_id
    translateMessage(
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'main_1', name: 'Read', input: { file_path: 'a' } }] } },
      emit,
      state
    )
    // 子代理内部的调用：带 parent_tool_use_id
    translateMessage(
      {
        type: 'assistant',
        parent_tool_use_id: 'task_1',
        message: { content: [{ type: 'tool_use', id: 'sub_1', name: 'Grep', input: { pattern: 'x' } }] }
      },
      emit,
      state
    )
    const calls = events.filter((event) => event.type === 'tool-call') as { id: string; parentId?: string }[]
    expect(calls.find((call) => call.id === 'main_1')?.parentId).toBeUndefined()
    expect(calls.find((call) => call.id === 'sub_1')?.parentId).toBe('task_1')
  })

  it('子代理状态在消息之间正确切换（不粘住）', () => {
    const { events, emit } = collect()
    const state = newTurn()
    translateMessage(
      { type: 'assistant', parent_tool_use_id: 'task_9', message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] } },
      emit,
      state
    )
    // 主线程的下一条消息必须把归属清掉，否则后续调用会被错误归到子代理名下
    translateMessage(
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'b', name: 'Write', input: { file_path: 'x' } }] } },
      emit,
      state
    )
    const calls = events.filter((event) => event.type === 'tool-call') as { id: string; parentId?: string }[]
    expect(calls.find((call) => call.id === 'a')?.parentId).toBe('task_9')
    expect(calls.find((call) => call.id === 'b')?.parentId).toBeUndefined()
  })

  it('检查点 id 取自 user_message_uuid（回退功能的数据源）', () => {
    const { emit } = collect()
    const onCheckpoint = vi.fn()
    const state = newTurn(undefined, onCheckpoint)
    translateMessage(
      { type: 'assistant', user_message_uuid: 'uuid-abc', message: { content: [{ type: 'text', text: 'hi' }] } },
      emit,
      state
    )
    expect(onCheckpoint).toHaveBeenCalledWith('uuid-abc')
  })

  it('错误结果无论 subtype 都报 error（登录失败时 subtype 仍是 success）', () => {
    const { events, emit } = collect()
    translateMessage({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in' }, emit, newTurn())
    expect(events).toEqual([{ type: 'error', message: 'Not logged in', retryable: true }])
  })

  it('正常结果给出 done 与用量', () => {
    const { events, emit } = collect()
    translateMessage(
      { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3 } },
      emit,
      newTurn()
    )
    expect(events).toContainEqual({ type: 'done', stopReason: 'end_turn' })
    expect(events).toContainEqual({ type: 'usage', inputTokens: 10, outputTokens: 3 })
  })

  it('正文只出现在 result.result 里时补发（一次性抽取的空文本兜底）', () => {
    const { events, emit } = collect()
    translateMessage({ type: 'result', subtype: 'success', is_error: false, result: '{"entities":[]}' }, emit, newTurn())
    expect(events).toContainEqual({ type: 'text-delta', text: '{"entities":[]}' })
    expect(events).toContainEqual({ type: 'done', stopReason: 'success' })
    // 正文必须先于 done：一次性任务在 done 时就会把文本取走
    expect(events.findIndex((event) => event.type === 'text-delta')).toBeLessThan(events.findIndex((event) => event.type === 'done'))
  })

  it('正文已经流式吐过就不再补发（避免重复）', () => {
    const { events, emit } = collect()
    const state = newTurn()
    translateMessage(
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '真正文' } } },
      emit,
      state
    )
    translateMessage({ type: 'result', subtype: 'success', is_error: false, result: '真正文' }, emit, state)
    const texts = events.filter((event) => event.type === 'text-delta')
    expect(texts).toEqual([{ type: 'text-delta', text: '真正文' }])
  })

  it('system/init 带出远端会话 id', () => {
    const { events, emit } = collect()
    translateMessage({ type: 'system', subtype: 'init', session_id: 'sess-1' }, emit, newTurn())
    expect(events).toEqual([{ type: 'session', remoteSessionId: 'sess-1', resumed: false }])
  })
})

describe('改动前基线：从 hook 载荷里取路径', () => {
  it('取 tool_input.file_path（本机实测的真实形状）', () => {
    expect(
      baselinePathOf({
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: 'D:/a/note.txt', content: 'x' },
        tool_use_id: 'call_1'
      })
    ).toBe('D:/a/note.txt')
  })

  it('兼容顶层 file_path（不同版本/事件）', () => {
    expect(baselinePathOf({ file_path: 'D:/b.txt' })).toBe('D:/b.txt')
  })

  it('NotebookEdit 用 notebook_path', () => {
    expect(baselinePathOf({ tool_input: { notebook_path: 'D:/n.ipynb' } })).toBe('D:/n.ipynb')
  })

  it('拿不到路径就返回 null（不抓空基线）', () => {
    expect(baselinePathOf({ tool_input: { command: 'ls' } })).toBeNull()
    expect(baselinePathOf(null)).toBeNull()
    expect(baselinePathOf({})).toBeNull()
  })
})

describe('query 选项组装（分叉/续聊开关）', () => {
  const base = {
    cwd: 'D:/w',
    permissionMode: 'default' as const,
    canUseTool: async () => ({ behavior: 'allow' as const }),
    settingSources: ['user']
  }

  it('默认不带 resume / fork，也不覆盖模型（沿用用户配置）', () => {
    const options = buildQueryOptions(base)
    expect(options.resume).toBeUndefined()
    expect(options.forkSession).toBeUndefined()
    expect(options.model).toBeUndefined()
    expect(options.settingSources).toEqual(['user'])
    // 只读工具默认放行：授权卡片只该出现在写/执行上
    expect(options.allowedTools).toContain('Read')
  })

  it('续聊：只带 resume', () => {
    const options = buildQueryOptions({ ...base, resumeSessionId: 'sess-1' })
    expect(options.resume).toBe('sess-1')
    expect(options.forkSession).toBeUndefined()
  })

  it('分叉：resume + forkSession=true（原会话不动）', () => {
    const options = buildQueryOptions({ ...base, resumeSessionId: 'sess-1', forkSession: true })
    expect(options.resume).toBe('sess-1')
    expect(options.forkSession).toBe(true)
  })

  it('从某条消息分叉：带上 resumeSessionAt', () => {
    const options = buildQueryOptions({ ...base, resumeSessionId: 's', forkSession: true, resumeSessionAt: 'uuid-9' })
    expect(options.resumeSessionAt).toBe('uuid-9')
  })

  it('model 为 default 时不传（避免覆盖 CLI 自身配置）；思考强度照传', () => {
    const options = buildQueryOptions({ ...base, modelId: 'default', thinkingEffort: 'high' })
    expect(options.model).toBeUndefined()
    expect(options.effort).toBe('high')
  })

  it('检查点默认开启（回退功能的前提）', () => {
    expect(buildQueryOptions(base).enableFileCheckpointing).toBe(true)
  })

  it('一次性任务关掉全部内置工具（tools: []），普通会话不带该字段', () => {
    // 抽取提示词下模型偶尔会先想着写文件 / 跑命令；一次性任务没人权限卡片可点，只能关掉工具
    expect(buildQueryOptions({ ...base, disableTools: true }).tools).toEqual([])
    expect(buildQueryOptions(base).tools).toBeUndefined()
  })
})

describe('界面档位 → SDK 授权模式', () => {
  it('四档映射与产品承诺一致', () => {
    expect(toSdkPermissionMode('manual')).toBe('default')
    expect(toSdkPermissionMode('plan')).toBe('plan')
    expect(toSdkPermissionMode('edit')).toBe('acceptEdits')
    // auto 用 acceptEdits 而不是 bypassPermissions：后者会跳过 canUseTool，连危险命令都不问人
    expect(toSdkPermissionMode('auto')).toBe('acceptEdits')
    expect(toSdkPermissionMode(undefined)).toBe('default')
  })
})

describe('工具标题', () => {
  it('优先展示命令 / 路径这类人话', () => {
    expect(toolTitle('Bash', { command: 'npm test' })).toBe('npm test')
    expect(toolTitle('Edit', { file_path: 'D:/a/note.txt' })).toBe('D:/a/note.txt')
    expect(toolTitle('Read', null)).toBe('Read')
  })
})
