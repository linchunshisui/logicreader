/**
 * Electron 二进制在部分网络环境下会下载失败。此脚本在安装后做一次校验，
 * 若缺失则用国内镜像重试一次，避免开发者卡在第一步。
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

function electronDir() {
  try {
    return dirname(require.resolve('electron/package.json'))
  } catch {
    return null
  }
}

const dir = electronDir()
if (!dir) {
  console.log('[ensure-electron] 未安装 electron，跳过。')
  process.exit(0)
}

const pathFile = join(dir, 'path.txt')
if (existsSync(pathFile)) {
  const rel = readFileSync(pathFile, 'utf8').trim()
  if (existsSync(join(dir, 'dist', rel))) {
    console.log('[ensure-electron] Electron 二进制就绪。')
    process.exit(0)
  }
}

console.log('[ensure-electron] Electron 二进制缺失，尝试使用镜像重新下载…')
const res = spawnSync(process.execPath, [join(dir, 'install.js')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'
  }
})
process.exit(res.status ?? 1)
