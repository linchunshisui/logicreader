import { describe, expect, it } from 'vitest'
import { railPanelsOf } from '@logicreader/shared'

/**
 * 阅读器自带侧栏：从"三选一的页签"改成"两块可叠加的面板"之后，
 * 旧快照（只有 `sidebarView`）必须还能读得懂 —— 否则恢复会话时侧栏会莫名空掉或全开。
 * 这条兼容规则是纯函数，单测钉住它，别靠读代码猜。
 */
describe('railPanelsOf：侧栏面板状态（含旧快照兼容）', () => {
  it('新形态：直接读 railPanels（两块可以同时开）', () => {
    expect(railPanelsOf({ railPanels: { thumbnails: true, annotations: true } })).toEqual({
      thumbnails: true,
      annotations: true
    })
    expect(railPanelsOf({ railPanels: { thumbnails: false, annotations: false } })).toEqual({
      thumbnails: false,
      annotations: false
    })
  })

  it('旧快照 sidebarView=annotations → 只开标注', () => {
    expect(railPanelsOf({ sidebarView: 'annotations' })).toEqual({ thumbnails: false, annotations: true })
  })

  it('旧快照的缩略图/目录/搜索 → 只开缩略图（目录已并进全局大纲，不在这里留位置）', () => {
    expect(railPanelsOf({ sidebarView: 'thumbnails' })).toEqual({ thumbnails: true, annotations: false })
    expect(railPanelsOf({ sidebarView: 'outline' })).toEqual({ thumbnails: true, annotations: false })
    expect(railPanelsOf({ sidebarView: 'search' })).toEqual({ thumbnails: true, annotations: false })
  })

  it('什么都没有（更老的快照）→ 只开缩略图（不是全开、也不是全关）', () => {
    expect(railPanelsOf({})).toEqual({ thumbnails: true, annotations: false })
  })

  it('新字段优先于旧字段', () => {
    expect(railPanelsOf({ sidebarView: 'annotations', railPanels: { thumbnails: true, annotations: true } })).toEqual({
      thumbnails: true,
      annotations: true
    })
  })
})
