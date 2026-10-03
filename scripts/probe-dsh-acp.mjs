#!/usr/bin/env node
/**
 * 离线探针：对着真实的 dsh 跑一遍 ACP 握手（不需要 Electron，也不发模型请求）。
 *
 * 用法：
 *   node scripts/probe-dsh-acp.mjs                       # 用 PATH 里的 dsh
 *   node scripts/probe-dsh-acp.mjs "<dsh.cmd 路径>"       # 用指定的启动器
 *   node scripts/probe-dsh-acp.mjs "<dsh.cmd>" --prompt   # 再发一句最小提示词（会真的调用模型）
 *   node scripts/probe-dsh-acp.mjs "<dsh.cmd>" --no-config # 跳过 set_config_option 实验
 *
 * 它验证的正是主进程 AcpClient 依赖的那套报文：initialize → session/new（→ session/list）。
 * 与 `--version` 不同，这能回答"这个 dsh 到底认不认 ACP、configOptions 里有什么"。
 */
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const target = args.find((value) => !value.startsWith('--')) ?? 'dsh'
const withPrompt = args.includes('--prompt')
const withList = !args.includes('--no-list')
const withConfig = !args.includes('--no-config')
/** `--cwd <路径>`：按给定工作目录列会话（dsh 的 session/list 按 cwd 精确匹配，尾部分隔符会影响结果） */
const cwdIndex = args.indexOf('--cwd')
const listCwd = cwdIndex >= 0 && args[cwdIndex + 1] ? args[cwdIndex + 1] : process.cwd() + '\\'

/**
 * .cmd / .bat 不能直接 spawn（shell:false），走 cmd.exe。
 *
 * 注意 cmd 的引号规则：`/s /c` 会剥掉最外层的一对引号再原样执行，所以**整条命令**要再包一层引号，
 * 否则带空格的路径（`D:\DeepSeek Harness\…`）会在第一个空格处被切断（实测：`'D:\DeepSeek' 不是内部或外部命令`）。
 * 用 windowsVerbatimArguments 自己拼命令行，避免 Node 再插一层引号。
 */
function launch(command, extra) {
  if (/\.(cmd|bat)$/i.test(command)) {
    const inner = ['"' + command + '"', ...extra.map((value) => '"' + value + '"')].join(' ')
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', '"' + inner + '"'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: true
    })
  }
  return spawn(command, extra, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
}

const child = launch(target, ['--profile', 'acp'])
const pending = new Map()
let nextId = 1
let buffer = ''
let stderr = ''
let sawFrames = 0

child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  stderr += chunk
})
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line.length > 0) {
      sawFrames += 1
      let message
      try {
        message = JSON.parse(line)
      } catch {
        console.log('[非协议 stdout] ' + line.slice(0, 200))
        index = buffer.indexOf('\n')
        continue
      }
      const waiter = pending.get(message.id)
      if (waiter) {
        pending.delete(message.id)
        clearTimeout(waiter.timer)
        message.error ? waiter.reject(new Error(message.error.message ?? 'error')) : waiter.resolve(message.result)
      } else if (message.method) {
        console.log('[服务器请求] ' + message.method + ' ' + JSON.stringify(message.params ?? {}).slice(0, 160))
        if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } })
      } else {
        console.log('[通知] ' + JSON.stringify(message).slice(0, 200))
      }
    }
    index = buffer.indexOf('\n')
  }
})

function send(message) {
  child.stdin.write(JSON.stringify(message) + '\n')
}

function request(method, params, timeoutMs = 20000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('超时：' + method))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

function finish(code) {
  try {
    child.kill()
  } catch {
    /* 忽略 */
  }
  if (stderr.trim().length > 0) console.log('--- stderr ---\n' + stderr.trim().slice(0, 800))
  process.exit(code)
}

const started = Date.now()
try {
  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false } })
  console.log('initialize ✅ ' + JSON.stringify(init).slice(0, 600))

  const session = await request('session/new', { cwd: process.cwd() + '\\', mcpServers: [] })
  console.log('session/new ✅ sessionId=' + session.sessionId)
  const options = Array.isArray(session.configOptions) ? session.configOptions : []
  for (const option of options) {
    console.log(
      '  configOption ' +
        option.id +
        ' [' +
        option.category +
        '] 当前=' +
        String(option.currentValue) +
        ' 可选=' +
        (option.options ?? []).map((item) => item.value).join('|')
    )
  }

  if (withList) {
    try {
      const list = await request('session/list', { cwd: listCwd })
      console.log('session/list ✅ ' + (list.sessions?.length ?? 0) + ' 条')
      if (args.includes('--dump-list')) {
        for (const row of (list.sessions ?? []).slice(0, 3)) console.log('  ' + JSON.stringify(row))
      }
    } catch (error) {
      console.log('session/list ✖ ' + String(error))
    }
  }

  /**
   * 实测 `session/set_config_option` 的取值形态。
   * dsh 的 `model` 项 currentValue 是**数组** `[provider, model]`，而我们的界面只会发字符串 ——
   * 到底哪一串才是它认的，只能问它自己（错了也只会被客户端吞掉，界面上表现为"改了没用"）。
   */
  if (withConfig) {
    const attempts = [
      ['model', 'deepseek-v4-flash'],
      ['model', 'deepseek-official/deepseek-v4-flash'],
      ['model', '["deepseek-official","deepseek-v4-flash"]'],
      ['model', ['deepseek-official', 'deepseek-v4-flash']],
      ['model', 'deepseek-official'],
      ['model', 'deepseek-official:deepseek-v4-flash'],
      ['model', 'deepseek-v4-pro'],
      ['reasoning_effort', 'max'],
      ['reasoning_effort', 'low']
    ]
    for (const [configId, value] of attempts) {
      try {
        const next = await request('session/set_config_option', { sessionId: session.sessionId, configId, value }, 15000)
        const applied = (next.configOptions ?? []).find((option) => option.id === configId)
        console.log('set_config_option ✅ ' + configId + '=' + value + ' → 当前=' + JSON.stringify(applied?.currentValue))
      } catch (error) {
        console.log('set_config_option ✖ ' + configId + '=' + value + ' → ' + String(error))
      }
    }
    /** 顺带问几个"可能存在的取模型清单方法"：不存在的会以未实现报错，正好当探测。 */
    for (const method of ['providers/list', 'session/list_models', 'session/models', 'models/list']) {
      try {
        const result = await request(method, {}, 8000)
        console.log(method + ' ✅ ' + JSON.stringify(result).slice(0, 200))
      } catch (error) {
        console.log(method + ' ✖ ' + String(error))
      }
    }
  }

  if (withPrompt) {
    const reply = await request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: '用一句话回答：1+1 等于几？' }] }, 120000)
    console.log('session/prompt ✅ ' + JSON.stringify(reply).slice(0, 200))
  } else {
    console.log('（未发提示词：加 --prompt 才会真的调用模型）')
  }

  await request('session/close', { sessionId: session.sessionId }).catch((error) => console.log('session/close ✖ ' + String(error)))
  console.log('完成：帧数=' + sawFrames + ' 用时=' + (Date.now() - started) + 'ms')
  finish(0)
} catch (error) {
  console.log('探针失败：' + (error instanceof Error ? error.message : String(error)))
  finish(1)
}
