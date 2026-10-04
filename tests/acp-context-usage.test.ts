import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../apps/main/src/services/agent/types'
import { AcpClient } from '../apps/main/src/services/agent/acp'

/**
 * ACP 会话更新的翻译（回归：dsh 每轮发的 `usage_update`（上下文占用）直接被丢弃，
 * 状态栏的"上下文 N token"就只能显示文档体量的静态估算、永远不更新）。
 */
function makeClient(): { client: AcpClient; events: AgentEvent[] } {
  const events: AgentEvent[] = []
  const noopStream = { on: () => undefined, setEncoding: () => undefined }
  const noopChild = {
    stdin: { writable: true, write: () => true },
    stdout: noopStream,
    stderr: noopStream,
    on: () => undefined,
    kill: () => true,
    pid: 1
  }
  const client = new AcpClient({
    child: noopChild as never,
    onEvent: (event) => events.push(event),
    requestPermission: async () => null,
    readTextFile: async () => '',
    writeTextFile: async () => undefined,
    allowWrite: false
  })
  return { client, events }
}

/** 直接喂一条 session/update 通知（handleUpdate 是私有的，走 onData 的正规入口）。 */
function feedUpdate(client: AcpClient, update: Record<string, unknown>): void {
  const payload = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update } }) + '\n'
  ;(client as unknown as { onData: (chunk: string) => void }).onData(payload)
}

describe('ACP usage_update → context-usage 事件', () => {
  it('used/size 都有 → 原样转发（四舍五入到整数）', () => {
    const { client, events } = makeClient()
    feedUpdate(client, { sessionUpdate: 'usage_update', used: 11578.4, size: 262144 })
    expect(events).toEqual([{ type: 'context-usage', used: 11578, size: 262144 }])
  })

  it('size 缺省或非法（-1 / 非数字）→ size 置 null，used 照报', () => {
    const { client, events } = makeClient()
    feedUpdate(client, { sessionUpdate: 'usage_update', used: 2048 })
    feedUpdate(client, { sessionUpdate: 'usage_update', used: 3000, size: -1 })
    feedUpdate(client, { sessionUpdate: 'usage_update', used: 4000, size: 'big' })
    expect(events).toEqual([
      { type: 'context-usage', used: 2048, size: null },
      { type: 'context-usage', used: 3000, size: null },
      { type: 'context-usage', used: 4000, size: null }
    ])
  })

  it('used 无效（0 / 负数 / 缺失）→ 不发事件（别的更新照旧走"未消费"日志路径）', () => {
    const { client, events } = makeClient()
    feedUpdate(client, { sessionUpdate: 'usage_update', used: 0 })
    feedUpdate(client, { sessionUpdate: 'usage_update', used: -5 })
    feedUpdate(client, { sessionUpdate: 'usage_update' })
    expect(events).toEqual([])
  })

  it('其它未消费的更新仍然只留日志、不发事件', () => {
    const { client, events } = makeClient()
    feedUpdate(client, { sessionUpdate: 'something_new', foo: 1 })
    expect(events).toEqual([])
  })
})
