import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const r = (p: string): string => resolve(__dirname, p)

export default defineConfig({
  resolve: {
    alias: {
      '@logicreader/shared': r('packages/shared/src/index.ts'),
      '@logicreader/document-model': r('packages/document-model/src/index.ts'),
      '@logicreader/graph-schema': r('packages/graph-schema/src/index.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts']
  }
})
