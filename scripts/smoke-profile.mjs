import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const profile = process.argv[2]
const agentId = process.argv[3] ?? 'claude-code'
const permissionMode = process.argv[4] ?? 'manual'
mkdirSync(profile, { recursive: true })
const snapshot = {
  version: 1,
  savedAt: Date.now(),
  reason: 'quit',
  app: { theme: 'dark', locale: 'zh-CN', readerThemeOverride: 'inherit' },
  windows: [
    {
      bounds: { x: 80, y: 60, width: 1500, height: 1000 },
      maximized: false,
      fullscreen: false,
      displayId: null,
      layout: {
        sidebar: { visible: false, width: 280, activeView: 'explorer', viewState: {} },
        auxBar: { visible: true, width: 430, activeView: 'agent', viewState: {} },
        panel: { visible: false, height: 240, tabs: ['output'], activeTab: 'output' },
        editorGroups: [{ id: 'g1', activeTabIndex: 0, tabs: [] }],
        activeGroupId: 'g1',
        zenMode: false
      },
      agent: {
        global: {
          conversationId: null,
          contextMode: 'fulltext',
          permissionMode,
          ultracode: false,
          nodeId: null,
          agentId,
          modelId: null,
          thinkingEffort: null,
          draft: '',
          scrollAnchorMessageId: null
        }
      }
    }
  ]
}
writeFileSync(join(profile, 'session.json'), JSON.stringify(snapshot, null, 2), 'utf8')
console.log('seeded', profile, 'agentId=' + agentId, 'permissionMode=' + permissionMode)
