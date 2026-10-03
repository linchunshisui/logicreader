import { resolve } from 'node:path'
import { builtinModules } from 'node:module'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const r = (p: string): string => resolve(__dirname, p)

/**
 * 构建时间戳（本地时区，分钟精度）。
 * 以前这里是写死的字符串，结果新产物装出来状态栏还显示旧日期 —— 排查"到底跑的是哪份产物"时很误导。
 * 现在每次构建自动取当前时间；要固定它（可复现构建）可用环境变量 LR_BUILD_STAMP 覆盖。
 */
function buildStamp(): string {
  const fixed = process.env.LR_BUILD_STAMP
  if (fixed) return fixed
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    now.getFullYear() +
    '-' +
    pad(now.getMonth() + 1) +
    '-' +
    pad(now.getDate()) +
    ' ' +
    pad(now.getHours()) +
    ':' +
    pad(now.getMinutes())
  )
}

/** 工作区内部包始终打进产物，避免运行时 require 失败 */
const workspaceAlias: Record<string, string> = {
  '@logicreader/shared': r('packages/shared/src/index.ts'),
  '@logicreader/document-model': r('packages/document-model/src/index.ts'),
  '@logicreader/graph-schema': r('packages/graph-schema/src/index.ts')
}

/**
 * 必须**排除在打包之外**的依赖：
 *  - `electron` 与 node 内置模块：运行时由宿主提供；
 *  - `better-sqlite3`：原生模块，需要运行时按平台加载；
 *  - `@anthropic-ai/claude-agent-sdk`：**ESM-only**（入口 `sdk.mjs`），
 *    而主进程产物是 CJS —— 打成 CJS 会把它整份塞进 bundle 并在运行时炸掉。
 *    因此保持外部依赖 + 运行时 `import()`（见 services/agent/sdk.ts 的 loadSdk）。
 *    它的平台子包（含 236 MB 的原生 CLI）也不能被 Vite 试图解析。
 */
const nodeExternals = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  'better-sqlite3',
  '@anthropic-ai/claude-agent-sdk',
  /^@anthropic-ai\/claude-agent-sdk-/
]

export default defineConfig({
  main: {
    resolve: { alias: workspaceAlias },
    // 主进程也要构建时间戳：启动第一行就写出来，便于确认"跑的是哪次构建"
    define: { __LR_BUILD__: JSON.stringify(buildStamp()) },
    build: {
      outDir: 'out/main',
      minify: false,
      rollupOptions: {
        external: nodeExternals,
        input: { index: r('apps/main/src/index.ts') }
      }
    }
  },
  preload: {
    resolve: { alias: workspaceAlias },
    build: {
      outDir: 'out/preload',
      minify: false,
      rollupOptions: {
        external: ['electron'],
        input: { index: r('apps/preload/src/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    // 构建时间戳：状态栏用它区分"这份产物是哪次构建的"（排查旧产物问题时最省事的一招）
    define: { __LR_BUILD__: JSON.stringify(buildStamp()) },
    root: r('apps/renderer'),
    resolve: {
      alias: {
        ...workspaceAlias,
        '@': r('apps/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      outDir: r('out/renderer'),
      emptyOutDir: true,
      chunkSizeWarningLimit: 4096,
      rollupOptions: {
        input: { index: r('apps/renderer/index.html') }
      }
    },
    server: {
      port: 5273,
      strictPort: false
    }
  }
})
