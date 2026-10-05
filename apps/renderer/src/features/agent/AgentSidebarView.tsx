import { useEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { CMD, PERMISSION_MODES, type PermissionMode } from '@logicreader/shared'
import { estimateTokens } from '@logicreader/document-model'
import { type SlashCommandView, type WorkspaceFileView } from '@logicreader/shared'
import {
  useAgent,
  type ChatMessage,
  type PermissionRequest,
  type ToolCallView,
  type ToolDiffView
} from '../../state/agent.store'
import type { AgentConfigOption } from '@logicreader/shared'
import { useTabs } from '../../state/tabs.store'
import { useDocuments } from '../../state/documents.store'
import { useUiStore } from '../../state/ui.store'
import { executeCommand } from '../../state/commands.store'
import { notify } from '../../state/notifications.store'
import { api } from '../../lib/api'
import {
  IconAgent,
  IconChevronDown,
  IconChevronRight,
  IconGauge,
  IconHistory,
  IconModel,
  IconPlus,
  IconSend,
  IconStop
} from '../../workbench/icons'
import { AgentMarkdown } from './AgentMarkdown'

type Popover = 'none' | 'mode' | 'control' | 'model' | 'effort' | 'history' | 'agent'

/** 协议 → 选择器里那行小字（告诉用户这条通道是怎么接的）。 */
const PROTOCOL_KEY: Record<string, string> = {
  sdk: 'agent.protocolSdk',
  'app-server': 'agent.protocolAppServer',
  acp: 'agent.protocolAcp',
  cli: 'agent.protocolCli',
  mock: 'agent.protocolMock'
}

/**
 * Agent 面板。
 *
 * 两副面孔（对应参考实现的两种状态）：
 *  - **空会话**：整屏留白 + 居中的品牌块与一句口号，输入区在最下方；
 *  - **有对话**：紧凑的消息流（思考行 / 工具行 / 正文），输入区始终贴在底部。
 *
 * 面板只负责渲染与交互：授权判定在 `packages/shared/src/permissions.ts`，
 * 状态与持久化在 `state/agent.store.ts`，这里不许再抄一份规则。
 */
export function AgentSidebarView(): JSX.Element {
  const { t } = useTranslation()
  const agent = useAgent()
  const tabs = useTabs()
  const documents = useDocuments()
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [popover, setPopover] = useState<Popover>('none')
  /** 打开弹层时选中的是哪个授权控制项（Codex 有两项，所以要记住是哪一项） */
  const [openControl, setOpenControl] = useState<AgentConfigOption | null>(null)
  /** 斜杠面板里当前选中的下标（键盘导航用） */
  const [slashIndex, setSlashIndex] = useState(0)
  /** 历史会话：正在改名的会话 id 与草稿；以及"总结命名"进行中的会话 id */
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [namingId, setNamingId] = useState<string | null>(null)

  /**
   * 「聚焦 Agent 输入框」的请求位（Ctrl+Shift+A / 菜单 / 面板的 ＋ 都会发）。
   * 面板可能**刚被命令打开**——挂载需要一拍，所以消费要在挂载后做；
   * 挂载动画/布局未稳定时直接 focus 也可能被弹层抢走，稍微让一帧。
   */
  const agentFocusRequest = useUiStore((state) => state.agentFocusRequest)
  useEffect(() => {
    if (!agentFocusRequest) return
    useUiStore.getState().consumeAgentFocus()
    const timer = setTimeout(() => inputRef.current?.focus(), 60)
    return () => clearTimeout(timer)
  }, [agentFocusRequest])

  const commitRename = async (sessionId: string): Promise<void> => {
    const text = renameDraft.trim()
    setRenamingId(null)
    if (text.length === 0) return
    await useAgent.getState().renameHistorySession(sessionId, text)
  }

  const activeTab = tabs.activeTab()
  const docId = activeTab && (activeTab.kind === 'reader' || activeTab.kind === 'graph') ? activeTab.docId : null
  const model = docId ? documents.models[docId] ?? null : null

  useEffect(() => {
    void useAgent.getState().init()
    void useAgent.getState().bindDocument(docId)
  }, [docId])

  /**
   * 「通读全文」询问卡片的**就绪重试**：面板挂载时文档模型可能还没解析完（恢复会话的标签是异步打开的），
   * 第一轮 ensureDocumentRead 会因"拿不到模型"静默退出 —— 文档就绪后再补一次。
   * ensureDocumentRead 有自己的幂等守卫（已有会话/已在流式/已提议过就不再提），重复调用无副作用。
   */
  useEffect(() => {
    if (!docId || !model) return
    void useAgent.getState().ensureDocumentRead()
    /*
     * 这里只管"文档模型还没解析完"这一半的重试。
     * 另一半是"Agent 清单/可用性还没探测回来"——那一次重判放在 refreshAgents 内部：
     * 探测完成时 agents.length 往往没变（同一条目只是补上了能力），
     * 用 length 当依赖根本不会触发，卡片就永远不出现（实测踩到）。
     */
  }, [docId, model, agent.hydratedFromSnapshot])

  /**
   * 启动即把真实模型清单拉回来（起临时进程探测）。
   * 没有这一步的话，"角色别名 → 真实模型"要等用户先发一条消息才出现 —— 用户会以为功能没做。
   */
  useEffect(() => {
    void useAgent.getState().ensureModels()
  }, [agent.selectedAgentId])

  // 有可用 Agent 却还没选中时自动选一个，避免输入框"看起来不能用"
  const availableIds = agent.agents.filter((item) => item.capability?.available).map((item) => item.id).join(',')
  useEffect(() => {
    if (agent.selectedAgentId) return
    const preferred =
      agent.agents.find((item) => item.capability?.available && item.id !== 'mock') ??
      agent.agents.find((item) => item.capability?.available)
    if (preferred) void useAgent.getState().selectAgent(preferred.id)
  }, [availableIds, agent.selectedAgentId, agent.agents])

  /**
   * 消息流的滚动：**重新打开面板不许自动跳转**（用户报的："每次打开 agent 工具的时候自动跳转"）。
   *
   * 面板是按需挂载的（辅助栏切走就卸载），旧的贴底 effect 依赖整个 `messages` 数组，
   * 重新挂载（以及恢复会话）时都会把视图甩到最下面 —— 用户正在读中间那段时尤其刺眼。
   *
   * 三条规则：
   *  1. 挂载时把**上次的位置**放回去（按 docId 记在内存里；没有记录就停在顶部，不主动贴底）；
   *  2. 只有"用户自己滚过、且现在就在底部"时，新内容才贴底 —— 读了中间那段就别把他拽走；
   *  3. 用户自己发消息永远贴底（他当然要看回复）。
   *
   * 全部走 ref，不进 React state：滚动事件非常频繁，进 state 会让整条消息流重渲染
   * （与"面板拖拽不进 state"同一个理由，见 ARCHITECTURE §1.20）。
   */
  const nearBottom = useRef(true)
  const userScrolled = useRef(false)
  const scrollMemory = useRef<Map<string, number>>(new Map())
  const restoredFor = useRef<string | null>(null)
  const scrollKey = agent.docId ?? 'global'

  const onStreamScroll = (event: UIEvent<HTMLDivElement>): void => {
    const element = event.currentTarget
    userScrolled.current = true
    nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
    scrollMemory.current.set(scrollKey, element.scrollTop)
  }

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    if (restoredFor.current !== scrollKey) {
      // 第一次拿到这个文档的内容：放回上次的位置（没记录 → 停在顶部，**不**贴底）
      restoredFor.current = scrollKey
      userScrolled.current = false
      element.scrollTop = scrollMemory.current.get(scrollKey) ?? 0
      nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
      return
    }
    if (!userScrolled.current || !nearBottom.current) return
    element.scrollTop = element.scrollHeight
    // 依赖用 `messages` 的**数组身份**而不是长度：流式输出期间长度不变、内容在长，
    // 靠身份变化才能跟着贴底；已经用 nearBottom / userScrolled 两道闸门挡住了"乱贴底"。
  }, [agent.messages, agent.permissionNotes, agent.streaming, scrollKey])

  /** 用户发消息：这一次必须贴底（他要看回复） */
  const stickToBottom = (): void => {
    userScrolled.current = true
    nearBottom.current = true
  }

  // 点面板任何地方都关掉弹层（弹层自己 stopPropagation）
  useEffect(() => {
    if (popover === 'none') return
    const close = (): void => setPopover('none')
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [popover])

  const capability = useMemo(
    () => agent.agents.find((item) => item.id === agent.selectedAgentId)?.capability ?? null,
    [agent.agents, agent.selectedAgentId]
  )
  const availableAgents = agent.agents.filter((item) => item.capability?.available)
  /** 探测到但**不可用**的（装了没找到路径 / 缺依赖）：列出来并说明原因，不再静默隐藏 */
  const unavailableAgents = useMemo(
    () => agent.agents.filter((item) => item.capability && !item.capability.available),
    [agent.agents]
  )

  /**
   * 模型清单以 `resolvedModels`（CLI 亲口说的那份）为准，退到能力清单。
   * 换 API 之后别名与真实模型不同名，只有前者能说明"现在是谁在回答"。
   */
  const modelOptions = agent.resolvedModels.length > 0 ? agent.resolvedModels : capability?.models ?? []
  const currentModel = modelOptions.find((item) => item.id === agent.modelId) ?? null
  /**
   * 哪个条目对应**当前真正在跑的模型**。
   * 换 API 后不能用"选中的 id"来判断：用户选的可能是 sonnet，跑的却是 GLM-5.3-Flash。
   */
  const activeModelId =
    modelOptions.find(
      (item) =>
        item.resolvedModel &&
        agent.activeModel &&
        // 大小写不敏感：CLI 报的是 `Qwen3.8-Flash[1m]`，清单里的 resolvedModel 可能是 `[1M]`（本轮实测踩到）
        item.resolvedModel.toLowerCase() === agent.activeModel.toLowerCase()
    )?.id ?? agent.modelId
  const thoughtLevels = currentModel?.thoughtLevels ?? []
  const currentEffort = thoughtLevels.find((level) => level.id === agent.thinkingEffort) ?? null
  const extraHigh = thoughtLevels.find((level) => /xhigh|extra|max|ultra/i.test(level.id + level.name)) ?? null

  /**
   * 当前通道**真实提供**的授权控制项（能力里 `category === 'permission'` 的配置项）。
   *
   * 上限来自协议，不是本程序的取舍：Claude Code 给授权模式（还能在活动会话上切），
   * Codex 给审批策略 + 沙箱（只能在建线程时定），DeepSeek Harness 一项都没有 ——
   * 它那边 `session/set_mode` 直接 `Method not found`（离线探针实测）。
   * 所以界面**有什么画什么**：没有就不摆一个切不动的档位。
   */
  const permissionControls = (capability?.configOptions ?? []).filter((option) => option.category === 'permission')
  const controlValueOf = (control: AgentConfigOption): string =>
    agent.configValues[control.id] ?? (typeof control.currentValue === 'string' ? control.currentValue : '')
  /** 依次尝试几个文案键，返回第一个真正存在的（i18next 缺键会原样返回键名）。 */
  const pickText = (keys: string[]): string | null => {
    for (const key of keys) {
      const text = t(key)
      if (text !== key) return text
    }
    return null
  }
  const controlTitle = (control: AgentConfigOption): string =>
    pickText(['agent.permission.' + control.id + '.name']) ?? control.name
  /**
   * 候选项的名字与说明：Claude Code 的四个档位沿用既有的 `agent.mode.*` 文案（那是它自己的词汇），
   * 其余按 `agent.permission.<控件 id>.<值>` 取；再取不到就用协议原文（如 Codex 的 `untrusted`）。
   */
  const optionName = (control: AgentConfigOption, value: string, fallback: string): string =>
    pickText(control.id === 'permissionMode' ? ['agent.mode.' + value + '.name'] : []) ??
    pickText(['agent.permission.' + control.id + '.' + value]) ??
    fallback
  const optionHint = (control: AgentConfigOption, value: string, fallback?: string): string | undefined =>
    pickText(control.id === 'permissionMode' ? ['agent.mode.' + value + '.description'] : []) ??
    pickText(['agent.permission.' + control.id + '.' + value + '.description']) ??
    fallback
  /**
   * 上下文占用：**Agent 报的真实值优先**（事件/拉取共同刷新，跟着对话走）；
   * 没有真实值时才退到"文档体量的静态估算"——并明说它是估算，别让用户把文档大小当成对话占用。
   */
  const realContext = agent.contextUsage
  const estimatedContext = model ? estimateTokens(model.text) : 0
  const contextLabel = realContext
    ? t('agent.contextTokens', { tokens: realContext.used.toLocaleString() }) + (realContext.size ? ' / ' + realContext.size.toLocaleString() : '')
    : estimatedContext > 0
      ? t('agent.contextTokensEstimate', { tokens: estimatedContext.toLocaleString() })
      : null
  const ready = Boolean(agent.selectedAgentId && capability?.available)
  /**
   * 模型芯片的悬停说明：把"选的角色 -> 实际解析到的模型"讲清楚。
   * 用户换了第三方 API 之后，这里的差异就是他们最需要确认的信息。
   */
  const modelChipTitle = (() => {
    const alias = currentModel?.id ?? agent.modelId ?? ''
    const real = agent.activeModel ?? currentModel?.resolvedModel ?? null
    if (real && alias && real.toLowerCase() !== alias.toLowerCase()) {
      return t('agent.modelAliasHint', { alias, real })
    }
    return real ?? t('agent.modelLabel')
  })()

  /**
   * 斜杠补全状态：草稿形如 "/xxx"（没有空格）时打开。
   * 命令来自 CLI 下发，用户自己的技能也在里面 —— 界面不维护命令表。
   */
  const slashQuery = useMemo(() => {
    const draft = agent.draft
    if (!draft.startsWith('/') || draft.includes(' ') || draft.includes('\n')) return null
    return draft.slice(1).toLowerCase()
  }, [agent.draft])
  const filteredCommands = useMemo(() => {
    if (slashQuery === null) return []
    if (slashQuery.length === 0) return agent.commands
    return agent.commands.filter((command) => command.name.toLowerCase().includes(slashQuery))
  }, [agent.commands, slashQuery])

  /** 选中命令：直接把 "/name " 放进输入框，参数由用户补（有些命令本身不带参数，回车即发）。 */
  const applyCommand = (command: SlashCommandView | undefined): void => {
    if (!command) return
    agent.setDraft('/' + command.name + ' ')
    setSlashIndex(0)
  }

  /**
   * "@ 文件引用"：草稿里最后一个 "@xxx" 片段作为查询词（支持带空格路径的引号写法）。
   * 候选由主进程扫工作目录（遵守 respectGitIgnore），这里只负责补全成 "@路径 "。
   * 行区间用 VS Code 的写法 \`@file#L12-15\`，由 Agent 的 Read 工具解释。
   */
  const atQuery = useMemo(() => {
    const draft = agent.draft
    const match = /(?:^|\s)@([^\s]*)$/.exec(draft)
    if (!match) return null
    return { query: match[1], start: draft.length - match[1].length - 1 }
  }, [agent.draft])
  const [atFiles, setAtFiles] = useState<WorkspaceFileView[]>([])
  const [atIndex, setAtIndex] = useState(0)
  /**
   * 候选的根目录 = **会话实际使用的工作目录**。
   * 不能只用"当前文档目录"：没打开文档时它为空，候选就永远空；
   * 而 Agent 真正读写的地方由主进程按同一套规则解析（见 runtime.workdirFor），
   * 两边必须一致，否则会出现"界面列的文件，Agent 读不到"。
   */
  const [atBaseDir, setAtBaseDir] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const documentDir = documentDirectory()
      const dir = await window.logicreader.agent.workdir(documentDir).catch(() => null)
      if (!cancelled) setAtBaseDir(dir)
    })()
    return () => {
      cancelled = true
    }
  }, [docId])
  useEffect(() => {
    if (!atQuery) {
      setAtFiles([])
      return
    }
    let cancelled = false
    void (async () => {
      const files = await agent.queryFiles(atBaseDir, atQuery.query)
      if (!cancelled) {
        setAtFiles(files)
        setAtIndex(0)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [atQuery?.query, atBaseDir, agent])

  const applyFile = (file: WorkspaceFileView | undefined): void => {
    if (!file || !atQuery) return
    const draft = agent.draft
    // 带空格的路径用引号包起来，和 VS Code 的 @-mention 语法一致
    const reference = file.path.includes(' ') ? '@"' + file.path + '" ' : '@' + file.path + ' '
    agent.setDraft(draft.slice(0, atQuery.start) + reference)
    setAtFiles([])
  }

  const send = (): void => {
    const text = agent.draft.trim()
    if (text.length === 0 || agent.streaming) return
    stickToBottom()
    const selection = useUiStore.getState().selection
    const includeSelection = selection && selection.docId === docId
    void (async () => {
      const { ask } = await import('../../state/askFlow')
      await ask({
        question: text,
        nodeId: null,
        selection: includeSelection
          ? { docId: selection.docId, charStart: selection.charStart, charEnd: selection.charEnd, text: selection.text }
          : null
      })
    })()
  }

  if (availableAgents.length === 0) {
    return (
      <div className="lr-agent" data-state="unavailable">
        <div className="lr-agent__welcome">
          <div className="lr-agent__welcome-mark">
            <IconAgent size={28} />
          </div>
          <div className="lr-agent__welcome-title">{t('agent.unavailable')}</div>
          <p className="lr-agent__welcome-hint">{t('agent.unavailableHint')}</p>
          <button className="lr-button lr-button--secondary" onClick={() => void executeCommand(CMD.agentManager)}>
            {t('agent.manager')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="lr-agent" data-empty={agent.messages.length === 0}>
      <div className="lr-agent__stream lr-scroll" ref={scrollRef} onScroll={onStreamScroll}>
        {agent.messages.length === 0 ? (
          <div className="lr-agent__welcome">
            <div className="lr-agent__welcome-mark">
              <IconAgent size={30} />
            </div>
            <div className="lr-agent__welcome-title">{capability?.displayName ?? t('agent.title')}</div>
            <p className="lr-agent__welcome-hint">{t('agent.welcomeHint')}</p>
          </div>
        ) : (
          agent.messages.map((message) => (
            <MessageEntry
              key={message.id}
              message={message}
              notes={agent.permissionNotes.filter((note) => note.messageId === message.id)}
            />
          ))
        )}

        {/* 计划审阅卡片：kind='plan' 的权限请求由它接管，不再画通用权限卡片 */}
        {agent.readAsk && agent.messages.length === 0 ? (
          /*
           * 「通读全文」询问卡片（规划书 FR-7：**先请求用户询问**是否激活 Agent 工具把打开的文件通读）。
           * 旧行为是文档一打开就把整篇全文发出去 —— 用户没点过任何东西，模型调用已经花掉了。
           */
          <div className="lr-agent__askcard" data-ask="read">
            <div className="lr-agent__askcard-title">{t('agent.readAskTitle', { title: agent.readAsk.title })}</div>
            <p className="lr-agent__askcard-body">{t('agent.readAskBody')}</p>
            <div className="lr-agent__askcard-actions">
              <button className="lr-button" onClick={() => void agent.startDocumentRead()}>
                {t('agent.readAskStart')}
              </button>
              <button className="lr-button lr-button--secondary" onClick={() => void agent.dismissDocumentRead()}>
                {t('agent.readAskLater')}
              </button>
            </div>
          </div>
        ) : null}
        {agent.pendingPlan ? <PlanReviewCard plan={agent.pendingPlan} /> : null}
        {agent.permissions
          .filter((permission) => permission.kind !== 'plan')
          .map((permission) => (
            <PermissionCard
              key={permission.requestId}
              permission={permission}
              onRespond={(requestId, optionId) => void agent.respondPermission(requestId, optionId)}
            />
          ))}
      </div>

      {/* 空会话时整条状态行都收起来：参考实现里这里什么都没有，多一行就是噪音 */}
      {agent.messages.length > 0 || agent.streaming ? (
        <div className="lr-agent__statusline" data-streaming={agent.streaming}>
          <span className="lr-agent__status-text">
            {agent.streaming ? t('agent.statusWorking') : capability?.displayName}
          </span>
          {contextLabel ? <span className="lr-agent__status-meta">{contextLabel}</span> : null}
        </div>
      ) : null}

      <div className="lr-agent__composer" data-card="true">
        {/*
          斜杠命令面板：命令清单由 CLI 下发（含用户技能），这里只做过滤与补全。
          触发条件与 VS Code 一致：草稿以 "/" 开头且还没输入空格。
        */}
        {slashQuery !== null ? (
          <div className="lr-agent__popover" onMouseDown={(event) => event.stopPropagation()}>
            <div className="lr-agent__picker">
              <div className="lr-agent__picker-head">
                <span>{t('agent.slashTitle')}</span>
                <span className="lr-agent__picker-hint">
                  {t('agent.slashCount', { count: filteredCommands.length })}
                </span>
              </div>
              {filteredCommands.length === 0 ? (
                <div className="lr-agent__picker-empty">{t('agent.slashEmpty')}</div>
              ) : (
                filteredCommands.slice(0, 12).map((command) => (
                  <button
                    key={command.name}
                    className="lr-agent__picker-item"
                    data-active={filteredCommands.indexOf(command) === slashIndex}
                    onMouseEnter={() => setSlashIndex(filteredCommands.indexOf(command))}
                    onClick={() => applyCommand(command)}
                  >
                    <span className="lr-agent__picker-glyph" aria-hidden="true">
                      {'/'}
                    </span>
                    <span className="lr-agent__picker-body">
                      <span className="lr-agent__picker-name">{command.name}</span>
                      {command.description ? (
                        <span className="lr-agent__picker-desc">{command.description.slice(0, 160)}</span>
                      ) : null}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : null}

        {/* "@ 文件引用"候选：与斜杠面板同一形态，数据来自主进程的工作区索引 */}
        {atQuery ? (
          <div className="lr-agent__popover" onMouseDown={(event) => event.stopPropagation()}>
            <div className="lr-agent__picker">
              <div className="lr-agent__picker-head">
                <span>{t('agent.fileTitle')}</span>
                <span className="lr-agent__picker-hint">{t('agent.fileHint')}</span>
              </div>
              {atFiles.length === 0 ? (
                // 空候选要说清原因：没打开文档时工作区是隔离的空目录（不是坏了）
                <div className="lr-agent__picker-empty">
                  {atBaseDir ? t('agent.fileEmpty') : t('agent.fileNoWorkspace')}
                </div>
              ) : null}
              {atFiles.map((file, index) => (
                <button
                  key={file.path}
                  className="lr-agent__picker-item"
                  data-active={index === atIndex}
                  onMouseEnter={() => setAtIndex(index)}
                  onClick={() => applyFile(file)}
                >
                  <span className="lr-agent__picker-body">
                    <span className="lr-agent__picker-name">{file.name}</span>
                    <span className="lr-agent__picker-desc">{file.dir || '.'}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {popover !== 'none' ? (
          <div className="lr-agent__popover" onMouseDown={(event) => event.stopPropagation()}>
            {popover === 'mode' ? (
              /*
               * 走到这里说明**这个通道自己没有授权档位**（能力里没有任何 permission 控制项）：
               * 显示的是我们客户端的放行策略，标题与脚注都要写清这一点，
               * 别让用户以为 DeepSeek Harness 有"计划模式"这种功能。
               */
              <ModePicker
                value={agent.permissionMode}
                title={t('agent.policyTitle')}
                note={t('agent.policyNote', { agent: capability?.displayName ?? t('agent.title') })}
                onPick={(mode) => {
                  setPopover('none')
                  void agent.setPermissionMode(mode)
                }}
              />
            ) : null}
            {popover === 'control' && openControl ? (
              <OptionPicker
                title={controlTitle(openControl)}
                options={(openControl.options ?? []).map((option) => ({
                  id: option.value,
                  name: optionName(openControl, option.value, option.name),
                  hint: optionHint(openControl, option.value, option.description)
                }))}
                value={controlValueOf(openControl)}
                emptyHint=""
                onPick={(value) => {
                  setPopover('none')
                  void agent.setConfigValue(openControl.id, value)
                }}
              />
            ) : null}
            {popover === 'model' ? (
              <OptionPicker
                title={t('agent.modelLabel')}
                options={modelOptions.map((item) => ({
                  id: item.id,
                  name: item.name,
                  /**
                   * 第二行：**角色别名 → 真实模型**。
                   * 用户把 Claude Code 指向第三方 API 后，sonnet/opus 这类别名与真实模型不是一回事；
                   * 只显示别名的话，根本看不出"现在是谁在回答"（例如 sonnet → GLM-5.3-Flash）。
                   */
                  hint: item.resolvedModel
                    ? item.id.toLowerCase() === item.resolvedModel.toLowerCase()
                      ? t('agent.modelSameName', { model: item.resolvedModel })
                      : t('agent.modelAliasHint', { alias: item.id, real: item.resolvedModel })
                    : item.description,
                  /** 标出"当前实际在跑"的那一项（与上面那个勾选的"选中项"不是一回事） */
                  running: item.id === activeModelId
                }))}
                value={agent.modelId}
                emptyHint={t('graph.manualModel')}
                onPick={(id) => {
                  setPopover('none')
                  agent.setModel(id)
                }}
              />
            ) : null}
            {popover === 'effort' ? (
              <OptionPicker
                title={t('agent.effortLabel')}
                options={thoughtLevels.map((item) => ({ id: item.id, name: item.name, hint: item.description }))}
                value={agent.thinkingEffort}
                emptyHint={t('graph.effortUnsupportedReason', { model: agent.modelId ?? '' })}
                onPick={(id) => {
                  setPopover('none')
                  agent.setThinkingEffort(id)
                }}
              />
            ) : null}
            {popover === 'agent' ? (
              <div className="lr-agent__picker">
                <div className="lr-agent__picker-head">
                  <span>{t('agent.switchTitle')}</span>
                  <span className="lr-agent__picker-hint">{t('agent.switchHint')}</span>
                </div>
                {availableAgents.length === 0 ? (
                  <div className="lr-agent__picker-empty">{t('agent.notFound')}</div>
                ) : (
                  availableAgents.map((item) => (
                    <button
                      key={item.id}
                      className="lr-agent__picker-item"
                      data-active={item.id === agent.selectedAgentId}
                      onClick={() => {
                        setPopover('none')
                        if (item.id === agent.selectedAgentId) return
                        void agent.selectAgent(item.id).then(() => {
                          notify(t('agent.switched', { name: item.displayName }), 'success')
                        })
                      }}
                    >
                      <span className="lr-agent__picker-glyph" aria-hidden="true">
                        {item.id === agent.selectedAgentId ? '✓' : '○'}
                      </span>
                      <span className="lr-agent__picker-body">
                        <span className="lr-agent__picker-name">{item.displayName}</span>
                        <span className="lr-agent__picker-desc">
                          {t(PROTOCOL_KEY[item.capability?.protocol ?? 'cli'] ?? 'agent.protocolCli')}
                          {item.capability?.models.length
                            ? ' · ' + t('agent.switchModels', { count: item.capability.models.length })
                            : ''}
                        </span>
                      </span>
                    </button>
                  ))
                )}
                {/**
                 * **不可用的也要列出来**（灰掉、不可点、把原因写在下面）。
                 * 以前这里只显示可用通道，"装了却没找到"就变成一片沉默 —— 用户根本不知道
                 * 程序有没有看见那个工具（本轮的真实现象：库里一条过期的"未找到可执行文件"
                 * 让 dsh 直接从列表里消失）。原因通常就是路径没被找到，去设置 → Agent 管理器能修。
                 */}
                {unavailableAgents.map((item) => (
                  <div className="lr-agent__picker-item" key={item.id} data-disabled="true" title={item.capability?.error ?? undefined}>
                    <span className="lr-agent__picker-glyph" aria-hidden="true">
                      ⊘
                    </span>
                    <span className="lr-agent__picker-body">
                      <span className="lr-agent__picker-name">
                        {item.displayName}
                        <span className="lr-agent__picker-desc"> · {t('settings.agent.unavailable')}</span>
                      </span>
                      <span className="lr-agent__picker-desc">{item.capability?.error ?? t('agent.notFound')}</span>
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {popover === 'history' ? (
              <div className="lr-agent__picker">
                <div className="lr-agent__picker-head">
                  <span>{t('agent.historyTitle')}</span>
                  {/**
                   * 提示按**当前通道**说：以前写死成"与 VS Code 共用同一份 Claude Code 会话记录"，
                   * 选 dsh 时那句话就是错的（用户直接指出来的）。
                   */}
                  <span className="lr-agent__picker-hint">
                    {t(
                      capability?.protocol === 'app-server'
                        ? 'agent.historyHintCodex'
                        : capability?.protocol === 'acp'
                          ? 'agent.historyHintAcp'
                          : capability?.protocol === 'sdk'
                            ? 'agent.historyHintSdk'
                            : 'agent.historyHint'
                    )}
                  </span>
                </div>
                {agent.history.length === 0 ? (
                  <div className="lr-agent__picker-empty">{t('agent.historyEmpty')}</div>
                ) : (
                  agent.history.map((item) => (
                    <div className="lr-agent__picker-row" key={item.sessionId}>
                      {renamingId === item.sessionId ? (
                        /**
                         * 改名：就地输入（**Enter 确定** / Esc 取消）。
                         * `onMouseDown` 要挡住：面板对"点到空白处"的监听挂在 window 上，
                         * 不挡的话点进输入框就会先把整个弹层关掉（本轮就是这个 bug，
                         * 输入框根本留不住，回车自然也谈不上）。
                         */
                        <span
                          className="lr-agent__picker-body lr-agent__rename"
                          onMouseDown={(event) => event.stopPropagation()}
                        >
                          <input
                            autoFocus
                            value={renameDraft}
                            placeholder={t('agent.historyRenamePlaceholder')}
                            onFocus={(event) => event.target.select()}
                            onChange={(event) => setRenameDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault()
                                void commitRename(item.sessionId)
                              } else if (event.key === 'Escape') {
                                event.preventDefault()
                                setRenamingId(null)
                              }
                            }}
                          />
                          <span className="lr-agent__rename-actions">
                            <button className="lr-chip" onClick={() => void commitRename(item.sessionId)}>
                              {t('common.save')}
                            </button>
                            <button className="lr-chip" onClick={() => setRenamingId(null)}>
                              {t('common.cancel')}
                            </button>
                          </span>
                        </span>
                      ) : (
                        <button
                          className="lr-agent__picker-item"
                          onClick={() => {
                            setPopover('none')
                            void agent.resumeSession(item.sessionId)
                          }}
                        >
                          <span className="lr-agent__picker-body">
                            <span className="lr-agent__picker-name">
                              {item.title ?? t('agent.historyUntitled', { id: item.shortId ?? item.sessionId.slice(0, 8) })}
                            </span>
                            <span className="lr-agent__picker-desc">
                              {formatWhen(item.lastModified)}
                              {item.titleSource === 'stored' ? ' · ' + t('agent.historyNamed') : ''}
                              {item.gitBranch ? ' · ' + item.gitBranch : ''}
                            </span>
                          </span>
                        </button>
                      )}
                      {/* 总结命名：让 Agent 续聊这条会话、用一句话概括它（很小的调用） */}
                      <button
                        className="lr-agent__picker-action"
                        title={t('agent.historyNameHint')}
                        disabled={namingId === item.sessionId}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={() => {
                          setNamingId(item.sessionId)
                          void agent
                            .nameHistorySession(item.sessionId, item.firstPrompt ?? null)
                            .finally(() => setNamingId(null))
                        }}
                      >
                        {namingId === item.sessionId ? t('agent.historyNaming') : t('agent.historyName')}
                      </button>
                      {/* 改名：自己起一个更好记的名字 */}
                      <button
                        className="lr-agent__picker-action"
                        title={t('agent.historyRenameHint')}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={() => {
                          setRenamingId(item.sessionId)
                          setRenameDraft(item.title ?? '')
                        }}
                      >
                        {t('agent.historyRename')}
                      </button>
                      {/* 分叉：复制这条会话的历史另起一条线，原会话不动（与"续聊"是两回事） */}
                      <button
                        className="lr-agent__picker-action"
                        title={t('agent.forkHint')}
                        onClick={() => {
                          setPopover('none')
                          void agent.forkSession(item.sessionId)
                        }}
                      >
                        {t('agent.fork')}
                      </button>
                      {/* 删除：删掉这条会话的本机记录（目前仅 Claude Code 通道支持；先确认再动手） */}
                      <button
                        className="lr-agent__picker-action lr-agent__picker-action--danger"
                        title={t('agent.historyDeleteHint')}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={() => {
                          void (async () => {
                            const answer = await api.dialog.message({
                              type: 'question',
                              message: t('agent.historyDeleteConfirm', {
                                name: item.title ?? t('agent.historyUntitled', { id: item.shortId ?? item.sessionId.slice(0, 8) })
                              }),
                              detail: t('agent.historyDeleteDetail'),
                              buttons: [t('common.delete'), t('common.cancel')],
                              cancelId: 1
                            })
                            if (answer !== 0) return
                            await agent.deleteHistorySession(item.sessionId)
                          })()
                        }}
                      >
                        {t('common.delete')}
                      </button>
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="lr-agent__input" data-disabled={!ready}>
          <textarea
            ref={inputRef}
            value={agent.draft}
            placeholder={ready ? t('agent.inputPlaceholder') : t('agent.notFound') + ' · ' + t('agent.unavailableHint')}
            rows={1}
            onChange={(event) => agent.setDraft(event.target.value)}
            onKeyDown={(event) => {
              // "@ 文件"候选优先于斜杠面板（两者不会同时出现，但顺序写清楚更安全）
              if (atQuery && atFiles.length > 0) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setAtIndex((value) => (value + 1) % atFiles.length)
                  return
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setAtIndex((value) => (value - 1 + atFiles.length) % atFiles.length)
                  return
                }
                if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
                  event.preventDefault()
                  applyFile(atFiles[Math.min(atIndex, atFiles.length - 1)])
                  return
                }
              }
              // 斜杠面板打开时，键盘先归它：上下选、Tab/Enter 补全、Esc 关掉
              if (slashQuery !== null && filteredCommands.length > 0) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setSlashIndex((value) => (value + 1) % Math.min(filteredCommands.length, 12))
                  return
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setSlashIndex((value) => (value - 1 + Math.min(filteredCommands.length, 12)) % Math.min(filteredCommands.length, 12))
                  return
                }
                if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
                  event.preventDefault()
                  applyCommand(filteredCommands[Math.min(slashIndex, filteredCommands.length - 1)])
                  return
                }
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                send()
              }
              if (event.key === 'Escape') {
                /*
                 * 顺序即语义（与全局快捷键的分工见 keybindings.ts）：
                 * 先关浮层，再放弃草稿，最后才是"停止生成" —— 别让打字打一半的 Esc 掐掉回合。
                 */
                if (popover !== 'none') setPopover('none')
                else if (agent.draft.trim().length > 0) agent.setDraft('')
                else if (agent.streaming) void agent.stop()
              }
            }}
          />
          <div className="lr-agent__input-actions">
            <button
              className="lr-icon-button"
              title={t('agent.newSession')}
              onClick={() => {
                void agent.newSession()
                // 新会话清掉消息流后输入框保持焦点，用户能直接开始打字
                setTimeout(() => inputRef.current?.focus(), 30)
              }}
            >
              <IconPlus size={15} />
            </button>
          </div>
        </div>

        <div className="lr-agent__composer-row">
          {/* Agent 切换：显示当前 Agent 的名字，点开是完整选择器（含协议与模型数） */}
          <button
            className="lr-agent__chip"
            data-chip="agent"
            data-active={popover === 'agent'}
            title={t('agent.switchTitle')}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => setPopover((value) => (value === 'agent' ? 'none' : 'agent'))}
          >
            <IconAgent size={13} />
            {/* 主信息：当前 Agent 的名字完整可读（辅助栏最窄时也不许截成 "Clau…"） */}
            {capability?.displayName ?? t('agent.selectAgent')}
          </button>

          {/*
           * 授权档位：**有什么画什么**。
           *  - 该通道自己声明了档位（Claude Code 的授权模式 / Codex 的审批策略+沙箱）→ 一项一个 chip；
           *  - 一项都没有（DeepSeek Harness 的 ACP 里没有 modes、mock 也没有）→ 才显示
           *    **客户端**的放行策略（它仍然有效：决定客户端怎么应答写入/执行请求）。
           */}
          {permissionControls.map((control) => (
            <button
              key={control.id}
              className="lr-agent__mode"
              data-mode={control.id}
              title={controlTitle(control)}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => {
                setOpenControl(control)
                setPopover((value) => (value === 'control' ? 'none' : 'control'))
              }}
            >
              <span className="lr-agent__mode-icon" aria-hidden="true">
                {control.id === 'sandbox' ? '🔒' : '⚖'}
              </span>
              {permissionControls.length > 1
                ? controlTitle(control) + '：' + optionName(control, controlValueOf(control), controlValueOf(control))
                : optionName(control, controlValueOf(control), controlValueOf(control))}
            </button>
          ))}
          {permissionControls.length === 0 ? (
            <button
              className="lr-agent__mode"
              data-mode={agent.permissionMode}
              /* 标记"这是客户端策略，不是那个工具自己的档位"（冒烟断言据此区分两类 chip） */
              data-policy="true"
              title={t('agent.policyTitle')}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => setPopover((value) => (value === 'mode' ? 'none' : 'mode'))}
            >
              <span className="lr-agent__mode-icon" aria-hidden="true">
                {MODE_GLYPH[agent.permissionMode]}
              </span>
              {t('agent.mode.' + agent.permissionMode + '.name')}
            </button>
          ) : null}

          <button
            className="lr-agent__chip"
            data-chip="history"
            title={t('agent.historyTitle')}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => {
              const next = popover === 'history' ? 'none' : 'history'
              setPopover(next)
              if (next === 'history') void agent.refreshHistory(documentDirectory())
            }}
          >
            <IconHistory />
            {t('agent.historyButton')}
          </button>

          {extraHigh ? (
            <button
              className="lr-agent__chip"
              data-active={agent.thinkingEffort === extraHigh.id}
              title={t('agent.ultracodeHint')}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => agent.setThinkingEffort(agent.thinkingEffort === extraHigh.id ? null : extraHigh.id)}
            >
              {t('agent.ultracode')}
            </button>
          ) : null}

          {modelOptions.length > 0 ? (
            <button
              className="lr-agent__chip"
              title={modelChipTitle}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => setPopover((value) => (value === 'model' ? 'none' : 'model'))}
            >
              <IconModel />
              {/* 显示**真实在跑的模型**：换 API 之后别名（sonnet/opus）已经说明不了问题 */}
              {agent.activeModel ?? currentModel?.name ?? t('graph.manualModel')}
            </button>
          ) : null}

          {thoughtLevels.length > 0 ? (
            <button
              className="lr-agent__chip"
              title={t('agent.effortLabel')}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => setPopover((value) => (value === 'effort' ? 'none' : 'effort'))}
            >
              <IconGauge />
              {currentEffort?.name ?? t('graph.effort')}
            </button>
          ) : null}

          {/* 占位放在最后：chip 换行时第二行从左边起排，发送键始终留在最后一行的右端 */}
          <div className="lr-agent__composer-spacer" />

          {agent.streaming ? (
            <button className="lr-agent__send" data-stop="true" title={t('agent.stop')} onClick={() => void agent.stop()}>
              <IconStop />
            </button>
          ) : (
            <button
              className="lr-agent__send"
              disabled={agent.draft.trim().length === 0 || !ready}
              title={t('agent.send')}
              onClick={send}
            >
              <IconSend />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** 模式弹层里的图标：与参考实现一致的四个字形语义。 */
const MODE_GLYPH: Record<PermissionMode, string> = {
  manual: '✋',
  edit: '✎',
  plan: '☰',
  auto: '⚡'
}

/**
 * 那四个档位的选择器（**客户端放行策略**）。
 *
 * 只在"该通道自己没有授权档位"时出现（DeepSeek Harness 的 ACP 里没有 modes，
 * `session/set_mode` 直接 Method not found）。此时标题与说明要写清"这是我们这边的策略"，
 * 否则用户会以为这是那个工具的功能。Claude Code 走的是它自己的授权模式（另一条路径）。
 */
function ModePicker({
  value,
  onPick,
  title,
  note
}: {
  value: PermissionMode
  onPick: (mode: PermissionMode) => void
  title?: string
  note?: string
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="lr-agent__picker">
      <div className="lr-agent__picker-head">
        <span>{title ?? t('agent.modeTitle')}</span>
        <span className="lr-agent__picker-hint">{t('agent.modeSwitchHint')}</span>
      </div>
      {PERMISSION_MODES.map((mode) => (
        <button
          key={mode}
          className="lr-agent__picker-item"
          data-active={value === mode}
          onClick={() => onPick(mode)}
        >
          <span className="lr-agent__picker-glyph" aria-hidden="true">
            {MODE_GLYPH[mode]}
          </span>
          <span className="lr-agent__picker-body">
            <span className="lr-agent__picker-name">{t('agent.mode.' + mode + '.name')}</span>
            <span className="lr-agent__picker-desc">{t('agent.mode.' + mode + '.description')}</span>
          </span>
          {value === mode ? <span className="lr-agent__picker-check">✓</span> : null}
        </button>
      ))}
      {note ? <div className="lr-agent__picker-note">{note}</div> : null}
    </div>
  )
}

function OptionPicker({
  title,
  options,
  value,
  emptyHint,
  onPick
}: {
  title: string
  /** running=true 表示这一项就是**当前实际在跑**的模型（不是"选中项"） */
  options: { id: string; name: string; hint?: string; running?: boolean }[]
  value: string | null
  emptyHint: string
  onPick: (id: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="lr-agent__picker">
      <div className="lr-agent__picker-head">
        <span>{title}</span>
      </div>
      {options.length === 0 ? (
        <div className="lr-agent__picker-empty">{emptyHint}</div>
      ) : (
        options.map((option) => (
          <button
            key={option.id}
            className="lr-agent__picker-item"
            data-active={value === option.id}
            onClick={() => onPick(option.id)}
          >
            <span className="lr-agent__picker-body">
              <span className="lr-agent__picker-name">
                {option.name}
                {option.running ? <span className="lr-agent__running">{t('agent.modelRunning')}</span> : null}
              </span>
              {option.hint ? <span className="lr-agent__picker-desc">{option.hint}</span> : null}
            </span>
            {value === option.id ? <span className="lr-agent__picker-check">✓</span> : null}
          </button>
        ))
      )}
    </div>
  )
}

/** 一条消息：用户 / 助手 / 系统，全部走同一种"紧凑条目"排版。 */
function MessageEntry({
  message,
  notes
}: {
  message: ChatMessage
  notes: { id: string; text: string }[]
}): JSX.Element {
  const { t } = useTranslation()
  const agent = useAgent()
  const isUser = message.role === 'user'
  /**
   * "重试"只挂在**最后一条**失败的助手消息上（历史里的旧失败用发新消息覆盖即可，
   * 每条错误都摆按钮会把消息流变成按钮墙）。
   */
  const isLastFailed =
    message.role === 'assistant' &&
    (message.status === 'error' || message.status === 'interrupted') &&
    [...agent.messages].reverse().find((item) => item.role === 'assistant' && (item.status === 'error' || item.status === 'interrupted'))?.id ===
      message.id
  /** 有核心诉求摘要的提问：完整原文默认收起（材料在，点开才看） */
  const [showFull, setShowFull] = useState(false)
  /**
   * 用户提问的锚点（选区提问时带上）：有锚点才能"点位置跳回原文"。
   * 跳转走 `revealInReader` 唯一入口 —— 与关系图跳转同一套行为（打开/激活阅读器标签 + 常驻高亮）。
   */
  const [anchorView, setAnchorView] = useState<{ docId: string; charStart: number; charEnd: number; quote: string } | null>(null)
  useEffect(() => {
    if (!isUser || (message.anchorIds?.length ?? 0) === 0) return
    let cancelled = false
    void (async () => {
      const anchor = await api.store.getAnchor(message.anchorIds![0]).catch(() => null)
      if (cancelled || !anchor) return
      // 锚点自带 docId：就算用户已经切换了文档/会话，跳的还是"提问当时"的那份原文
      setAnchorView({ docId: anchor.docId, charStart: anchor.charStart, charEnd: anchor.charEnd, quote: anchor.quote })
    })()
    return () => {
      cancelled = true
    }
  }, [isUser, message.anchorIds])
  const jumpToSource = async (): Promise<void> => {
    if (!anchorView) return
    const { revealInReader } = await import('../../lib/graphJump')
    const opened = await revealInReader(anchorView.docId, anchorView.charStart, anchorView.charEnd, { hold: true })
    if (!opened) notify(t('graph.jumpFailed'), 'warning')
  }
  return (
    <div className="lr-entry" data-role={message.role} data-status={message.status}>
      {isUser ? (
        <>
          {/* 位置来源可点击（带锚点的选区提问）：跳回原文并常驻高亮，与关系图跳转同一套行为 */}
          {message.locationLabel ? (
            anchorView ? (
              <button
                className="lr-entry__meta lr-entry__meta--link"
                title={t('agent.jumpToSource')}
                onClick={() => void jumpToSource()}
              >
                ↳ {message.locationLabel}
              </button>
            ) : (
              <div className="lr-entry__meta">↳ {message.locationLabel}</div>
            )
          ) : null}
          {/* 气泡里显示**核心诉求**（有摘要时）；完整原文（引用材料/位置头）按需展开看 ——
              历史回放读的是问题，不是材料，但材料一个字也不少（点开可见）。 */}
          {message.summary ? (
            <>
              <div className="lr-entry__question lr-selectable">{message.summary}</div>
              <button
                className="lr-entry__meta lr-entry__meta--link"
                onClick={() => setShowFull((value) => !value)}
              >
                {showFull ? '▾ ' + t('agent.hideOriginal') : '▸ ' + t('agent.showOriginal')}
              </button>
              {showFull ? <div className="lr-entry__text lr-entry__original lr-selectable">{message.content}</div> : null}
            </>
          ) : (
            <div className="lr-entry__question lr-selectable">{message.content}</div>
          )}
        </>
      ) : (
        <>
          {message.thinking.length > 0 ? <ThinkingRow text={message.thinking} /> : null}
          {/* 主线程的工具调用逐条列出；子代理的挤成一行（点开才看它内部的调用） */}
          {message.tools
            .filter((tool) => !tool.parentId)
            .map((tool) => (
              <ToolRow key={tool.id} tool={tool} />
            ))}
          {subagentGroups(message.tools).map((entry) => (
            <SubagentRow key={entry.parentId} parentId={entry.parentId} tools={entry.tools} />
          ))}
          {notes.map((note) => (
            <div key={note.id} className="lr-entry__note">
              ⓘ {note.text}
            </div>
          ))}
          {message.content.length > 0 ? (
            /**
             * 正文按 markdown 渲染（模型回的就是 markdown）。
             * 流式过程中保持纯文本：token 级增量下每来一个字都重新解析 markdown 是白烧 CPU，
             * 而用户此刻只关心"字在往外冒"；本轮结束（done）就换成渲染好的版本。
             */
            message.status === 'streaming' ? (
              <div className="lr-entry__text lr-selectable">{message.content}</div>
            ) : (
              <div className="lr-entry__md lr-selectable">
                <AgentMarkdown text={message.content} />
              </div>
            )
          ) : message.status === 'streaming' && message.tools.length === 0 && message.thinking.length === 0 ? (
            <div className="lr-entry__note">{t('agent.statusWorking')}</div>
          ) : null}
          {message.status === 'streaming' && message.content.length > 0 ? (
            <span className="lr-entry__cursor">▍</span>
          ) : null}
          {message.status === 'error' ? <div className="lr-entry__error">{message.error}</div> : null}
          {message.status === 'interrupted' ? (
            <div className="lr-entry__error">{t('agent.interrupted')}</div>
          ) : null}
          {isLastFailed ? (
            <div className="lr-entry__retry">
              <button
                className="lr-button lr-button--secondary"
                disabled={agent.streaming}
                title={t('agent.retryHint')}
                onClick={() => void agent.retryLast()}
              >
                ⟳ {t('agent.retry')}
              </button>
            </div>
          ) : null}
          {message.usage ? (
            <div className="lr-entry__meta">
              {t('agent.usage', { input: message.usage.inputTokens, output: message.usage.outputTokens })}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

/** 思考行：默认折叠成一行，点开才看全文（参考实现里最显眼的一处"安静"设计）。 */
function ThinkingRow({ text }: { text: string }): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const tail = text.trim().split('\n').filter(Boolean).slice(-1)[0] ?? ''
  return (
    <div className="lr-thinking" data-open={open}>
      <button className="lr-thinking__head" onClick={() => setOpen((value) => !value)}>
        {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        <span className="lr-thinking__label">{t('agent.thinking')}</span>
        {!open && tail ? <span className="lr-thinking__tail">{tail.slice(0, 80)}</span> : null}
      </button>
      {open ? <pre className="lr-thinking__body">{text}</pre> : null}
    </div>
  )
}

/**
 * 工具行：一行摘要 + 可展开的原始报文。
 * 摘要优先给"人话"（标题 / 命令 / 路径），拿不到才退回归一化后的工具名。
 */
function ToolRow({ tool }: { tool: ToolCallView }): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const summary = toolSummary(tool)
  return (
    <div className="lr-toolrow" data-state={tool.state}>
      <button className="lr-toolrow__head" onClick={() => setOpen((value) => !value)}>
        <span className="lr-toolrow__dot" aria-hidden="true" />
        <span className="lr-toolrow__name">{toolDisplayName(tool.name)}</span>
        {summary ? <span className="lr-toolrow__summary">{summary}</span> : null}
        {tool.diff && !tool.diff.truncated ? (
          <span className="lr-toolrow__stats">
            <span className="lr-diffcard__plus">{'+' + tool.diff.additions}</span>
            <span className="lr-diffcard__minus">{'-' + tool.diff.deletions}</span>
          </span>
        ) : null}
        <span className="lr-toolrow__state">
          {tool.state === 'running' ? t('agent.toolRunning') : tool.state === 'error' ? t('common.error') : ''}
        </span>
      </button>
      {tool.diff ? <DiffCard diff={tool.diff} /> : null}
      {open ? (
        <pre className="lr-toolrow__body">
          {JSON.stringify({ input: tool.input, output: tool.output }, null, 2).slice(0, 4000)}
        </pre>
      ) : null}
    </div>
  )
}


/**
 * 内联差异卡片（VS Code 招牌交互的最小可用版）。
 *
 * 与 VS Code 的差别要如实说明：它把改动渲染成**右侧虚拟文档 + 逐 hunk 的注释线程**，
 * 那是因为它跑在编辑器里、能用 diff 编辑器与评论 API；我们这里在对话框里，
 * 给的是「行号 + 增删高亮 + 一键回退到本次改动之前」。
 * 回退走 SDK 的文件检查点（rewindFiles），不是我们自己备份的副本。
 */
function DiffCard({ diff }: { diff: ToolDiffView }): JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(true)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const fileName = diff.filePath.split(/[\\/]/).pop() ?? diff.filePath
  /** 只回退这一块：其余块保持改动后的样子（冲突时不动盘并说明原因）。 */
  const revertOne = async (hunkIndex: number): Promise<void> => {
    setBusy(true)
    try {
      const result = await useAgent.getState().revertHunks(diff.toolUseId, [hunkIndex])
      setNote(result.ok ? t('agent.hunkRevertDone') : (result.conflict ?? t('common.error')))
    } catch (error) {
      setNote(String(error instanceof Error ? error.message : error).slice(0, 200))
    } finally {
      setBusy(false)
    }
  }

  const rewind = async (): Promise<void> => {
    setBusy(true)
    try {
      const checkpoints = useAgent.getState().checkpoints
      const target = checkpoints[checkpoints.length - 1]
      if (!target) throw new Error(t('agent.rewindNoCheckpoint'))
      const preview = (await useAgent.getState().rewindFiles(target, true)) as { filesChanged?: string[] } | null
      await useAgent.getState().rewindFiles(target, false)
      setNote(t('agent.rewindDone', { count: preview?.filesChanged?.length ?? 0 }))
    } catch (error) {
      setNote(String(error instanceof Error ? error.message : error).slice(0, 200))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="lr-diffcard" data-truncated={diff.truncated}>
      <div className="lr-diffcard__head">
        <button className="lr-diffcard__toggle" onClick={() => setExpanded((value) => !value)}>
          {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          <span className="lr-diffcard__file" title={diff.filePath}>
            {fileName}
          </span>
        </button>
        <span className="lr-diffcard__stats">
          <span className="lr-diffcard__plus">{'+' + diff.additions}</span>
          <span className="lr-diffcard__minus">{'-' + diff.deletions}</span>
        </span>
        <button
          className="lr-diffcard__undo"
          disabled={busy}
          title={t('agent.rewindHint')}
          onClick={() => void rewind()}
        >
          {busy ? t('agent.rewindBusy') : t('agent.rewind')}
        </button>
      </div>
      {note ? <div className="lr-diffcard__note">{note}</div> : null}
      {expanded && !diff.truncated ? (
        <div className="lr-diffcard__body lr-scroll">
          {diff.hunks.map((hunk, hunkIndex) => (
            <div className="lr-diffhunk" key={hunkIndex}>
              <div className="lr-diffhunk__head">
                <span>{'@@ -' + hunk.oldStart + ',' + hunk.oldLines + ' +' + hunk.newStart + ',' + hunk.newLines + ' @@'}</span>
                {/* 逐块回退：这是 VS Code "逐 hunk 接受/拒绝"在我们形态下的对应物 */}
                <button
                  className="lr-diffhunk__revert"
                  disabled={busy}
                  title={t('agent.hunkRevertHint')}
                  onClick={() => void revertOne(hunkIndex)}
                >
                  {t('agent.hunkRevert')}
                </button>
              </div>
              {hunk.rows.map((row, rowIndex) => (
                <div className="lr-diffrow" data-kind={row.kind} key={rowIndex}>
                  <span className="lr-diffrow__line">{row.kind === 'add' ? row.newLine : row.oldLine}</span>
                  <span className="lr-diffrow__sign">
                    {row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ' '}
                  </span>
                  <span className="lr-diffrow__text">{row.text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
      {diff.truncated ? <div className="lr-diffcard__note">{t('agent.diffTruncated')}</div> : null}
    </div>
  )
}

/** 历史会话的时间显示：今天只给时分，其它给月日。 */
function formatWhen(value: number | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const pad = (input: number): string => String(input).padStart(2, '0')
  if (sameDay) return pad(date.getHours()) + ':' + pad(date.getMinutes())
  return date.getMonth() + 1 + '/' + date.getDate()
}

/** 当前文档所在目录（没有打开文档时返回 null；工作目录由主进程按同一规则解析）。 */
function documentDirectory(): string | null {
  const tabs = useTabs.getState()
  const tab = tabs.activeTab()
  const docId = tab && (tab.kind === 'reader' || tab.kind === 'graph') ? tab.docId : null
  const model = docId ? useDocuments.getState().models[docId] ?? null : null
  if (!model?.filePath) return null
  const normalized = model.filePath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index > 0 ? normalized.slice(0, index) : null
}

/**
 * 计划审阅卡片（计划模式的收口）。
 *
 * 实测的链路（本机 SDK 0.3.286 / CLI 2.1.287）：
 *   进入计划模式 → 模型探索（只读）→ 写方案到 ~/.claude/plans/<name>.md
 *   → 在助手正文里给出方案 → 调 ExitPlanMode（**入参为空**）请求批准。
 * 所以"方案文字"只能从它前面的助手正文里取（主进程已把它挂在 plan-review 事件上）。
 *
 * 四个动作（用户要求"计划可由用户手动修改和手动取消"）：
 *   批准 = 放行 ExitPlanMode（CLI 会把权限模式切回 default，之后才允许改文件）；
 *   修改后批准 = 方案正文就地可编辑，改完按"编辑后的方案"发起新一轮（档位先切编辑自动）；
 *   让它继续完善 = 拦下这次调用，模型留在计划模式继续改方案；
 *   取消 = 关掉卡片，不批准不拒绝（挂起的权限请求照样收尾），留在计划模式继续对话。
 */
function PlanReviewCard({ plan }: { plan: { messageId: string; plan: string; filePath: string | null } }): JSX.Element {
  const { t } = useTranslation()
  const agent = useAgent()
  const [busy, setBusy] = useState(false)
  /**
   * 编辑态：null = 只读展示（初始），非 null = 用户点过"修改"、textarea 里是草稿。
   * 初值取模型给的原文 —— 用户想改的往往是"某几行"，从原文起步比空白框友好。
   */
  const [editing, setEditing] = useState<string | null>(null)
  const request = agent.permissions.find((item) => item.kind === 'plan')
  /**
   * 按钮文案里的 Agent 名字：以前写死成 "让 Claude 继续完善" ——
   * 换成 dsh / Codex 之后那句就成了错话（本轮实测：面板里跑的是 DeepSeek Harness，按钮还写着 Claude）。
   */
  const agentName = agent.agents.find((item) => item.id === agent.selectedAgentId)?.displayName ?? t('activity.agent')
  /**
   * 没有权限请求时（模型没调 ExitPlanMode 的兜底路径）也要能批准：
   * 那种情况下"批准"就是切档动手，不需要放行任何工具调用。
   */
  const decide = async (approve: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (approve) {
        if (request) await agent.approvePlan()
        else {
          useAgent.setState({ pendingPlan: null })
          await agent.setPermissionMode('edit')
        }
      } else {
        if (request) await agent.rejectPlan()
        else useAgent.setState({ pendingPlan: null })
      }
    } finally {
      setBusy(false)
    }
  }
  const approveEdited = async (): Promise<void> => {
    const edited = (editing ?? '').trim()
    if (edited.length === 0) return
    setBusy(true)
    try {
      await agent.approvePlanWithEdits(edited)
    } finally {
      setBusy(false)
    }
  }
  const dismiss = async (): Promise<void> => {
    setBusy(true)
    try {
      await agent.dismissPlan()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="lr-plancard">
      <div className="lr-plancard__head">
        <span className="lr-plancard__title">{t('agent.planTitle')}</span>
        {plan.filePath ? (
          <span className="lr-plancard__file" title={plan.filePath}>
            {plan.filePath.split(/[\\/]/).pop()}
          </span>
        ) : null}
      </div>
      {/* 方案正文按 markdown 渲染：模型给的就是 `###` / 表格 / 列表，源码直出等于没排版。
          编辑态切换成 textarea（等宽、随内容长高），"改几行"不需要进别的界面。 */}
      {editing === null ? (
        <div className="lr-plancard__body lr-scroll lr-selectable">
          {plan.plan ? <AgentMarkdown text={plan.plan} /> : t('agent.planEmpty')}
        </div>
      ) : (
        <textarea
          className="lr-plancard__edit lr-scroll"
          value={editing}
          rows={Math.min(20, Math.max(6, editing.split('\n').length + 2))}
          onChange={(event) => setEditing(event.target.value)}
          onKeyDown={(event) => {
            // Ctrl+Enter 直接按改后的方案执行；Esc 退出编辑（回到只读预览，改动丢弃前先回到预览再确认）
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              void approveEdited()
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              setEditing(null)
            }
          }}
          spellCheck={false}
        />
      )}
      <div className="lr-plancard__actions">
        {editing === null ? (
          <>
            <button className="lr-button" disabled={busy} onClick={() => void decide(true)}>
              {t('agent.planApprove')}
            </button>
            <button className="lr-button lr-button--secondary" disabled={busy} onClick={() => setEditing(plan.plan)}>
              {t('agent.planEdit')}
            </button>
            <button className="lr-button lr-button--secondary" disabled={busy} onClick={() => void decide(false)}>
              {t('agent.planReject', { name: agentName })}
            </button>
            <button className="lr-button lr-button--secondary" disabled={busy} onClick={() => void dismiss()}>
              {t('agent.planCancel')}
            </button>
          </>
        ) : (
          <>
            <button className="lr-button" disabled={busy || editing.trim().length === 0} onClick={() => void approveEdited()}>
              {t('agent.planApproveEdited')}
            </button>
            <button className="lr-button lr-button--secondary" disabled={busy} onClick={() => setEditing(null)}>
              {t('agent.planEditDiscard')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 子代理（Task 工具）的可观测性。
 *
 * 实测：子代理内部的工具调用与主线程**共用同一个消息流**，
 * 只能靠 `parentToolUseId`（`parent_tool_use_id`）区分。
 * 界面把同一子代理的调用挤成一行，点开才展开 —— 与 VS Code 的"子代理进度行"同一思路：
 * 主对话保持干净，需要时再钻进去看它干了什么。
 */
function subagentGroups(tools: ToolCallView[]): { parentId: string; tools: ToolCallView[] }[] {
  const groups = new Map<string, ToolCallView[]>()
  for (const tool of tools) {
    if (!tool.parentId) continue
    const list = groups.get(tool.parentId) ?? []
    list.push(tool)
    groups.set(tool.parentId, list)
  }
  return [...groups.entries()].map(([parentId, list]) => ({ parentId, tools: list }))
}

function SubagentRow({ parentId, tools }: { parentId: string; tools: ToolCallView[] }): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const running = tools.some((tool) => tool.state === 'running')
  const failed = tools.some((tool) => tool.state === 'error')
  const last = tools[tools.length - 1]
  const summary = last ? toolSummary(last) || toolDisplayName(last.name) : ''
  return (
    <div className="lr-subagent" data-state={running ? 'running' : failed ? 'error' : 'done'}>
      <button className="lr-subagent__head" onClick={() => setOpen((value) => !value)}>
        {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        <span className="lr-subagent__dot" aria-hidden="true" />
        <span className="lr-subagent__label">{t('agent.subagent')}</span>
        <span className="lr-subagent__count">{t('agent.subagentSteps', { count: tools.length })}</span>
        {!open && summary ? <span className="lr-subagent__summary">{summary}</span> : null}
        <span className="lr-subagent__state">
          {running ? t('agent.toolRunning') : failed ? t('common.error') : ''}
        </span>
      </button>
      {open ? (
        <div className="lr-subagent__body">
          {tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function toolDisplayName(name: string): string {
  const value = (name || 'tool').replace(/[_-]+/g, ' ')
  return value
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function toolSummary(tool: ToolCallView): string {
  const raw = tool.title && tool.title !== tool.name ? tool.title : ''
  if (raw.length > 0) return raw.slice(0, 120)
  const input = tool.input as Record<string, unknown> | null | undefined
  if (input && typeof input === 'object') {
    for (const key of ['command', 'file_path', 'filePath', 'path', 'pattern', 'query', 'url']) {
      const value = input[key]
      if (typeof value === 'string' && value.length > 0) return value.slice(0, 120)
    }
  }
  return ''
}

function PermissionCard({
  permission,
  onRespond
}: {
  permission: PermissionRequest
  onRespond: (requestId: string, optionId: string | null) => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="lr-permission">
      <div className="lr-permission__title">{t('agent.permissionTitle', { agent: permission.title })}</div>
      <pre className="lr-permission__detail">{JSON.stringify(permission.rawInput, null, 2).slice(0, 600)}</pre>
      <div className="lr-permission__actions">
        {permission.options.map((option) => (
          <button
            key={option.optionId}
            className="lr-button lr-button--secondary"
            onClick={() => onRespond(permission.requestId, option.optionId)}
          >
            {option.kind === 'allow_once'
              ? t('agent.permissionAllowOnce')
              : option.kind === 'allow_always'
                ? t('agent.permissionAllowAlways')
                : option.kind === 'reject_once' || option.kind === 'reject_always'
                  ? t('agent.permissionDeny')
                  : option.name}
          </button>
        ))}
        <button className="lr-button lr-button--secondary" onClick={() => onRespond(permission.requestId, null)}>
          {t('agent.permissionDeny')}
        </button>
      </div>
    </div>
  )
}
