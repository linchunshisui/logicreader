/**
 * Agent 授权模式（Permission Mode）—— 纯策略模块，主进程与渲染进程共用。
 *
 * 为什么要有这一层：
 *  「允许写文件 / 允许执行命令」过去只有两个全局开关（settings.agent.allowWrite / allowExecute），
 *  默认都是 false，于是**任何**写操作都会被静默拒绝 —— 界面上连一张权限卡片都看不到，
 *  用户只会看到 Agent"什么都没做"。参考 Claude Code 的做法，把"授权粒度"做成会话级模式：
 *  默认最保守，用户显式升级；每一次自动放行都必须能说出理由，并且同步给用户。
 *
 * 设计约束（改动前先读）：
 *  1. 本文件**不做 IO、不读设置、不碰 DOM**，只根据入参给出判定 —— 这样单测可以穷举矩阵。
 *  2. 主进程与渲染进程都调它，判定结果必须一致；两侧不允许各写一套 if。
 *  3. 危险命令列表是**保守**的：宁可多问一次，也不许悄悄执行。
 */
export type PermissionMode = 'manual' | 'plan' | 'edit' | 'auto'

/**
 * 界面上的展示顺序：与参考实现一致 —— 手动 → 自动编辑 → 计划 → 自动。
 * 最保守的排第一，最放手的排最后；把"自动"放在末尾是有意的：
 * 它是唯一会替用户做决定的档位，放在列表尽头可以少一次误点。
 */
export const PERMISSION_MODES: PermissionMode[] = ['manual', 'edit', 'plan', 'auto']

/** 最保守的一档，也是新会话的默认值。 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'manual'

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as string[]).includes(value)
}

export function normalizePermissionMode(value: unknown): PermissionMode {
  return isPermissionMode(value) ? value : DEFAULT_PERMISSION_MODE
}

/* ------------------------------------------------------------------ 各通道自己的档位
 *
 * 上面那四个档是**我们客户端**的放行策略（决定怎么应答 Agent 的授权请求、握手时声明什么能力位）。
 * 但每个 Agent 工具**自己**有什么档位，是协议决定的，三者完全不同（离线探针实测，2026-10-04）：
 *
 *   Claude Code（官方 SDK）  原生就有授权模式，而且可以在**活动会话**上直接切
 *                            （`query.setPermissionMode()`，不重建会话）
 *   Codex（官方 app-server） 有「审批策略 + 沙箱」两个维度，但只能在 `thread/start` 时指定，
 *                            中途改不了（没有 set 接口）→ 切档必须重建线程
 *   DeepSeek Harness（ACP）  **完全没有**：`session/new` 只回 `{sessionId, configOptions}`，
 *                            configOptions 只有 model / reasoning_effort；`session/set_mode`
 *                            直接 `-32601 Method not found`（见 scripts/probe-dsh-acp.mjs）
 *
 * 所以界面**不能**拿一套 Claude 味的档位去套所有 Agent：上限来自协议，不是本程序的缺陷（ARCHITECTURE §1.10c）。
 * 这里把"每个通道真实提供什么"写成数据，主进程（适配器）与渲染进程（控件）共用同一份。
 */

/** 档位候选项：值用**协议原文**，名字/说明由界面按 `agent.permission.<控件 id>.<值>` 本地化。 */
export interface PermissionControlOption {
  value: string
  /** 协议侧的中立名称（界面找不到本地化文案时用它） */
  name: string
}

/** 某个通道真实提供的授权控制项。 */
export interface PermissionControl {
  /** 协议侧标识：`permissionMode`（SDK）/ `approvalPolicy` / `sandbox`（Codex） */
  id: string
  /** 控件标题的协议中立写法（界面优先用 `agent.permission.<id>.name`） */
  name: string
  options: PermissionControlOption[]
  /**
   * 默认值。**必须显式给**，不能"取第一项"：
   * 选项列表按"最保守在前"排列（与那四个档的展示顺序一致），但默认值要保住既有行为 ——
   * 例：Codex 的沙箱默认 `workspace-write`（工作区内可写、每次仍要审批），
   * 若默认成 `read-only`，等于把"能写但要批"悄悄降级成"根本写不了"，用户还没法通过卡片批准。
   */
  defaultValue: string
  /** 改这一项要不要重建会话/线程（false = 协议支持在活动会话上直接切） */
  rebuild: boolean
}

/** Claude Code（官方 SDK）：原生授权模式，可在活动会话上直接切。 */
export const SDK_PERMISSION_CONTROLS: PermissionControl[] = [
  {
    id: 'permissionMode',
    name: 'Permission mode',
    rebuild: false,
    defaultValue: DEFAULT_PERMISSION_MODE,
    options: PERMISSION_MODES.map((mode) => ({ value: mode, name: mode }))
  }
]

/**
 * Codex（官方 app-server）：审批策略 + 沙箱。
 *
 * 只列适配器**真的会发出去**的两组值（`thread/start` 的 `approvalPolicy` / `sandbox`）——
 * 列一个发不出去的档位等于骗用户。
 */
export const CODEX_PERMISSION_CONTROLS: PermissionControl[] = [
  {
    id: 'approvalPolicy',
    name: 'Approval policy',
    rebuild: true,
    // 默认"每次询问"（最保守的那一档，也是旧行为）
    defaultValue: 'untrusted',
    options: [
      { value: 'untrusted', name: 'untrusted' },
      { value: 'on-request', name: 'on-request' }
    ]
  },
  {
    id: 'sandbox',
    name: 'Sandbox',
    rebuild: true,
    // 默认沿用旧行为（可写工作区、由审批把关）；只读排在第一项只是展示顺序
    defaultValue: 'workspace-write',
    options: [
      { value: 'read-only', name: 'read-only' },
      { value: 'workspace-write', name: 'workspace-write' }
    ]
  }
]

/** 协议 → 它真实提供的控制项；没有档位概念的通道（ACP / mock）是空数组。 */
export function permissionControlsOf(protocol: string): PermissionControl[] {
  if (protocol === 'sdk' || protocol === 'claude-code') return SDK_PERMISSION_CONTROLS
  if (protocol === 'app-server' || protocol === 'codex') return CODEX_PERMISSION_CONTROLS
  return []
}

/** 某个控制项的默认值（取显式声明的那一项，见 `PermissionControl.defaultValue`）。 */
export function defaultControlValues(controls: PermissionControl[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const control of controls) out[control.id] = control.defaultValue
  return out
}

/**
 * 把"通道自己的档位"折算成**我们客户端**的放行策略（纯函数，单测覆盖）。
 *
 * 为什么要折算：`decidePermission`（怎么应答授权请求）与握手能力位（能不能写/执行）
 * 只有一份判定，它吃的是 `PermissionMode`；而用户在界面上拨的是各协议自己的旋钮。
 * 两者由一个函数对齐，否则"界面选了只读、客户端却仍放行写入"这类错会散在各处。
 *
 * - SDK：控制项本身就是那四个档（一一对应）
 * - Codex：沙箱只读 → `plan`（不许改任何东西）；可写 + 审批 `untrusted` → `manual`（每次都问）；
 *          可写 + `on-request` → `edit`（工作区内写入放行，命令仍问）
 * - ACP / mock：协议没有档位 → 直接用界面上的「客户端放行策略」
 */
export function policyFromControls(
  protocol: string,
  clientPolicy: PermissionMode,
  values: Record<string, string | undefined>
): PermissionMode {
  if (protocol === 'sdk' || protocol === 'claude-code') {
    return normalizePermissionMode(values.permissionMode ?? clientPolicy)
  }
  if (protocol === 'app-server' || protocol === 'codex') {
    if (values.sandbox === 'read-only') return 'plan'
    if (values.approvalPolicy === 'untrusted') return 'manual'
    return 'edit'
  }
  return normalizePermissionMode(clientPolicy)
}

/** 会话内由界面维护的授权策略。 */
export interface PermissionPolicy {
  mode: PermissionMode
  /** Agent 的工作目录（写入判定的依据）。为空表示"未限定工作区"。 */
  workspaceDir?: string | null
  /** 用户在设置里显式放行的目录白名单（非空时是硬约束，任何模式都不得越过）。 */
  allowedWriteDirs?: string[]
}

/** ACP 权限请求里与本策略有关的部分（与主进程 PermissionDetail 结构兼容）。 */
export interface PermissionSubject {
  title?: string
  kind?: string
  /** 请求的原文（命令、路径、工具参数…），用于输出证据。 */
  rawInput?: unknown
  /** Agent 给出的候选选项。为空表示"这不是一次授权询问"。 */
  options?: { kind?: string }[]
}

export interface PermissionDecision {
  /** true = 自动放行；false = 自动拒绝（连授权卡片都不弹）。 */
  autoRespond: boolean
  /** 放行时给 Agent 的选项 id（由调用方从候选里挑），拒绝时为 null。 */
  allow: boolean
  /** 判定理由，写进日志 —— 自动放行必须留痕。 */
  reason: string
  /** 从请求里抽出的证据（命令 / 路径），显示给用户。 */
  evidence: string
}

/** 不构成"写 / 执行"的权限类别：读文件、搜索、思考等，任何模式都直接放行。 */
const READ_KINDS = new Set(['read', 'search', 'fetch', 'think', 'other'])

export type PermissionClass = 'read' | 'write' | 'execute' | 'unknown'

export function classifyPermission(kind: string | undefined): PermissionClass {
  const value = (kind ?? '').toLowerCase()
  if (value === '') return 'unknown'
  if (READ_KINDS.has(value)) return 'read'
  if (value.includes('write') || value.includes('edit') || value.includes('delete')) return 'write'
  if (value.includes('execute') || value.includes('command') || value.includes('terminal') || value.includes('shell')) {
    return 'execute'
  }
  return 'unknown'
}

/** 危险命令：即使处在自动档也**必须**问用户。宁可多问一次，不许悄悄执行。 */
const DANGEROUS_COMMAND = [
  /\brm\s+-[a-z]*[rf]/i, // rm -rf / rm -fr
  /\brm\s+-[a-z]*r[a-z]*\s+[~/]/i, // rm -r ~/...
  /\bdel\s+\/[a-z]*[sqf]/i, // del /s /q /f
  /\brd\s+\/s/i, // rd /s
  /\brmdir\s+\/s/i,
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bmkfs\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\breg\s+(add|delete|import|restore)\b/i,
  /\btaskkill\b[^\n]*\/f/i,
  /\bgit\s+push\b[^\n]*\s(--force|-f)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bnpm\s+publish\b/i,
  /\bpip\s+(install|uninstall)\b/i,
  /\bcurl\b[^\n]*\|\s*(ba)?sh\b/i,
  /\b(iwr|invoke-webrequest)\b[^\n]*\|\s*(iex|invoke-expression)/i,
  /\bchmod\s+(-R\s+)?777\b/i,
  /\bdd\s+if=/i,
  /\b:\\?\s*\(\s*\)\s*\{.*\}\s*;?\s*:/, // :(){ :|:& };: fork bomb
  /\bRemove-Item\b[^\n]*-Recurse[^\n]*-Force/i
]

/** 从原始输入里拼出"人话证据"。 */
export function permissionEvidence(rawInput: unknown): string {
  if (typeof rawInput === 'string') return rawInput
  if (!rawInput || typeof rawInput !== 'object') return ''
  const record = rawInput as Record<string, unknown>
  const keys = ['command', 'cmd', 'path', 'file_path', 'filePath', 'target', 'url', 'pattern', 'query']
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && value.length > 0 && key !== 'description') return value
  }
  return ''
}

/** 命令是否命中危险列表。 */
export function findDangerousPattern(evidence: string): string | null {
  if (evidence.length === 0) return null
  for (const pattern of DANGEROUS_COMMAND) {
    const matched = pattern.exec(evidence)
    if (matched) return matched[0]
  }
  return null
}

/** 目标是否位于工作区内（含工作区自身）。工作区未限定时不做判断。 */
function isInside(target: string, workspaceDir: string | null | undefined): boolean {
  if (!workspaceDir) return true
  const base = workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  if (base.length === 0) return true
  const value = target.replace(/\\/g, '/').toLowerCase()
  return value === base || value.startsWith(base + '/')
}

/** 是否越出工作区（用于命令参数里的裸路径）。 */
function looksOutside(value: string, workspaceDir: string | null | undefined): boolean {
  const normalized = value.replace(/\\/g, '/')
  if (normalized.includes('..')) return true
  if (!workspaceDir) return false
  const base = workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  if (base.length === 0) return false
  const tokens = normalized.split(/[\s"'|;&()<>]+/).filter((token) => token.length > 0)
  for (const token of tokens) {
    const plain = token.replace(/^[a-z]+=/, '')
    if (!/^([a-z]:\/|\/|~)/i.test(plain)) continue
    if (plain.toLowerCase().startsWith(base + '/') || plain.toLowerCase() === base) continue
    return true
  }
  return false
}

/** 写入目标是否在白名单内（白名单为空 = 不限制）。 */
function writeTargetAllowed(path: string | null, allowedWriteDirs: string[] | undefined): boolean {
  if (!allowedWriteDirs || allowedWriteDirs.length === 0) return true
  if (!path) return false
  const target = path.replace(/\\/g, '/').toLowerCase()
  return allowedWriteDirs.some((dir) => {
    const base = dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    return base.length > 0 && (target === base || target.startsWith(base + '/'))
  })
}

export interface PermissionDecisionInput {
  policy: PermissionPolicy
  subject: PermissionSubject
}

/**
 * 单一判定入口。
 *
 * 返回 `autoRespond: false` 表示"这一票交给人"——调用方弹卡片等待用户；
 * 返回 `autoRespond: true` 则由调用方立即应答，并把 reason 写进日志。
 */
export function decidePermission(input: PermissionDecisionInput): PermissionDecision {
  const { policy, subject } = input
  const mode = normalizePermissionMode(policy.mode)
  const kind = classifyPermission(subject.kind)
  const evidence = permissionEvidence(subject.rawInput)
  const base = { autoRespond: true, evidence }

  if (kind === 'read') {
    return { ...base, allow: true, reason: '只读操作，任何授权模式都放行' }
  }

  const raw = evidence.replace(/\\/g, '/')
  const dangerous = findDangerousPattern(evidence)

  if (mode === 'manual') {
    return { ...base, allow: false, autoRespond: false, reason: '手动模式：写操作与命令一律由用户确认' }
  }

  if (mode === 'plan') {
    // 计划模式是"只读 + 先出方案"：任何改动都不放行，让用户先看计划
    return { ...base, allow: false, reason: '计划模式：不执行改动（拒绝 ' + (kind === 'execute' ? '命令' : '写入') + '）' }
  }

  if (kind === 'write') {
    const absolute = /^([a-z]:\/|\/)/i.test(raw) ? evidence : null
    if (raw.includes('..')) {
      return { ...base, allow: false, reason: '写入目标含上级目录跳转，已拒绝：' + evidence }
    }
    if (absolute && !isInside(absolute, policy.workspaceDir)) {
      return { ...base, allow: false, reason: '写入目标在工作区之外，已拒绝：' + evidence }
    }
    if (!writeTargetAllowed(absolute, policy.allowedWriteDirs)) {
      return { ...base, allow: false, reason: '写入目标不在设置的白名单目录内：' + evidence }
    }
    return { ...base, allow: true, reason: '编辑自动放行（工作区内写入）：' + (evidence || subject.title || '') }
  }

  if (kind === 'execute') {
    if (dangerous) {
      return { ...base, allow: false, autoRespond: false, reason: '命令命中危险列表（' + dangerous + '），交用户确认' }
    }
    if (mode === 'edit') {
      return { ...base, allow: false, autoRespond: false, reason: '编辑自动模式：命令仍由用户确认' }
    }
    if (looksOutside(raw, policy.workspaceDir)) {
      return { ...base, allow: false, autoRespond: false, reason: '命令涉及工作区之外的路径，交用户确认：' + evidence }
    }
    return { ...base, allow: true, reason: '安全检查通过的无害命令：' + (evidence || subject.title || '') }
  }

  // 未知类别：不猜，交给人
  return { ...base, allow: false, autoRespond: false, reason: '未知操作类别，交用户确认：' + (subject.kind ?? '') }
}

/** 计划模式附加给 Agent 的行为约定（由渲染进程拼进 systemContext）。 */
export function planModeReminder(locale: 'zh-CN' | 'en-US'): string {
  if (locale === 'en-US') {
    return [
      '[Permission mode: plan]',
      '- First judge whether this task actually needs a plan. Read-only requests (explain, search, summarize, answer) get a direct answer — do not invent steps or a plan just to follow a process.',
      '- Only when the user asks you to change files/run commands, or the work genuinely takes several steps with trade-offs, present a short ordered plan (goal, steps, files to touch, risks) and stop for approval.',
      '- Do not modify files and do not run state-changing commands.',
    ].join('\n')
  }
  return [
    '【授权模式：计划】',
    '- 先判断这个任务**是否真的需要计划**：只是解释、检索、总结、回答这类**只读**请求，就直接给出结论，不要编步骤、也不要为了走流程而写方案；',
    '- 只有当用户要求你改动文件 / 执行命令，或这件事确实分多步且有取舍时，才先给出简短有序的方案（目标、步骤、会改到哪些文件、风险），然后停下等用户确认；',
    '- 不要修改文件，也不要执行会改变状态的命令；',
  ].join('\n')
}

/**
 * 这段回答**看起来像一份方案**吗？（计划模式下的兜底判定；纯函数、有单测）
 *
 * 用途：有些通道（ACP / CLI）的模型不会调 `ExitPlanMode`，界面以前的兜底是
 * "这一轮结束就把最后一段回答当成方案弹卡片" —— 于是**任何**回答都会变成待批准计划
 * （用户对计划模式"死板"的直接观感就是这么来的）。
 * 现在只在回答确实长得像方案时才弹：
 *  1. 太短的不算（< 40 字：一两句话的答复不是方案）；
 *  2. 带"方案 / 计划 / 步骤 / 实施 / 打算 / Plan / Approach / Steps"这类小标题的算；
 *  3. 或者有明显分步结构（≥3 条列表）且正文里出现"步骤 / 阶段 / 先…再"这类词。
 *
 * 长度阈值只卡"分步结构"那一条分支：中文很密，一段 100 字的方案已经写全了目标与三步，
 * 拿英文的长度直觉（120+）去卡会把真方案判成普通回答（第一版就是这么翻车的，有单测兜着）。
 */
export function looksLikePlan(text: string): boolean {
  const body = (text ?? '').trim()
  if (body.length < 40) return false
  if (/^#{1,4}\s*.*?(方案|计划|步骤|实施|打算|Plan|Approach|Steps|Implementation)/im.test(body)) return true
  const bullets = body.match(/^\s*(?:\d+[.)、]|[-*])\s+/gm) ?? []
  return body.length >= 80 && bullets.length >= 3 && /(步骤|阶段|第一步|Step\s*1|先.{0,12}再)/i.test(body)
}

/**
 * 把"当前授权边界"告诉模型的一句话。
 * 计划模式写成硬约束（它决定模型是否直接动手），其余模式只描述边界，
 * 目的是让模型不要反复尝试已被拒绝的操作。
 */
export function permissionModeReminder(mode: PermissionMode, locale: 'zh-CN' | 'en-US'): string | null {
  if (mode === 'plan') return planModeReminder(locale)
  if (locale === 'en-US') {
    if (mode === 'auto') {
      return '[Permission mode: auto] Writes inside the workspace and safe commands are pre-approved; risky operations are paused for the user.'
    }
    if (mode === 'edit') {
      return '[Permission mode: edit] File edits are pre-approved; running commands still needs the user, except in auto mode.'
    }
    return null
  }
  if (mode === 'auto') {
    return '【授权模式：自动】工作区内的文件写入与安全检查通过的命令已获授权；遇到风险操作会停下来问你。'
  }
  if (mode === 'edit') {
    return '【授权模式：编辑自动】文件编辑已获授权；执行命令仍需用户确认。'
  }
  return null
}
