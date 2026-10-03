/** ACP 会话实现：进程 + 协议握手 + 提示词流。 */
import { logMain } from '../../util/ipc'
import { AcpClient } from './acp'
import { describeConfigValue, encodeConfigValue } from './config-value'
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
      // dsh 这类 harness 的模型密钥从环境变量读（DEEPSEEK_API_KEY），少了它握手就会失败
      env: create.options.env,
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
    /**
     * 续聊优先：给了远端会话 id 就先试 `session/resume`（dsh 0.2+ 支持）——
     * 失败（Agent 不支持 / id 过期 / 工作目录对不上）时**回落新建**并留痕，
     * 不让"续聊"变成"这个 Agent 用不了"。
     */
    let resumed = false
    if (create.options.resumeSessionId) {
      try {
        const result = await client.resumeSession(create.options.resumeSessionId, create.options.cwd)
        session.remoteId = result.sessionId
        session.configOptions = (result.configOptions ?? []) as ConfigOption[]
        resumed = true
        logMain('info', 'acp', '已续聊远端会话：' + result.sessionId)
      } catch (error) {
        logMain('warn', 'acp', '续聊失败，改为新建会话：' + String(error))
      }
    }
    if (!session.remoteId) {
      const result = await client.newSession(create.options.cwd)
      session.remoteId = result.sessionId
      session.configOptions = (result.configOptions ?? []) as ConfigOption[]
    }
    // 让界面拿得到远端会话 id（续聊要用它；SDK / app-server 通道早就在发这个事件）
    create.onEvent({ type: 'session', remoteSessionId: session.remoteId, resumed })
    if (session.configOptions.length > 0) {
      /**
       * 这里曾经发一条 `plan` 事件把配置项"顶"给界面 —— 但渲染进程根本不消费 `plan`，
       * 等于白发一次。真实的配置项改由 `runtime.createSession` 的返回值下发（那是界面读的地方）。
       * 只留一行日志，方便排查"模型/思考强度为什么是这一档"。
       */
      logMain(
        'info',
        'acp',
        '会话配置项=' +
          session.configOptions
            .map((option) => option.id + ':' + describeConfigValue(option.currentValue))
            .join(', ')
      )
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
    const option = this.findOption(category)
    if (!option || !this.remoteId) return
    /**
     * 取值要按**该选项自己的形态**编码：dsh 的 `model` 是 `[provider, model]` 路由，
     * 只认这条 JSON 的字符串（裸模型名会被回 `unknown model option`，然后被客户端吞掉）。
     */
    const next = await this.client.setConfigOption(this.remoteId, option.id, encodeConfigValue(option, value))
    if (next) this.configOptions = next
  }

  /**
   * 找配置项。**按 id 或 category 都认**，并且对思考强度补一个别名：
   * ACP 规范里"思考强度"的 category 是 `thought_level`，但 DSH 这一档的 id 叫
   * `reasoning_effort` —— 只按 category 匹配时，它一旦不自报 `thought_level`，
   * 用户选的档位就会被静默丢掉（看起来像"改了没用"）。
   */
  private findOption(category: string): ConfigOption | undefined {
    const aliases = category === 'thought_level' ? ['reasoning_effort'] : []
    return this.configOptions.find(
      (item) => item.category === category || item.id === category || aliases.includes(item.id)
    )
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
    // 先请 Agent 自己收敛（会话级 close：drain 更新、落盘、释放该会话的子代理），
    // 再关连接、杀进程 —— 不关的话持久化会话可能停在半截，续聊时就少一轮上下文。
    if (this.remoteId) {
      await this.client.closeSession(this.remoteId).catch((error) => {
        logMain('debug', 'acp', '关闭会话失败（忽略）：' + String(error))
      })
    }
    this.client.dispose()
    killTree(this.child)
  }

  async setConfigOption(optionId: string, value: string | boolean): Promise<void> {
    if (!this.remoteId) return
    const option = this.configOptions.find((item) => item.id === optionId)
    const next = await this.client.setConfigOption(
      this.remoteId,
      optionId,
      option ? encodeConfigValue(option, value) : value
    )
    if (next) this.configOptions = next
  }
}
