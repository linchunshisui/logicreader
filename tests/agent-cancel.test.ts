import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * 停止按钮的取消链路（回归：停止按钮失效 —— 点了停止，回合还在跑、界面还在流）。
 *
 * 旧实现的三个断点：
 *  1. ACP 的 cancel 发出 `session/cancel` 通知后**什么都不等**，2500ms 后无条件杀进程树 ——
 *     子进程承载全部会话与整条连接，"停止这一轮"被升级成"会话报废"；
 *     且 Agent 优雅停了也照样被杀，下一句提问打在死句柄上（"停止之后 Agent 就坏了"）；
 *  2. Agent 不配合取消时（思考空转拖着不回 `session/prompt` 的结果），挂起请求一直挂着
 *     到 10 分钟超时 —— 界面的流式状态只能干等，用户看就是"停止没反应"；
 *  3. 强杀后死句柄还留在运行时会话表里。
 */

const killTreeMock = vi.fn()
vi.mock('../apps/main/src/services/agent/exec', async (importOriginal) => {
  const original = await importOriginal<typeof import('../apps/main/src/services/agent/exec')>()
  return { ...original, killTree: (...args: unknown[]) => killTreeMock(...args) }
})

import { AcpClient } from '../apps/main/src/services/agent/acp'
import { AcpSession } from '../apps/main/src/services/agent/session'

function makeClient(): AcpClient {
  const noopStream = { on: () => undefined, setEncoding: () => undefined }
  const noopChild = {
    stdin: { writable: true, write: () => true },
    stdout: noopStream,
    stderr: noopStream,
    on: () => undefined,
    kill: () => true,
    pid: 12345
  }
  return new AcpClient({
    child: noopChild as never,
    onEvent: () => undefined,
    requestPermission: async () => null,
    readTextFile: async () => '',
    writeTextFile: async () => undefined,
    allowWrite: false
  })
}

interface Fixture {
  session: AcpSession
  /** 模拟 Agent 的回合收尾（prompt() 正常/失败路径都会发它） */
  settle: (value: boolean) => void
  cancelCalls: () => number
}

function makeSession(): Fixture {
  const client = makeClient()
  let cancelCalls = 0
  vi.spyOn(client, 'cancel').mockImplementation(() => {
    cancelCalls += 1
  })
  const session = new AcpSession('sess_test', client, {} as never, () => undefined)
  // remoteId 是私有字段（create() 里握手后才设置）：测试直接注入，模拟"会话已建立、回合进行中"
  ;(session as unknown as { remoteId: string }).remoteId = 'remote-1'
  const settleRef = session as unknown as { settlePrompt: ((value: boolean) => void) | null }
  return {
    session,
    settle: (value: boolean) => settleRef.settlePrompt?.(value),
    cancelCalls: () => cancelCalls
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  killTreeMock.mockClear()
})

describe('AcpClient.forceFailPending', () => {
  it('把所有挂起请求按取消错误拒绝（停止不再等 10 分钟超时）', async () => {
    const client = makeClient()
    const first = client.request('session/prompt', {}).catch((error: Error) => error.message)
    const second = client.request('session/set_config_option', {}).catch((error: Error) => error.message)
    client.forceFailPending('强制中断')
    expect(await first).toBe('强制中断')
    expect(await second).toBe('强制中断')
  })
})

describe('AcpSession.cancel 的三步降级', () => {
  it('Agent 及时收尾 → 不杀进程、连接仍可用', async () => {
    const fixture = makeSession()
    const promise = fixture.session.cancel()
    expect(fixture.cancelCalls()).toBe(1)
    // Agent 停了：收尾信号在 3 秒等待窗口内到达
    fixture.settle(true)
    await vi.advanceTimersByTimeAsync(3000)
    await promise
    expect(killTreeMock).not.toHaveBeenCalled()
    expect(fixture.session.isUsable()).toBe(true)
  })

  it('Agent 拖着不停 → 3 秒后强制收尾挂起请求；再 2 秒仍不收敛才杀进程', async () => {
    const fixture = makeSession()
    const promise = fixture.session.cancel()
    // 3 秒：未收尾 → 强制收尾（把挂起的 session/prompt 拒绝掉，UI 状态立刻落地）
    await vi.advanceTimersByTimeAsync(3000)
    // 再 2 秒：仍未收敛 → 杀进程树，句柄不可复用
    await vi.advanceTimersByTimeAsync(2000)
    await promise
    expect(fixture.cancelCalls()).toBe(1)
    expect(killTreeMock).toHaveBeenCalledTimes(1)
    expect(fixture.session.isUsable()).toBe(false)
  })

  it('强制收尾路径上 Agent 恰好退了 → 不杀进程（第二次等待窗口内收尾）', async () => {
    const fixture = makeSession()
    const promise = fixture.session.cancel()
    // 3 秒窗口空过（强制收尾），但 2 秒兜底窗口内 Agent 退了
    await vi.advanceTimersByTimeAsync(3000)
    fixture.settle(false)
    await vi.advanceTimersByTimeAsync(2000)
    await promise
    expect(killTreeMock).not.toHaveBeenCalled()
    expect(fixture.session.isUsable()).toBe(true)
  })
})
