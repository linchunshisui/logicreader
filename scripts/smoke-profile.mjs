import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const profile = process.argv[2]
const agentId = process.argv[3] ?? 'claude-code'
const permissionMode = process.argv[4] ?? 'manual'
mkdirSync(profile, { recursive: true })
/*
 * settings.json 里先写 `wizardSeen: true`（第 5 个参数写 'wizard' 可跳过这一步）。
 *
 * 首启向导是一层覆盖整个窗口的遮罩：无人值守的冒烟脚本在它下面点什么都点不到，
 * 早先的拖选冒烟就是这么集体假失败的（避坑指南 §3.5 ⑪）。要测向导本身时传 'wizard'。
 */
if (process.argv[5] !== 'wizard') {
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ wizardSeen: true }, null, 2), 'utf8')
}
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
        /*
         * 侧栏默认收起（省得挡住正文）。要用冒烟断言侧栏里的树（资源管理器 / 已打开的编辑器）时，
         * 用 `LR_PROFILE_SIDEBAR=1` 打开 —— 树行只有在侧栏可见时才在 DOM 里。
         */
        sidebar: { visible: process.env.LR_PROFILE_SIDEBAR === '1', width: 280, activeView: 'explorer', viewState: {} },
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
