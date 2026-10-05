import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { RequestPermissionOutcome, SessionUpdate } from '@agentclientprotocol/sdk'
import {
  ACP_PROTOCOL_VERSION,
  buildNewSessionParams,
  buildPromptParams,
  buildSetConfigOptionParams
} from './acp'

/**
 * ACP 协议对账：把我们手写的客户端与官方 SDK 声明的协议钉在一起。
 *
 * **为什么这个文件在 `apps/main/src/` 下而不是 `tests/`**：`tests/` 不在任何 tsconfig 的
 * `include` 里，那里的类型断言会被 esbuild 直接抹掉、`pnpm typecheck` 根本不看。
 * 只有 `apps/` 与 `packages/<每个包>/src/` 过 tsc，所以"编译期断言"必须放在这两处之一。
 *
 * 手写客户端最贵的毛病不是"报错"，而是**字段名/判别值悄悄对不上**：Agent 那边发了、
 * 我们这边读不到，表现为某块功能静默失灵，日志里也看不出问题。这个文件就是防这个。
 */

/** 官方 union 里全部 sessionUpdate 判别值（类型层面）。 */
type OfficialUpdateKind = SessionUpdate['sessionUpdate']

/**
 * 客户端用 `switch (kind)` 分派的判别值。
 *
 * 声明成 `OfficialUpdateKind[]` 本身就是断言：官方 union 里没有这个名字，这行**编译不过**。
 * 下面的用例把它与 `acp.ts` 源码里的 `case` 逐个对齐 —— 两边不许不同步。
 */
const DISPATCHED_CASE_KINDS: OfficialUpdateKind[] = [
  'agent_message_chunk',
  'agent_thought_chunk',
  'user_message_chunk',
  'tool_call',
  'tool_call_update',
  'plan'
]

/**
 * 客户端在 `default` 分支里额外比较的判别值。
 *
 * 为什么不放在上面的清单里：它们**不是 `case`**，`sessionUpdate` 是官方后来加的，
 * 客户端用 `if (kind === ...)` 兜住，免得老实现把未知类型当错误。
 */
const DEFAULT_BRANCH_STANDARD_KINDS: OfficialUpdateKind[] = ['usage_update']

/**
 * 连官方 union 都没有、但客户端仍容忍的名字。
 *
 * `usage` 是某些实现的非标变体（官方叫 `usage_update`）。显式列出来，是为了让
 * "我们在容忍一个非标名字"这件事**写在明面上**，而不是藏在 default 分支里没人知道。
 */
const DEFAULT_BRANCH_NON_STANDARD_KINDS = ['usage']

const acpSource = readFileSync(resolve(__dirname, 'acp.ts'), 'utf8')

/** 源码里 `case '<kind>':` 的判别值 */
function caseKindsInSource(): string[] {
  return Array.from(acpSource.matchAll(/case '([a-z_]+)':/g)).map((match) => match[1])
}

/** 源码里 `kind === '<kind>'` 的比较值（default 分支用的那种） */
function comparedKindsInSource(): string[] {
  return Array.from(acpSource.matchAll(/kind === '([a-z_]+)'/g)).map((match) => match[1])
}

describe('协议版本', () => {
  it('本地常量与官方 SDK 一致', () => {
    expect(ACP_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION)
  })
})

describe('出站报文形状（纯函数 + 官方类型）', () => {
  /**
   * 这些断言的强度来自**函数的返回类型声明在 acp.ts 里**（`SetSessionConfigOptionRequest` 等）：
   * 字段名写错，`pnpm typecheck` 就红。这里再验一次"运行时的值真的长那样"。
   */
  it('session/set_config_option：布尔分支必须带 type，字符串分支不带', () => {
    const boolParams = buildSetConfigOptionParams('s1', 'autoApprove', true)
    expect(boolParams).toEqual({ sessionId: 's1', configId: 'autoApprove', value: true, type: 'boolean' })

    const strParams = buildSetConfigOptionParams('s1', 'model', '["deepseek-official","v4"]')
    expect(strParams).toEqual({ sessionId: 's1', configId: 'model', value: '["deepseek-official","v4"]' })
    expect('type' in strParams).toBe(false)
  })

  it('session/prompt：prompt 是 text 内容块数组', () => {
    const params = buildPromptParams('s1', '这段话在说什么？')
    expect(params.sessionId).toBe('s1')
    expect(params.prompt).toEqual([{ type: 'text', text: '这段话在说什么？' }])
  })

  it('session/new：cwd 是必填项', () => {
    const params = buildNewSessionParams('D:/docs', [])
    expect(params.cwd).toBe('D:/docs')
    expect(params.mcpServers).toEqual([])
  })

  it('权限应答的两个分支都是合法的 RequestPermissionOutcome', () => {
    // 与 acp.ts 里 handleRequest('session/request_permission') 拼的那两份一致
    const selected: RequestPermissionOutcome = { outcome: 'selected', optionId: 'allow-once' }
    const cancelled: RequestPermissionOutcome = { outcome: 'cancelled' }
    expect(selected).toEqual({ outcome: 'selected', optionId: 'allow-once' })
    expect(cancelled).toEqual({ outcome: 'cancelled' })
  })
})

describe('入站判别值与客户端分派保持一致', () => {
  it('源码里每个 case 判别值都在受检清单里（新增 case 会在这里失败）', () => {
    // 带斜杠的方法名（如 'session/request_permission'）不会被这个正则匹配到，正好只留会话更新
    expect(Array.from(new Set(caseKindsInSource())).sort()).toEqual([...DISPATCHED_CASE_KINDS].sort())
  })

  it('default 分支里比较的判别值也被钉住', () => {
    const expected = [...DEFAULT_BRANCH_STANDARD_KINDS, ...DEFAULT_BRANCH_NON_STANDARD_KINDS].sort()
    expect(Array.from(new Set(comparedKindsInSource())).sort()).toEqual(expected)
  })

  it('受检清单非空（"是官方判别值"由编译期保证）', () => {
    expect(DISPATCHED_CASE_KINDS.length).toBeGreaterThan(0)
    expect(DEFAULT_BRANCH_STANDARD_KINDS.length).toBeGreaterThan(0)
    for (const kind of DISPATCHED_CASE_KINDS) expect(typeof kind).toBe('string')
  })

  it('被容忍的非标判别值与官方清单不相交', () => {
    for (const kind of DEFAULT_BRANCH_NON_STANDARD_KINDS) {
      expect(DISPATCHED_CASE_KINDS as string[]).not.toContain(kind)
      expect(DEFAULT_BRANCH_STANDARD_KINDS as string[]).not.toContain(kind)
    }
  })
})
