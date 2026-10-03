/**
 * 对着**真实 dsh** 的 ACP 端到端验证（默认跳过）。
 *
 * 为什么默认跳过：它要真的启动 DeepSeek Harness 的 ACP 服务，而 `session/new` 会在用户的
 * DSH 配置目录里**留下一个空会话记录**（ACP 没有删除会话的方法）。所以只在显式打开时才跑：
 *
 * ```powershell
 * $env:LR_DSH_LIVE='1'; $env:LR_DSH_CMD='D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
 * pnpm exec vitest run tests/dsh-live.test.ts
 * ```
 *
 * 它验证的是**本仓库自己的链路**：shim 解析 → spawn（不走 shell）→ AcpClient 握手 →
 * 配置项取值编码 → session/close。这些单测覆盖不到的部分，正是"装了 dsh 却用不起来"的高发区。
 */
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AcpClient } from '../apps/main/src/services/agent/acp'
import { fullLaunchArgs } from '../apps/main/src/services/agent/cli'
import { encodeConfigValue } from '../apps/main/src/services/agent/config-value'
import { killTree, readVersion, resolveAgentExecutable, spawnAgent } from '../apps/main/src/services/agent/exec'
import { AcpSession } from '../apps/main/src/services/agent/session'
import type { ConfigOption } from '../apps/main/src/services/agent/types'

const shim =
  process.env.LR_DSH_CMD ?? 'D:\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd'
const live = process.env.LR_DSH_LIVE === '1' && process.platform === 'win32' && existsSync(shim)

describe.skipIf(!live)('真实 dsh：解析出来的启动方式', () => {
  it('解析成"自带 Electron + --expose-internals + cli.js"，并带 ELECTRON_RUN_AS_NODE', async () => {
    const resolved = await resolveAgentExecutable('dsh', shim)
    expect(resolved.error).toBeNull()
    expect(resolved.command.toLowerCase()).toContain('deepseek harness.exe')
    expect(resolved.prefixArgs[0]).toBe('--expose-internals')
    expect(resolved.prefixArgs[1].toLowerCase()).toContain('dsh-desktop-host')
    expect(resolved.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('不给路径也能自己找到：靠卸载表里的安装位置（dsh 桌面端没把命令加进 PATH）', async () => {
    const resolved = await resolveAgentExecutable('dsh', null)
    expect(resolved.error).toBeNull()
    expect(resolved.source?.toLowerCase()).toContain('dsh.cmd')
    expect(resolved.command.toLowerCase()).toContain('deepseek harness.exe')
    expect(resolved.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('版本探测走的就是注册表探测那条路（能读出 0.2.x，而不是 N/A）', async () => {
    const resolved = await resolveAgentExecutable('dsh', null)
    const version = await readVersion(resolved.command, [...resolved.prefixArgs, '--version'], process.cwd(), resolved.env)
    expect(version).toMatch(/^\d+\.\d+\./)
  })
})

describe.skipIf(!live)('真实 dsh：ACP 全链路', () => {
  it(
    'initialize → session/new（拿到 model 路由与 reasoning_effort）→ set_config_option → session/close',
    async () => {
      const resolved = await resolveAgentExecutable('dsh', shim)
      const child = spawnAgent(resolved.command, [...resolved.prefixArgs, '--profile', 'acp'], {
        cwd: process.cwd(),
        env: resolved.env,
        timeoutMs: 0
      })
      const client = new AcpClient({
        child,
        onEvent: () => undefined,
        requestPermission: async () => null,
        readTextFile: async () => '',
        writeTextFile: async () => undefined,
        allowWrite: false,
        timeoutMs: 30000
      })
      try {
        const init = await client.initialize({ fs: { readTextFile: true, writeTextFile: false }, terminal: false })
        expect(JSON.stringify(init)).toContain('deepseek-harness-acp')

        const created = await client.newSession(process.cwd())
        expect(created.sessionId.length).toBeGreaterThan(0)
        const options = created.configOptions ?? []
        const model = options.find((option) => option.id === 'model')
        const effort = options.find((option) => option.id === 'reasoning_effort')
        // dsh 的 model 是 [provider, model] 路由，**以 JSON 字符串形态**回给我们（实测 0.2.0-rc.2）
        expect(String(model?.currentValue)).toBe('["deepseek-official","deepseek-v4-flash"]')
        expect((effort?.options ?? []).map((item) => item.value)).toEqual(['off', 'low', 'high', 'max'])

        // 关键回归：裸模型名会被回 "unknown model option"，必须编码成 JSON 字符串
        const applied = await client.setConfigOption(created.sessionId, 'model', encodeConfigValue(model as ConfigOption, 'deepseek-v4-pro'))
        const next = applied?.find((option) => option.id === 'model')
        expect(String(next?.currentValue)).toBe('["deepseek-official","deepseek-v4-pro"]')

        await client.closeSession(created.sessionId)
      } finally {
        client.dispose()
        killTree(child)
      }
    },
    90000
  )
})

describe.skipIf(!live)('真实 dsh：走程序自己的 AcpSession', () => {
  it(
    'AcpSession.create 能建会话、能改模型、dispose 会走 session/close',
    async () => {
      const resolved = await resolveAgentExecutable('dsh', null)
      const registrationArgs = ['--profile', 'acp']
      const session = await AcpSession.create({
        sessionId: 'sess_live_test',
        executable: resolved.command,
        args: fullLaunchArgs([...resolved.prefixArgs, ...registrationArgs], registrationArgs),
        options: {
          sessionId: 'sess_live_test',
          agentId: 'dsh',
          cwd: process.cwd(),
          contextMode: 'fulltext',
          env: resolved.env,
          modelId: 'deepseek-v4-flash',
          thinkingEffort: 'high'
        },
        onEvent: () => undefined,
        allowWrite: false,
        requestPermission: async () => null,
        readTextFile: async () => '',
        writeTextFile: async () => undefined
      })
      // 建会话时就应用了模型与档位：拿回来的配置项应当是"路由 + high"
      const options = session.options
      const model = options.find((item) => item.id === 'model')
      expect(String(model?.currentValue)).toBe('["deepseek-official","deepseek-v4-flash"]')
      expect(String(options.find((item) => item.id === 'reasoning_effort')?.currentValue)).toBe('high')
      expect(session.remoteSessionId).toBeTruthy()
      await session.dispose()
    },
    90000
  )
})
