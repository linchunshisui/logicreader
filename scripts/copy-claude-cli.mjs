/**
 * 把官方 Claude Agent SDK 自带的原生 CLI 复制到 resources/claude-cli/。
 *
 * 为什么要单独复制（而不是让 electron-builder 直接从 node_modules 取）：
 *   pnpm 把平台子包放在 `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-win32-x64@<hash>/`，
 *   路径里带哈希，electron-builder 的 from 没法稳定指向它；
 *   而运行时（打包后）也读不到 asar 里的原生可执行文件。
 * 于是：构建前解析真实路径 → 复制到工作区内的固定目录 → 由 extraResources 带进产物。
 *
 * 找不到时不报错（保留 SDK 自己的解析路径），但要**显式**打印出来，
 * 否则打包产物会表现为"Agent 不可用"而没人知道为什么。
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const target = join(projectRoot, 'resources', 'claude-cli')
const platform = process.platform
const arch = process.arch
const binary = platform === 'win32' ? 'claude.exe' : 'claude'

function findCli() {
  const candidates = []
  const resourcesPath = process.env.LR_RESOURCES_PATH
  if (resourcesPath) candidates.push(join(resourcesPath, 'claude-cli', binary))
  try {
    const require = createRequire(join(projectRoot, 'package.json'))
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk')
    const scope = dirname(dirname(entry))
    candidates.push(join(scope, 'claude-agent-sdk-' + platform + '-' + arch, binary))
    candidates.push(join(dirname(entry), 'vendor', binary))
  } catch (error) {
    console.log('[copy-claude-cli] 解析 SDK 失败：' + String(error))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const source = findCli()
if (!source) {
  console.log('[copy-claude-cli] 未找到原生 CLI（打包产物将回落到 SDK 自己的查找逻辑 / 用户已安装的 claude）')
  process.exit(0)
}
mkdirSync(target, { recursive: true })
const destination = join(target, binary)
copyFileSync(source, destination)
console.log(
  '[copy-claude-cli] ' + source + '  ->  ' + destination + '  (' + Math.round(statSync(destination).size / 1048576) + ' MB)'
)
