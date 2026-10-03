import { describe, expect, it } from 'vitest'
import { CLI_SPECS, cliLaunchPrefix, fullLaunchArgs } from '../apps/main/src/services/agent/cli'
import { FALLBACK_MODELS } from '../apps/main/src/services/agent/fallback-models'
import { cmdCommandArgs, parseShimContent } from '../apps/main/src/services/agent/exec'
import { describeConfigValue, encodeConfigValue, parseModelRoute } from '../apps/main/src/services/agent/config-value'
import {
  defaultAgentEnv,
  mergeAgentEnv,
  resolveAgentEnv,
  resolveEnvValue,
  SECRET_PREFIX
} from '../apps/main/src/services/agent/env'
import { DEEPSEEK_API_KEY_ENV, DEEPSEEK_API_KEY_SECRET } from '@logicreader/shared'

const secrets: Record<string, string> = { [DEEPSEEK_API_KEY_SECRET]: 'sk-test-key' }
const getSecret = (key: string): string | null => secrets[key] ?? null

describe('CLI 兜底：启动参数不许出现两个 --profile', () => {
  it('把注册表里给 ACP 用的参数从尾部摘掉，解释器前缀保留', () => {
    expect(cliLaunchPrefix(['node', 'C:/dsh/bin.js', '--profile', 'acp'], ['--profile', 'acp'])).toEqual([
      'node',
      'C:/dsh/bin.js'
    ])
  })

  it('没有注册参数时原样返回（Claude / Codex 的兜底通道不受影响）', () => {
    expect(cliLaunchPrefix(['/usr/local/bin/claude'], [])).toEqual(['/usr/local/bin/claude'])
  })

  it('尾部对不上时不做猜测，原样返回', () => {
    expect(cliLaunchPrefix(['node', 'bin.js', '--verbose'], ['--profile', 'acp'])).toEqual([
      'node',
      'bin.js',
      '--verbose'
    ])
  })

  it('拼出来的一次性命令只有一个 --profile（dsh 的启动器对重复项直接报错）', () => {
    const registrationArgs = ['--profile', 'acp']
    const launchArgs = ['node', 'C:/dsh/bin.js', ...registrationArgs]
    const spec = CLI_SPECS.dsh
    const args = [
      ...cliLaunchPrefix(launchArgs, registrationArgs),
      ...spec.buildArgs({ text: '读一下这份文档' }, { agentId: 'dsh', cwd: 'D:/docs', contextMode: 'fulltext' })
    ]
    expect(args.filter((value) => value === '--profile')).toHaveLength(1)
    expect(args).toEqual(['node', 'C:/dsh/bin.js', '--profile', 'headless', '读一下这份文档'])
    expect(spec.supportsStdin).toBe(false)
  })

  it('ACP 那条路要带上"怎么启动"（否则 dsh 桌面端会被拉成 `<exe> --profile acp`，少入口脚本）', () => {
    const registrationArgs = ['--profile', 'acp']
    const launchArgs = ['--expose-internals', 'C:\\…\\cli.js', ...registrationArgs]
    expect(fullLaunchArgs(launchArgs, registrationArgs)).toEqual([
      '--expose-internals',
      'C:\\…\\cli.js',
      '--profile',
      'acp'
    ])
    // 普通 Agent（launchArgs 里没有解释器前缀）行为不变
    expect(fullLaunchArgs(['gemini', '--experimental-acp'], ['--experimental-acp'])).toEqual([
      'gemini',
      '--experimental-acp'
    ])
  })
})

describe('DSH 的兜底模型目录', () => {
  const dsh = FALLBACK_MODELS.dsh

  it('用的是 DSH 官方 provider 真实存在的模型（不再是 deepseek-chat / deepseek-reasoner）', () => {
    const ids = dsh.map((model) => model.id)
    expect(ids).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(ids).not.toContain('deepseek-chat')
    expect(ids).not.toContain('deepseek-reasoner')
  })

  it('思考强度按实机报文列全：off / low / high / max，默认 high', () => {
    expect(dsh[0].thoughtLevels?.map((level) => level.id)).toEqual(['off', 'low', 'high', 'max'])
    expect(dsh[0].defaultThoughtLevel).toBe('high')
  })
})

describe('Agent 子进程环境变量', () => {
  it('dsh 默认从密钥库取 DeepSeek 密钥，并以 DEEPSEEK_API_KEY 注入', () => {
    expect(defaultAgentEnv('dsh', getSecret)).toEqual({ [DEEPSEEK_API_KEY_ENV]: 'sk-test-key' })
  })

  it('别的 Agent 不会被塞进密钥', () => {
    expect(defaultAgentEnv('claude-code', getSecret)).toEqual({})
    expect(defaultAgentEnv('codex', getSecret)).toEqual({})
  })

  it('secret: 引用取不到时不注入空串', () => {
    expect(resolveEnvValue(SECRET_PREFIX + 'nope', getSecret)).toBeNull()
    expect(resolveAgentEnv({ FOO: SECRET_PREFIX + 'nope' }, getSecret)).toEqual({})
  })

  it('字面量原样保留，非法键名与空值被丢弃', () => {
    expect(resolveAgentEnv({ API_HOST: 'https://example.test', 'bad name': 'x', EMPTY: '' }, getSecret)).toEqual({
      API_HOST: 'https://example.test'
    })
  })

  it('用户配置覆盖内置默认（可以自己指向别的密钥）', () => {
    expect(mergeAgentEnv('dsh', { [DEEPSEEK_API_KEY_ENV]: 'literal-key' }, getSecret)).toEqual({
      [DEEPSEEK_API_KEY_ENV]: 'literal-key'
    })
    expect(mergeAgentEnv('dsh', { EXTRA: '1' }, getSecret)).toEqual({
      [DEEPSEEK_API_KEY_ENV]: 'sk-test-key',
      EXTRA: '1'
    })
  })
})

/**
 * 真实样本：DeepSeek Harness **桌面端**自带命令 `resources\runtime\cli\bin\dsh.cmd`
 * （本机 D:\DeepSeek Harness\…，实测可跑出 0.2.0-rc.2）。
 * 它不能当 `node <script>` 跑 —— 脚本在 app.asar 里，必须用那个 Electron 可执行文件。
 */
const DSH_DESKTOP_SHIM = [
  '@echo off',
  'setlocal DisableDelayedExpansion',
  'set "ELECTRON_RUN_AS_NODE=1"',
  '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*',
  'exit /b %errorlevel%'
].join('\r\n')

describe('cmd shim 解析', () => {
  const dir = 'D:\\DeepSeek Harness\\resources\\runtime\\cli\\bin'

  it('Electron 自带的命令解析成「那个 exe + --expose-internals + cli.js」并带上 ELECTRON_RUN_AS_NODE', () => {
    const parsed = parseShimContent(DSH_DESKTOP_SHIM, dir, () => true)
    expect(parsed).not.toBeNull()
    expect(parsed!.command).toBe('D:\\DeepSeek Harness\\DeepSeek Harness.exe')
    expect(parsed!.prefixArgs).toEqual([
      '--expose-internals',
      'D:\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js'
    ])
    expect(parsed!.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('不会把 asar 里的脚本错当成 node 脚本跑', () => {
    const parsed = parseShimContent(DSH_DESKTOP_SHIM, dir, () => true)
    expect(parsed!.command.toLowerCase()).not.toContain('node')
  })

  it('npm 生成的 shim 仍然走 node <script>', () => {
    const npmShim = ['@ECHO off', 'SETLOCAL', 'SET "_prog=node"', '"%_prog%" "%dp0%\\node_modules\\pkg\\bin\\cli.js" %*'].join('\r\n')
    const parsed = parseShimContent(npmShim, 'C:\\npm', (path) => path.endsWith('cli.js') || path.toLowerCase().endsWith('node.exe'))
    expect(parsed!.prefixArgs).toEqual(['C:\\npm\\node_modules\\pkg\\bin\\cli.js'])
    expect(parsed!.env).toEqual({})
  })
})

describe('cmd.exe 命令行引号', () => {
  it('带空格的路径要把整条命令再包一层引号（否则 cmd 在第一个空格处断句）', () => {
    expect(cmdCommandArgs(['/d', '/s', '/c', 'D:\\DeepSeek Harness\\dsh.cmd', '--profile', 'acp'])).toEqual([
      '/d',
      '/s',
      '/c',
      '""D:\\DeepSeek Harness\\dsh.cmd" --profile acp"'
    ])
  })

  it('不是 cmd 形态时原样返回', () => {
    expect(cmdCommandArgs(['--version'])).toEqual(['--version'])
  })
})

describe('ACP 配置项取值编码（dsh 的 model 是 [provider, model] 路由）', () => {
  const modelOption = { id: 'model', type: 'select', currentValue: ['deepseek-official', 'deepseek-v4-flash'] }
  /** 实测 dsh 0.2 回的就是这种"字符串里装着 JSON"的形态 */
  const modelOptionAsString = { id: 'model', type: 'select', currentValue: '["deepseek-official","deepseek-v4-flash"]' }

  it('裸模型名补上当前 provider，编码成 JSON 字符串（实测只有这个形态被接受）', () => {
    expect(encodeConfigValue(modelOption, 'deepseek-v4-pro')).toBe('["deepseek-official","deepseek-v4-pro"]')
  })

  it('provider/model 形态会换掉 provider', () => {
    expect(encodeConfigValue(modelOption, 'deepseek-official/deepseek-v4-pro')).toBe(
      '["deepseek-official","deepseek-v4-pro"]'
    )
    expect(parseModelRoute('my-gateway|deepseek-v4-pro')).toEqual({ provider: 'my-gateway', model: 'deepseek-v4-pro' })
  })

  it('普通字符串选项不动（别的 ACP 工具不受影响）', () => {
    expect(encodeConfigValue({ id: 'reasoning_effort', currentValue: 'high' }, 'max')).toBe('max')
  })

  it('currentValue 是 JSON 字符串（dsh 实测形态）时同样能编出路由', () => {
    expect(encodeConfigValue(modelOptionAsString, 'deepseek-v4-pro')).toBe('["deepseek-official","deepseek-v4-pro"]')
    expect(describeConfigValue(modelOptionAsString.currentValue)).toBe('deepseek-official/deepseek-v4-flash')
  })

  it('布尔选项按字符串处理', () => {
    expect(encodeConfigValue({ id: 'flag', type: 'boolean', currentValue: null }, 'true')).toBe(true)
    expect(encodeConfigValue({ id: 'flag', type: 'boolean', currentValue: null }, false)).toBe(false)
  })

  it('路由值的展示形态是 provider/model', () => {
    expect(describeConfigValue(['deepseek-official', 'deepseek-v4-flash'])).toBe('deepseek-official/deepseek-v4-flash')
    expect(describeConfigValue('max')).toBe('max')
    expect(describeConfigValue(null)).toBe('')
  })
})
