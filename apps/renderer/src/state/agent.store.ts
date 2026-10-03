import { create } from 'zustand'
import {
  createId,
  DEFAULT_PERMISSION_MODE,
  normalizePermissionMode,
  permissionModeReminder,
  looksLikePlan,
  decidePermission,
  classifyPermission,
  type AgentCapabilityView,
  type AgentConfigOption,
  type AgentEventPayload,
  type AgentRegistrationView,
  type ContextMode,
  type AgentModelView,
  type AgentSessionInfoView,
  type WorkspaceFileView,
  type PermissionMode,
  type SlashCommandView,
  type ToolDiffView
} from '@logicreader/shared'
import i18n from '../i18n'
import { api } from '../lib/api'
import { notify } from './notifications.store'
import { useTabs } from './tabs.store'
import { useDocuments } from './documents.store'

export interface ToolCallView {
  id: string
  name: string
  title: string
  input: unknown
  output?: unknown
  isError?: boolean
  state: 'running' | 'done' | 'error'
  /** 该调用来自哪个子代理（Task 的 tool_use_id）；主线程为空 */
  parentId?: string
  /** 这次调用改动文件的差异（内联 diff 审阅用；由 PreToolUse 基线算出来） */
  diff?: ToolDiffView
}

export type { ToolDiffView } from '@logicreader/shared'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  thinking: string
  tools: ToolCallView[]
  usage?: { inputTokens: number; outputTokens: number }
  createdAt: number
  status: 'streaming' | 'done' | 'error' | 'interrupted'
  error?: string
  /** 本条消息引用的锚点（用于定位角标） */
  anchorIds?: string[]
  locationLabel?: string
}

export interface PermissionRequest {
  requestId: string
  sessionId: string
  title: string
  kind: string
  rawInput: unknown
  options: { optionId: string; name: string; kind: string }[]
}

interface AgentState {
  agents: AgentRegistrationView[]
  selectedAgentId: string | null
  modelId: string | null
  thinkingEffort: string | null
  configOptions: AgentConfigOption[]
  contextMode: ContextMode
  /** 授权模式：写入/命令逐次询问，还是按策略自动放行（对应界面上那颗模式按钮） */
  permissionMode: PermissionMode
  /** 扩展档：Agent 声明了更高思考强度档位时才可用 */
  ultracode: boolean
  sessionId: string | null
  conversationId: string | null
  /**
   * 当前绑定的文档；`null` = 全局会话（没有打开任何文档）。
   * 初值故意用 `undefined`：`bindDocument(null)` 的守卫是"值没变就跳过"，
   * 若初值也是 `null`，首次绑定全局会话会被直接跳过 —— 快照里的授权模式/模型/草稿就永远恢复不了
   * （本轮实测踩到：seeded 的 auto 档启动后又变回 manual）。
   */
  docId: string | null | undefined
  messages: ChatMessage[]
  streaming: boolean
  draft: string
  permissions: PermissionRequest[]
  /** 自动放行/自动拒绝留下的痕（一条消息一条），让"我什么都没干"不再是唯一反馈 */
  permissionNotes: { id: string; messageId: string; text: string }[]
  /** 文件检查点 id（用户消息 uuid，按时间顺序），用于把改动回退到某一步之前 */
  checkpoints: string[]
  /**
   * 计划模式下待批准的计划。
   * 两个来源：① `ExitPlanMode` 到来时主进程下发的 plan-review（含模型写的方案文件路径）；
   * ② 计划档下本轮回答结束时的兜底（模型有时不调 ExitPlanMode，但同样是在给方案）。
   * 都要能批准/拒绝，不能让"批不了"取决于模型调不调那个工具。
   */
  pendingPlan: { messageId: string; plan: string; filePath: string | null } | null
  /**
   * **会话给出的真实模型清单**（`supportedModels()` 的解析结果）。
   *
   * 与 `capability.models` 分开存，是因为后者会被 `refreshAgents()`（探测/agent 列表变化）
   * 用兜底清单覆盖回去 —— 那种覆盖是静默的，界面于是又变回"opus/sonnet/haiku"这种别名，
   * 用户换了 API 就再也看不出实际在跑哪个模型（本轮实测踩到）。
   * 这里存的是"CLI 亲口说的"那份，刷新时机只有会话建立/初始化完成，不会被探测冲掉。
   */
  resolvedModels: AgentModelView[]
  /** 模型清单被真实数据替换过的次数（供冒烟/调试判断"到底刷新了没有"）。 */
  modelsRevision: number
  /**
   * 本会话**实际在跑的模型**（`system/init.model`，别名已由 CLI 解析）。
   * 换 API 之后别名与真实模型不是一回事：用户选 sonnet、跑的是 GLM-5.3-Flash —— 这里存后者。
   */
  activeModel: string | null
  /** 会话可用的斜杠命令（CLI 下发，含用户技能） */
  commands: SlashCommandView[]
  /** 历史会话（CLI 持久化记录，与 VS Code 扩展共用） */
  history: AgentSessionInfoView[]
  /** 下一次建会话时要 resume 的远端会话 id；null 表示开新会话 */
  resumeSessionId: string | null
  /**
   * 是否已经从会话快照恢复过本项目/全局的 Agent 状态。
   * 用它挡住 `refreshAgents` 的"选默认 Agent"逻辑：那条路径会把快照里的档位覆盖回默认值
   * （本轮实测：seeded 的 edit 档被覆盖成 manual，写文件于是被按手动档挡下）。
   */
  hydratedFromSnapshot: boolean
  initialized: boolean
  lastError: string | null

  init: () => Promise<void>
  refreshAgents: (force?: boolean) => Promise<void>
  selectAgent: (agentId: string) => Promise<void>
  refreshModels: (sessionId: string) => Promise<void>
  /**
   * 没有会话时也把真实模型清单拉回来（起一个临时进程问完就关）。
   * 界面启动即可见"角色别名 → 真实模型"，不必先发一条消息。
   */
  ensureModels: () => Promise<void>
  refreshCommands: (sessionId: string) => Promise<void>
  refreshHistory: (dir: string | null) => Promise<void>
  /** 给历史会话改名（本地保存，最高优先级） */
  renameHistorySession: (sessionId: string, title: string) => Promise<void>
  /** 让 Agent 用一句话给这条历史会话"总结命名"（续聊它再问一次，很小的调用） */
  nameHistorySession: (sessionId: string, firstPrompt?: string | null) => Promise<string | null>
  /** "@ 文件引用"的候选查询（主进程有缓存，可以随输入频繁调） */
  queryFiles: (dir: string | null, query: string) => Promise<WorkspaceFileView[]>
  /** 选一个历史会话续聊：关掉当前会话，下一次提问带上 resume */
  resumeSession: (remoteSessionId: string) => Promise<void>
  /** 从某个历史会话分叉：复制它的历史开新会话，原会话不动 */
  forkSession: (remoteSessionId: string) => Promise<void>
  setModel: (modelId: string | null) => void
  setThinkingEffort: (effort: string | null) => void
  setContextMode: (mode: ContextMode) => void
  setPermissionMode: (mode: PermissionMode) => Promise<void>
  setUltracode: (value: boolean) => void
  bindDocument: (docId: string | null) => Promise<void>
  setDraft: (value: string) => void
  newSession: () => Promise<void>
  send: (
    text: string,
    options?: {
      systemContext?: string
      locationLabel?: string
      anchorIds?: string[]
      /** 分叉这次提问要接上的历史会话 */
      forkFrom?: string
    }
  ) => Promise<void>
  stop: () => Promise<void>
  respondPermission: (requestId: string, optionId: string | null) => Promise<void>
  /** 批准当前计划：放行 ExitPlanMode，并把档位切到"编辑自动"（与 VS Code 的批准语义一致） */
  approvePlan: () => Promise<void>
  /** 拒绝计划：拦下 ExitPlanMode，留在计划模式继续改方案 */
  rejectPlan: () => Promise<void>
  /** 回退文件到某个检查点之前（dryRun=true 只预演） */
  rewindFiles: (userMessageId: string, dryRun?: boolean) => Promise<unknown>
  /** 逐块回退某次改动（VS Code 的"逐 hunk 接受/拒绝"等价物） */
  revertHunks: (toolUseId: string, indices: number[]) => Promise<{ ok: boolean; conflict?: string }>
  clear: () => void
}

const globalConversationKey = 'global'

/** 只由冒烟脚本设置：强制本轮使用指定 Agent（不写入任何持久状态）。 */
let smokeAgentId: string | null = null

function currentCapability(agents: AgentRegistrationView[], agentId: string | null): AgentCapabilityView | null {
  if (!agentId) return null
  return agents.find((agent) => agent.id === agentId)?.capability ?? null
}

export const useAgent = create<AgentState>((set, get) => ({
  agents: [],
  selectedAgentId: null,
  modelId: null,
  thinkingEffort: null,
  configOptions: [],
  contextMode: 'fulltext',
  permissionMode: DEFAULT_PERMISSION_MODE,
  ultracode: false,
  sessionId: null,
  conversationId: null,
  docId: undefined,
  messages: [],
  streaming: false,
  draft: '',
  permissions: [],
  permissionNotes: [],
  checkpoints: [],
  pendingPlan: null,
  commands: [],
  history: [],
  resumeSessionId: null,
  resolvedModels: [],
  modelsRevision: 0,
  activeModel: null,
  hydratedFromSnapshot: false,
  initialized: false,
  lastError: null,

  init: async () => {
    if (get().initialized) return
    set({ initialized: true })
    api.agent.onEvent((payload) => handleEvent(payload, set, get))
    api.agent.onChanged(() => {
      void get().refreshAgents(false)
    })
    // 冒烟自动化：主进程可要求渲染进程发起一次提问
    api.app.onMenuCommand((payload) => {
      const commandId = (payload as { commandId?: string } | undefined)?.commandId
      if (commandId !== 'smoke.agentPrompt') return
      const args = (payload as { args?: { text?: string; agentId?: string } } | undefined)?.args
      const text = args?.text ?? '请用一句话介绍这份文档的主题。'
      smokeAgentId = args?.agentId ?? null
      void get()
        .refreshAgents(false)
        .then(() => get().send(text))
    })
    await get().refreshAgents(false)
  },

  refreshAgents: async (force = false) => {
    try {
      let agents = await api.agent.list()
      // 自愈：注册表里有真实 Agent 但都还没有能力信息时，主动探测一次
      const hasAvailable = agents.some((agent) => agent.capability?.available)
      const hasUnprobed = agents.some((agent) => agent.id !== 'mock' && !agent.capability)
      if (!hasAvailable && hasUnprobed) {
        await api.agent.probeAll(false).catch(() => undefined)
        agents = await api.agent.list()
      }
      set({ agents })
      const available = agents.filter((agent) => agent.capability?.available)
      const current = get().selectedAgentId
      /**
       * 快照已经给过档位/模型时**不要**再走"选默认 Agent"这条会把它们覆盖掉的路径。
       * 只补一个 Agent 选择，其余状态保持快照里的值。
       */
      if (get().hydratedFromSnapshot && current && available.some((agent) => agent.id === current)) {
        const capability = currentCapability(agents, current)
        if (capability && get().configOptions.length === 0 && (capability.configOptions?.length ?? 0) > 0) {
          set({ configOptions: capability.configOptions })
        }
        return
      }
      if (!current || !available.some((agent) => agent.id === current)) {
        // 优先选择真实 Agent，其次 Mock；都没有时清空选择
        const preferred =
          available.find((agent) => agent.id !== 'mock' && agent.capability?.available) ??
          available[0] ??
          null
        if (preferred) {
          const capability = preferred.capability
          set({
            selectedAgentId: preferred.id,
            modelId: capability?.defaultModel ?? null,
            thinkingEffort: capability?.defaultThoughtLevel ?? null,
            configOptions: capability?.configOptions ?? [],
            sessionId: null
          })
          await persistAgentState(get)
        } else {
          set({ selectedAgentId: null, modelId: null, thinkingEffort: null, configOptions: [] })
        }
      } else {
        // 已选中的 Agent 可能被重新探测（模型列表变化），同步一次配置项
        const capability = currentCapability(agents, current)
        if (capability && get().configOptions.length === 0 && (capability.configOptions?.length ?? 0) > 0) {
          set({ configOptions: capability.configOptions })
        }
      }
      if (force) {
        const probed = await api.agent.probeAll(true)
        set({ agents: await api.agent.list() })
        void probed
      }
    } catch (error) {
      set({ lastError: error instanceof Error ? error.message : String(error) })
    }
  },

  selectAgent: async (agentId) => {
    const state = get()
    const capability = currentCapability(state.agents, agentId)
    /**
     * 换 Agent = **换通道**（Claude 走官方 SDK 子进程，Codex 走官方 app-server 子进程），
     * 两条通道的会话不可互换，所以：
     *  1. 旧会话必须先 `sessionDispose` —— 两个通道都是**常驻**子进程，只把 sessionId 置空会留下
     *     一个永远不走的进程（这条以前没暴露，是因为 selectAgent 只在启动时自动选一次）；
     *  2. 新 Agent 手里没有旧会话的上下文，界面上的会话态必须一起清干净 ——
     *     否则用户会看到"上一轮 Claude 的对话"配上"这一轮 Codex 从零开始"的答非所问。
     *     清掉的只是**面板里的这一份**：两边的会话记录都还在各自的持久化里（历史会话面板能续聊）。
     */
    const changed = state.selectedAgentId !== null && state.selectedAgentId !== agentId
    if (changed && state.sessionId) {
      await api.agent.sessionDispose(state.sessionId).catch(() => undefined)
    }
    set({
      selectedAgentId: agentId,
      modelId: capability?.defaultModel ?? null,
      thinkingEffort: capability?.defaultThoughtLevel ?? null,
      configOptions: capability?.configOptions ?? [],
      sessionId: null,
      ...(changed
        ? {
            conversationId: null,
            resumeSessionId: null,
            messages: [],
            streaming: false,
            permissions: [],
            permissionNotes: [],
            checkpoints: [],
            pendingPlan: null,
            activeModel: null,
            // 模型清单与命令清单都是**按通道**来的：不清掉会把上一条通道的模型显示在新通道上
            resolvedModels: [],
            commands: [],
            history: [],
            lastError: null
          }
        : {})
    })
    await persistAgentState(get)
    // 新通道的真实模型清单（Claude = supportedModels，Codex = model/list）
    if (changed) void get().ensureModels()
  },

  /**
   * 用会话给出的真实模型清单覆盖能力里的兜底清单。
   *
   * 只在拿到非空清单时才覆盖：SDK 没起来 / 不支持查询时保持原样，避免把选择器清空。
   * 会重试几次：会话刚建立时 CLI 可能还没准备好应答 `supportedModels()`
   * （本轮实测：紧跟 sessionCreate 的那次查询返回空，界面上就一直显示兜底清单）。
   */
  refreshModels: async (sessionId) => {
    try {
      let models: Awaited<ReturnType<typeof api.agent.models>> = []
      for (let attempt = 0; attempt < 5; attempt += 1) {
        models = await api.agent.models(sessionId).catch(() => [])
        if (models.length > 0) break
        await new Promise((resolve) => setTimeout(resolve, 400 + attempt * 300))
      }
      logDebug(
        '模型清单刷新：' +
          models.length +
          ' 条，带真实模型名 ' +
          models.filter((item) => item.resolvedModel).length +
          ' 条（sessionId=' +
          sessionId +
          '）原始首条=' +
          JSON.stringify(models[0] ?? null) +
          ' | selectedAgentId=' +
          String(get().selectedAgentId) +
          ' | capability=' +
          String(Boolean(get().agents.find((agent) => agent.id === get().selectedAgentId)?.capability))
      )
      if (models.length === 0) return
      const current = get().selectedAgentId
      if (!current) return
      const agents = get().agents.map((agent) =>
        agent.id === current && agent.capability
          ? { ...agent, capability: { ...agent.capability, models } }
          : agent
      )
      // 同时存一份"不会被探测覆盖"的清单（界面以它为准）
      set({ agents, resolvedModels: models, modelsRevision: get().modelsRevision + 1 })
      // 选中的模型不在新清单里时，落到第一个（否则选择器会显示成空白）
      const selected = get().modelId
      if (!selected || !models.some((model) => model.id === selected)) {
        set({ modelId: models[0].id })
      }
      void persistAgentState(get)
    } catch {
      /* 拿不到就保持兜底清单 */
    }
  },

  ensureModels: async () => {
    if (get().resolvedModels.length > 0) return
    const agentId = get().selectedAgentId
    if (!agentId) return
    try {
      const models = await api.agent.probeModels(agentId)
      if (models.length === 0) return
      set({ resolvedModels: models, modelsRevision: get().modelsRevision + 1 })
      const selected = get().modelId
      if (!selected || !models.some((model) => model.id === selected)) set({ modelId: models[0].id })
      logDebug('模型清单（探测）已就绪：' + models.length + ' 条，带真实模型名 ' + models.filter((m) => m.resolvedModel).length + ' 条')
    } catch {
      /* 探测失败就保持兜底清单 */
    }
  },

  /**
   * 拉取会话可用的斜杠命令。
   * 这些命令由 CLI 下发（含用户自己的技能），界面只做补全与展示 —— 不硬编码命令表，
   * 否则 CLI 一升级我们就会"少半截命令"。
   */
  refreshCommands: async (sessionId) => {
    try {
      const commands = await api.agent.commands(sessionId)
      set({ commands })
      logDebug('斜杠命令已刷新：' + commands.length + ' 条')
    } catch {
      /* 拿不到就保持空清单（输入 / 时不弹）*/
    }
  },

  /**
   * 拉历史会话列表。
   * 数据源是 CLI 自己持久化的会话记录 —— 用户也可以在 VS Code 里看到同一批会话。
   */
  refreshHistory: async (dir) => {
    try {
      // 带上当前选中的 Agent：历史会话按通道取（Codex = thread/list，其余 = CLI 会话记录）
      const history = await api.agent.history(dir, 30, get().selectedAgentId)
      set({ history })
      logDebug('历史会话已刷新：' + history.length + ' 条')
    } catch {
      set({ history: [] })
    }
  },

  /**
   * 历史会话的两个命名动作。两者都写进主进程的 `session_titles` 表（按 agent + 会话 id 存），
   * 之后再列历史时优先级最高 —— 这就是"直观明了地知道里面是什么"的落点。
   */
  renameHistorySession: async (sessionId, title) => {
    const agentId = get().selectedAgentId
    if (!agentId) return
    const text = title.trim()
    if (text.length === 0) return
    await api.agent.historyRename(agentId, sessionId, text).catch(() => undefined)
    /**
     * **就地更新这一行**，不重新拉整张列表：ACP 通道列一次会话要新起一个 Agent 进程
     * （实测十几秒），回车之后干等十几秒才看到名字变化，体验很差（而且用户会以为没生效）。
     * 真正的持久化已经写进 `session_titles`，下次列表刷新自然一致。
     */
    set({
      history: get().history.map((item) =>
        item.sessionId === sessionId ? { ...item, title: text, titleSource: 'stored' as const } : item
      )
    })
  },

  nameHistorySession: async (sessionId, firstPrompt) => {
    const agentId = get().selectedAgentId
    if (!agentId) return null
    const title = await api.agent.historyName(agentId, sessionId, firstPrompt ?? null).catch(() => null)
    if (title) {
      set({
        history: get().history.map((item) =>
          item.sessionId === sessionId ? { ...item, title, titleSource: 'stored' as const } : item
        )
      })
    }
    return title
  },

  queryFiles: async (dir, query) => {
    if (!dir) return []
    try {
      return await api.agent.files(dir, query, 12)
    } catch {
      return []
    }
  },

  resumeSession: async (remoteSessionId) => {
    const sessionId = get().sessionId
    set({ sessionId: null, resumeSessionId: remoteSessionId, permissions: [], streaming: false })
    if (sessionId) await api.agent.sessionDispose(sessionId).catch(() => undefined)
    logDebug('已选择续聊会话：' + remoteSessionId)
  },

  forkSession: async (remoteSessionId) => {
    const sessionId = get().sessionId
    set({ sessionId: null, permissions: [], streaming: false })
    if (sessionId) await api.agent.sessionDispose(sessionId).catch(() => undefined)
    /**
     * 分叉不能只设状态：它要**立刻**用一个新会话接上历史，
     * 所以这里直接发一句"继续"，由 send 带上 resume + forkSession。
     */
    await get().send('继续', { forkFrom: remoteSessionId })
  },

  setModel: (modelId) => {
    const capability = currentCapability(get().agents, get().selectedAgentId)
    const model = capability?.models.find((item) => item.id === modelId)
    const levels = model?.thoughtLevels ?? []
    const currentEffort = get().thinkingEffort
    const effortValid = levels.length === 0 || levels.some((level) => level.id === currentEffort)
    set({
      modelId,
      thinkingEffort: effortValid ? currentEffort : (model?.defaultThoughtLevel ?? levels[0]?.id ?? null)
    })
    void persistAgentState(get)
  },

  setThinkingEffort: (effort) => {
    set({ thinkingEffort: effort })
    void persistAgentState(get)
  },

  setContextMode: (mode) => {
    set({ contextMode: mode, sessionId: null })
    void persistAgentState(get)
  },

  /**
   * 切换授权模式。
   *
   * 必须**换会话**：写文件与执行命令的许可在会话创建时就通过 ACP 握手声明过了
   * （clientCapabilities.fs.writeTextFile），已建立的会话改不回来。
   * 实测形态就是"切到自动档却依然写不了文件"。对话记录保留，下一次提问用新会话。
   */
  setPermissionMode: async (mode) => {
    const next = normalizePermissionMode(mode)
    const previous = get().permissionMode
    if (next === previous) return
    const sessionId = get().sessionId
    set({ permissionMode: next, sessionId: null })
    if (sessionId) await api.agent.sessionDispose(sessionId).catch(() => undefined)
    await persistAgentState(get)
  },

  setUltracode: (value) => {
    set({ ultracode: value })
    void persistAgentState(get)
  },

  bindDocument: async (docId) => {
    if (get().docId === docId) return
    set({
      docId,
      messages: [],
      sessionId: null,
      conversationId: null,
      permissions: [],
      permissionNotes: [],
      checkpoints: [],
      pendingPlan: null,
      activeModel: null,
      resolvedModels: []
    })
    // 从会话快照恢复 Agent 状态（会话、模式、模型、草稿）
    try {
      const report = await api.session.load()
      const key = docId ?? globalConversationKey
      const saved = report?.snapshot.windows[0]?.agent?.[key]
      logDebug('恢复 Agent 快照 ' + key + '：' + (saved ? '命中（模式=' + String(saved.permissionMode) + '）' : '没有记录'))
      // 无论命中与否都算"水合过"：没命中就是默认值，也不该被选默认 Agent 的路径再改一次
      set({ hydratedFromSnapshot: true })
      if (saved) {
        set({
          conversationId: saved.conversationId,
          contextMode: (saved.contextMode as ContextMode) ?? 'fulltext',
          // 旧快照没有 permissionMode：回落到最保守的一档，绝不"继承"一个更宽的授权
          permissionMode: normalizePermissionMode(saved.permissionMode),
          ultracode: saved.ultracode === true,
          selectedAgentId: saved.agentId ?? get().selectedAgentId,
          modelId: saved.modelId ?? get().modelId,
          thinkingEffort: saved.thinkingEffort ?? get().thinkingEffort,
          draft: saved.draft ?? ''
        })
        if (saved.conversationId) await loadMessages(saved.conversationId, set)
      }
    } catch {
      /* 快照不可用时忽略 */
    }
  },

  setDraft: (value) => {
    set({ draft: value })
    void persistAgentState(get)
  },

  newSession: async () => {
    const sessionId = get().sessionId
    if (sessionId) await api.agent.sessionDispose(sessionId).catch(() => undefined)
    set({
      sessionId: null,
      conversationId: null,
      messages: [],
      permissions: [],
      permissionNotes: [],
      checkpoints: [],
      streaming: false
    })
    await persistAgentState(get)
  },

  send: async (text, options) => {
    const state = get()
    // 冒烟可用 LR_SMOKE_AGENT_ID 指定 Agent（例如 mock），结果与自动选择一致
    const agentId = smokeAgentId ?? state.selectedAgentId
    if (!agentId) {
      notify('未选择 Agent 工具', 'warning')
      return
    }
    const trimmed = text.trim()
    if (trimmed.length === 0) return

    // 计划模式不是"更宽松的权限"，而是给模型的硬约束：必须拼进这一轮的上下文
    const reminder = permissionModeReminder(state.permissionMode, currentLocale())
    const systemContext =
      reminder && options?.systemContext
        ? reminder + '\n\n' + options.systemContext
        : reminder ?? options?.systemContext

    const userMessage: ChatMessage = {
      id: createId('msg'),
      role: 'user',
      content: trimmed,
      thinking: '',
      tools: [],
      createdAt: Date.now(),
      status: 'done',
      locationLabel: options?.locationLabel,
      anchorIds: options?.anchorIds
    }
    const assistantMessage: ChatMessage = {
      id: createId('msg'),
      role: 'assistant',
      content: '',
      thinking: '',
      tools: [],
      createdAt: Date.now(),
      status: 'streaming'
    }
    set({ messages: [...state.messages, userMessage, assistantMessage], streaming: true, draft: '' })

    let sessionId = state.sessionId
    try {
      if (!sessionId) {
        // 让 Agent 的工作目录跟随当前文档，避免"看不到文档、什么也做不了"
        const { useDocuments } = await import('./documents.store')
        const model = state.docId ? useDocuments.getState().models[state.docId] ?? null : null
        const documentDir = model ? model.filePath.replace(/\\/g, '/').replace(/\/[^/]*$/, '') : null
        const created = await api.agent.sessionCreate({
          agentId,
          contextMode: state.contextMode,
          modelId: state.modelId,
          thinkingEffort: state.thinkingEffort,
          permissionMode: state.permissionMode,
          // 续聊：把用户选中的历史会话 id 传给 SDK 的 resume；分叉时同时带 forkSession
          resumeSessionId: options?.forkFrom ?? state.resumeSessionId,
          forkSession: Boolean(options?.forkFrom),
          documentDir
        })
        sessionId = created.sessionId
        set({ sessionId, resumeSessionId: null, configOptions: created.configOptions ?? [], selectedAgentId: agentId })
        // 拉一次真实模型清单（第三方代理下模型名是 GLM-5.3 / Kimi-K3 这类别名）
        void get().refreshModels(sessionId)
        // 斜杠命令同样由 CLI 下发（含用户技能），建立会话后就取一次
        void get().refreshCommands(sessionId)
      }
      const conversationId = state.conversationId ?? createId('conv')
      if (!state.conversationId) {
        set({ conversationId })
        await api.store.conversationUpsert({
          id: conversationId,
          docId: state.docId ?? globalConversationKey,
          agentId,
          mode: state.contextMode,
          title: trimmed.slice(0, 40),
          createdAt: Date.now(),
          updatedAt: Date.now()
        })
      }
      await api.store.messageAppend({
        id: userMessage.id,
        conversationId,
        role: 'user',
        content: trimmed,
        anchorIds: options?.anchorIds ?? [],
        createdAt: userMessage.createdAt
      })
      await persistAgentState(get)

      await api.agent.prompt(sessionId, {
        text: trimmed,
        systemContext,
        modelId: state.modelId,
        thinkingEffort: state.thinkingEffort
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateAssistant(set, get, (current) => ({ ...current, status: 'error', error: message }))
      set({ streaming: false })
      notify(message, 'error', { timeoutMs: 0 })
    }
  },

  stop: async () => {
    const sessionId = get().sessionId
    if (!sessionId) return
    await api.agent.cancel(sessionId).catch(() => undefined)
    set({ streaming: false })
  },

  rewindFiles: async (userMessageId, dryRun = false) => {
    const sessionId = get().sessionId
    if (!sessionId) throw new Error('还没有活动会话')
    return api.agent.rewind(sessionId, userMessageId, dryRun)
  },

  approvePlan: async () => {
    const request = get().permissions.find((item) => item.kind === 'plan')
    if (request) await get().respondPermission(request.requestId, 'allow_once')
    set({ pendingPlan: null })
    /**
     * 批准后切到"编辑自动"：与 VS Code 一致 —— 批准计划意味着"可以动手了"。
     * 改档会重建会话（写权限在握手时声明），这是已知且可接受的代价。
     */
    await get().setPermissionMode('edit')
  },

  rejectPlan: async () => {
    const request = get().permissions.find((item) => item.kind === 'plan')
    if (request) await get().respondPermission(request.requestId, 'reject_once')
    set({ pendingPlan: null })
  },

  revertHunks: async (toolUseId, indices) => {
    const sessionId = get().sessionId
    if (!sessionId) return { ok: false, conflict: '还没有活动会话' }
    return api.agent.revertHunks(sessionId, toolUseId, indices)
  },

  respondPermission: async (requestId, optionId) => {
    await api.agent.permissionRespond(requestId, optionId)
    set({ permissions: get().permissions.filter((item) => item.requestId !== requestId) })
  },

  clear: () => set({ messages: [], conversationId: null, sessionId: null })
}))

function handleEvent(
  payload: AgentEventPayload,
  set: (partial: Partial<AgentState>) => void,
  get: () => AgentState
): void {
  if (payload.sessionId !== get().sessionId) return
  switch (payload.type) {
    case 'text-delta':
      updateAssistant(set, get, (current) => ({ ...current, content: current.content + payload.text }))
      break
    case 'thinking':
      updateAssistant(set, get, (current) => ({ ...current, thinking: current.thinking + payload.text }))
      break
    case 'tool-call':
      updateAssistant(set, get, (current) => ({
        ...current,
        tools: [
          ...current.tools,
          {
            id: payload.id,
            name: payload.name,
            title: payload.title ?? payload.name,
            input: payload.input,
            state: 'running',
            parentId: payload.parentId
          }
        ]
      }))
      break
    case 'tool-result':
      updateAssistant(set, get, (current) => ({
        ...current,
        tools: current.tools.map((tool) =>
          tool.id === payload.id
            ? { ...tool, output: payload.output, isError: payload.isError, state: payload.isError ? 'error' : 'done' }
            : tool
        )
      }))
      break
    case 'usage':
      updateAssistant(set, get, (current) => ({
        ...current,
        usage: { inputTokens: payload.inputTokens, outputTokens: payload.outputTokens }
      }))
      break
    case 'tool-diff':
      updateAssistant(set, get, (current) => ({
        ...current,
        tools: current.tools.map((tool) => (tool.id === payload.diff.toolUseId ? { ...tool, diff: payload.diff } : tool))
      }))
      break
    case 'plan-review': {
      const messages = get().messages
      const last = [...messages].reverse().find((message) => message.role === 'assistant')
      set({
        pendingPlan: {
          messageId: last?.id ?? '',
          plan: payload.plan.plan,
          filePath: payload.plan.filePath ?? null
        }
      })
      break
    }
    case 'session':
      /**
       * 记住远端会话 id ↔ 我们自己这条会话的对应关系。
       * 历史列表要用它把"我们记下的首条提问"当成名字 —— 很多通道（dsh 的 ACP）
       * 在 `session/list` 里**只回 id 与 cwd**，不给任何标题（见 runtime.withSessionTitles）。
       */
      if (payload.remoteSessionId) {
        const conversationId = get().conversationId
        if (conversationId) {
          void api.store.conversationSetRemoteSession(conversationId, payload.remoteSessionId).catch(() => undefined)
        }
      }
      if (payload.activeModel) {
        set({ activeModel: payload.activeModel })
        logDebug('实际运行模型：' + payload.activeModel)
      }
      void persistAgentState(get)
      /**
       * 会话已经初始化完成 —— 这时再拉一次模型清单，
       * 就能拿到"角色别名 → 真实模型"的映射（换 API 后这是界面上最关键的一行信息）。
       */
      if (get().sessionId) void get().refreshModels(payload.sessionId ?? '')
      break
    case 'checkpoint':
      // 记住每条用户消息对应的检查点 id：回退时要用（见 执行记录 §34）
      set({ checkpoints: [...get().checkpoints, payload.userMessageId].slice(-50) })
      break
    case 'permission-request': {
      const request: PermissionRequest = {
        requestId: payload.requestId,
        sessionId: payload.sessionId,
        title: payload.detail.title,
        kind: payload.detail.kind,
        rawInput: payload.detail.rawInput,
        options: payload.detail.options
      }
      /**
       * 渲染进程侧只做"展示决策"，真正的放行/拒绝由主进程按同一个策略执行
       * （见 packages/shared/src/permissions.ts 与 runtime.requestPermission）。
       * 这里能自动应答的，是那些主进程已经放行、但它仍然发来询问的场合 ——
       * 例如 Agent 自己拿不准要不要动某个文件。
       */
      const state = get()
      const note = describeAutoDecision(state.permissionMode, request, workspaceDirFor(state))
      if (note) {
        void api.agent.permissionRespond(request.requestId, note.optionId).catch(() => undefined)
        notePermission(set, get, note.text)
        void api.log.write('info', 'agent', '权限自动应答（渲染进程）：' + note.text + ' :: ' + request.title)
        break
      }
      set({ permissions: [...state.permissions, request] })
      break
    }
    case 'done': {
      const messages = get().messages.map((message) =>
        message.status === 'streaming' ? { ...message, status: 'done' as const } : message
      )
      set({ messages, streaming: false })
      /**
       * 计划档的兜底：本轮结束且还没有待批计划时，**只有当这段回答确实像方案**才弹卡片。
       *
       * 实测模型有时只输出方案、不调 ExitPlanMode —— 那种情况下用户不该"没得批"。
       * 但反过来（本轮用户反馈的"死板"）：计划模式下问一句只读问题，回答也被当成方案弹卡片。
       * 判定交给纯函数 `looksLikePlan`（太短的、没有方案小标题也没有分步结构的一律不弹）。
       */
      const state = get()
      if (state.permissionMode === 'plan' && !state.pendingPlan) {
        const last = [...messages].reverse().find((message) => message.role === 'assistant')
        const text = last?.content.trim() ?? ''
        if (last && looksLikePlan(text)) {
          set({ pendingPlan: { messageId: last.id, plan: text, filePath: null } })
        }
      }
      void persistAssistantMessage(get, messages)
      break
    }
    case 'error': {
      updateAssistant(set, get, (current) => ({ ...current, status: 'error', error: payload.message }))
      set({ streaming: false })
      notify(payload.message, 'error', { timeoutMs: 0 })
      break
    }
    default:
      break
  }
}

function updateAssistant(
  set: (partial: Partial<AgentState>) => void,
  get: () => AgentState,
  update: (message: ChatMessage) => ChatMessage
): void {
  const messages = [...get().messages]
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'assistant') {
      messages[i] = update(messages[i])
      break
    }
  }
  set({ messages })
}

async function persistAssistantMessage(get: () => AgentState, messages: ChatMessage[]): Promise<void> {
  const conversationId = get().conversationId
  if (!conversationId) return
  const assistant = [...messages].reverse().find((message) => message.role === 'assistant')
  if (!assistant) return
  await api.store
    .messageAppend({
      id: assistant.id,
      conversationId,
      role: 'assistant',
      content: assistant.content,
      anchorIds: assistant.anchorIds ?? [],
      toolCalls: assistant.tools,
      usage: assistant.usage,
      createdAt: assistant.createdAt
    })
    .catch(() => undefined)
}

async function loadMessages(conversationId: string, set: (partial: Partial<AgentState>) => void): Promise<void> {
  try {
    const rows = (await api.store.messageList(conversationId)) as Record<string, unknown>[]
    const messages: ChatMessage[] = rows.map((row) => ({
      id: String(row.id ?? createId('msg')),
      role: (String(row.role ?? 'assistant') as ChatMessage['role']) ?? 'assistant',
      content: String(row.content ?? ''),
      thinking: '',
      tools: parseJson<ToolCallView[]>(row.tool_calls_json, []),
      usage: parseJson<{ inputTokens: number; outputTokens: number } | undefined>(row.usage_json, undefined),
      createdAt: Number(row.created_at ?? Date.now()),
      status: 'done'
    }))
    set({ messages })
  } catch {
    /* 读取失败时保持空会话 */
  }
}

/** Agent 的工作目录（与主进程 agentRegistry.defaultWorkdir 同一规则）。 */
function workspaceDirFor(state: AgentState): string | null {
  const model = state.docId ? useDocuments.getState().models[state.docId] ?? null : null
  if (!model?.filePath) return null
  const normalized = model.filePath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index > 0 ? normalized.slice(0, index) : null
}

function currentLocale(): 'zh-CN' | 'en-US' {
  return (i18n.language || '').toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN'
}

/**
 * 渲染进程侧的自动应答决策。
 *
 * 与主进程共用一个策略函数：主进程已经放行过的请求不会再发到这里，
 * 所以这里只可能遇到"主进程要求人工确认"的场合 —— 只有**计划模式**下自己拒绝、
 * 以及**编辑自动**模式下自动放行文件编辑这两类可以在这一层闭环。
 */
function describeAutoDecision(
  mode: PermissionMode,
  request: PermissionRequest,
  workspaceDir: string | null
): { optionId: string; text: string } | null {
  /**
   * `ExitPlanMode` / `AskUserQuestion` **必须等人**：
   * 它们不是"要不要动手"的授权，而是"请你批准/请你回答"的交互。
   * 放到策略里算，plan 档会得出"拒绝一切改动" —— 计划就永远批不了（本轮实测踩到：
   * 日志里先是"权限自动拒绝（plan）"，紧接着才是"SDK 权限被拒绝：ExitPlanMode"）。
   */
  if (request.kind === 'plan' || /^(ExitPlanMode|AskUserQuestion)$/i.test(request.title)) return null
  /**
   * 工作区基准拿不到时**不许在这一层替主进程做决定**：
   * 主进程手上有工作目录，它会因此把某些写入判成"越界"或"交人工"；
   * 渲染进程若按 workspaceDir=null 去算，就变成"边界放宽"，会把主进程要问的事悄悄放行。
   */
  if (!workspaceDir && classifyPermission(request.kind) !== 'read') return null
  const decision = decidePermission({
    policy: { mode, workspaceDir, allowedWriteDirs: [] },
    subject: { title: request.title, kind: request.kind, rawInput: request.rawInput, options: request.options }
  })
  if (!decision.autoRespond) return null
  const option = request.options.find((item) =>
    decision.allow ? item.kind === 'allow_once' || item.kind === 'allow_always' : item.kind.startsWith('reject')
  )
  if (decision.allow && !option) return null
  return {
    optionId: decision.allow ? option?.optionId ?? '' : '',
    text: (decision.allow ? '已自动放行：' : '已自动拒绝：') + request.title
  }
}

function notePermission(
  set: (partial: Partial<AgentState>) => void,
  get: () => AgentState,
  text: string
): void {
  const messages = get().messages
  const last = [...messages].reverse().find((message) => message.role === 'assistant')
  set({
    permissionNotes: [...get().permissionNotes, { id: createId('note'), messageId: last?.id ?? '', text }]
  })
}

/** 渲染进程侧的调试日志（走主进程日志文件，便于无人值守排查）。 */
function logDebug(message: string): void {
  void api.log.write('debug', 'agent-panel', message).catch(() => undefined)
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/** 把 Agent 面板状态写进会话快照（FR-10：会话、模式、模型、草稿）。 */
async function persistAgentState(get: () => AgentState): Promise<void> {
  const state = get()
  const key = state.docId ?? globalConversationKey
  await api.session
    .save({
      windows: [
        {
          agent: {
            [key]: {
              conversationId: state.conversationId,
              contextMode: state.contextMode,
              permissionMode: state.permissionMode,
              ultracode: state.ultracode,
              nodeId: null,
              agentId: state.selectedAgentId,
              modelId: state.modelId,
              thinkingEffort: state.thinkingEffort,
              draft: state.draft,
              scrollAnchorMessageId: null
            }
          }
        }
      ]
    })
    .catch(() => undefined)
}

/** 当前文档的 Agent 上下文摘要（供上下文预览面板使用）。 */
export function useActiveDocId(): string | null {
  const tabs = useTabs()
  const group = tabs.groups.find((item) => item.id === tabs.activeGroupId) ?? tabs.groups[0]
  const tab = group?.tabs[group.activeIndex]
  if (!tab || tab.kind === 'welcome' || tab.kind === 'settings') return null
  return tab.docId
}

export function useActiveDocument(): { docId: string | null; title: string } {
  const docId = useActiveDocId()
  const model = useDocuments((state) => (docId ? state.models[docId] ?? null : null))
  return { docId, title: model?.title ?? '' }
}
