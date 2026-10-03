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
