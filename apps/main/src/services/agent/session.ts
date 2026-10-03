/** ACP 会话实现：进程 + 协议握手 + 提示词流。 */
import { logMain } from '../../util/ipc'
import { AcpClient } from './acp'
import { killTree, spawnAgent } from './exec'
import type { AgentEvent, AgentSessionHandle, ConfigOption, PromptInput, SessionOptions } from './types'

export interface AcpSessionCreateOptions {
  /** 由运行时预先生成的会话 id，保证权限往返能关联到正确会话 */
  sessionId: string
  executable: string
  args: string[]
  options: SessionOptions
  onEvent: (event: AgentEvent) => void
  allowWrite: boolean
  requestPermission: (detail: import('./types').PermissionDetail) => Promise<string | null>
  readTextFile: (path: string, line?: number, limit?: number) => Promise<string>
  writeTextFile: (path: string, content: string) => Promise<void>
}

export class AcpSession implements AgentSessionHandle {
  readonly id: string
  private remoteId: string | null = null
  private configOptions: ConfigOption[] = []
  private disposed = false

  private constructor(
    id: string,
    private readonly client: AcpClient,
    private readonly child: ReturnType<typeof spawnAgent>,
    private readonly onEvent: (event: AgentEvent) => void
  ) {
    this.id = id
  }

  static async create(create: AcpSessionCreateOptions): Promise<AcpSession> {
    const child = spawnAgent(create.executable, create.args, {
      cwd: create.options.cwd,
      timeoutMs: 0
    })
    const client = new AcpClient({
      child,
      onEvent: create.onEvent,
      requestPermission: create.requestPermission,
      // readTextFile / writeTextFile 由运行时统一做白名单校验
      readTextFile: create.readTextFile,
      writeTextFile: create.writeTextFile,
      allowWrite: create.allowWrite,
      timeoutMs: 10 * 60 * 1000
    })
    const session = new AcpSession(create.sessionId, client, child, create.onEvent)
    const init = await client.initialize({
      fs: { readTextFile: true, writeTextFile: create.allowWrite },
      terminal: false
    })
    logMain('info', 'acp', 'Agent 握手完成：' + JSON.stringify(init).slice(0, 400))
    const result = await client.newSession(create.options.cwd)
    session.remoteId = result.sessionId
    session.configOptions = (result.configOptions ?? []) as ConfigOption[]
    if (session.configOptions.length > 0) {
      create.onEvent({
        type: 'plan',
        entries: session.configOptions.map((option) => ({
          content: '配置项：' + option.name + ' (' + option.category + ')',
          status: String(option.currentValue ?? '')
        }))
      })
    }
    // 应用用户选择的模型与思考强度
    if (create.options.modelId) await session.applyConfig('model', create.options.modelId)
    if (create.options.thinkingEffort) await session.applyConfig('thought_level', create.options.thinkingEffort)
    return session
  }

  get remoteSessionId(): string | null {
    return this.remoteId
  }

  get options(): ConfigOption[] {
    return this.configOptions
  }

  private async applyConfig(category: string, value: string): Promise<void> {
    const option = this.configOptions.find((item) => item.category === category || item.id === category)
    if (!option || !this.remoteId) return
    const next = await this.client.setConfigOption(this.remoteId, option.id, value)
    if (next) this.configOptions = next
  }

  async prompt(input: PromptInput): Promise<void> {
    if (this.disposed) throw new Error('会话已关闭')
    if (!this.remoteId) throw new Error('会话尚未建立')
    if (input.modelId) await this.applyConfig('model', input.modelId)
    if (input.thinkingEffort) await this.applyConfig('thought_level', input.thinkingEffort)
    const text = input.systemContext ? input.systemContext + '\n\n' + input.text : input.text
    try {
      const result = await this.client.prompt(this.remoteId, text)
      this.onEvent({ type: 'done', stopReason: (result as { stopReason?: string })?.stopReason ?? 'end_turn' })
    } catch (error) {
      if (this.disposed) return
      this.onEvent({ type: 'error', message: error instanceof Error ? error.message : String(error), retryable: true })
    }
  }

  async cancel(): Promise<void> {
    if (this.remoteId) this.client.cancel(this.remoteId)
    // 给 Agent 一点时间优雅收尾，超时后强杀
    setTimeout(() => killTree(this.child), 2500)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.client.dispose()
    killTree(this.child)
  }

  async setConfigOption(optionId: string, value: string | boolean): Promise<void> {
    if (!this.remoteId) return
    const next = await this.client.setConfigOption(this.remoteId, optionId, value)
    if (next) this.configOptions = next
  }
}
