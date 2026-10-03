import { describe, expect, it } from 'vitest'
import { AgentRuntime } from '../apps/main/src/services/agent/runtime'
import type { AgentEvent } from '../apps/main/src/services/agent/types'

/**
 * `runOnce`（一次性任务：关系图 Map/Reduce 走的就是它）的回合边界。
 *
 * 回归背景：SDK 通道是流式输入模式 —— `handle.prompt()` 只把消息投进流里就返回，
 * 真正的结束要等 `result` 翻成的 `done` 事件。早先的实现是「等 prompt 返回，再补等 1.5 秒」，
 * 于是 CLI 子进程还在初始化（实测 >2.8 秒）时就把会话释放了，收集到的文本永远是空的，
 * 表现为「关系图生成失败：未找到合法 JSON」。
 *
 * 这里用一个"举手就到、正文后到"的假会话复刻 SDK 的时序，钉住这个契约。
 */
class FakeSdkLikeRuntime extends AgentRuntime {
  /** 正文与结束事件相对 prompt 的延迟（毫秒） */
  constructor(
    private readonly textDelayMs: number,
    private readonly doneDelayMs: number,
    private readonly text = '{"entities":[]}',
    private readonly neverDone = false
  ) {
    super()
  }

  private deliver(sessionId: string, event: AgentEvent): void {
    ;(this as unknown as { emit: (id: string, event: AgentEvent) => void }).emit(sessionId, event)
  }

  override async createSession(request: { agentId: string; contextMode?: string }) {
    const sessionId = 'sess_fake'
    const handle = {
      prompt: async (): Promise<void> => {
        // 复刻 SDK：prompt 立刻返回，正文与 done 之后才异步到达
        setTimeout(() => this.deliver(sessionId, { type: 'text-delta', text: this.text }), this.textDelayMs)
        if (!this.neverDone) {
          setTimeout(() => this.deliver(sessionId, { type: 'done', stopReason: 'end_turn' }), this.doneDelayMs)
        }
      },
      cancel: async (): Promise<void> => undefined,
      dispose: async (): Promise<void> => undefined
    }
    const session = {
      sessionId,
      agentId: request.agentId,
      capability: { id: request.agentId },
      handle,
      contextMode: request.contextMode ?? 'fulltext',
      configOptions: [],
      createdAt: Date.now(),
      permissionMode: 'manual',
      workspaceDir: 'C:/w',
      canWrite: false,
      canExecute: false,
      sdk: null,
      persistedRules: []
    }
    ;(this as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, session)
    return { sessionId, capability: session.capability, configOptions: [], workspaceDir: 'C:/w' }
  }
}

describe('runOnce 的回合边界', () => {
  it('等的是回合结束（SDK 的 prompt 会立刻返回），不是固定 1.5 秒回收窗口', async () => {
    // 正文 1.55 秒才到、结束在 1.65 秒 —— 旧实现（1.5 秒硬回收）会拿到空文本
    const runtime = new FakeSdkLikeRuntime(1550, 1650)
    const started = Date.now()
    const result = await runtime.runOnce({ agentId: 'fake', prompt: '抽取' })
    expect(result.text).toBe('{"entities":[]}')
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500)
  })

  it('超时中断：以超时错误拒绝，而不是静默返回空文本', async () => {
    const runtime = new FakeSdkLikeRuntime(50, 0, '晚到的正文', true)
    await expect(runtime.runOnce({ agentId: 'fake', prompt: '抽取', timeoutMs: 300 })).rejects.toThrow('分块请求超时')
  })
})
