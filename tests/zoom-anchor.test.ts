/**
 * 缩放锚点的落点是纯函数，直接钉成回归断言（用户要求：
 * "缩放时应以这些文段为中心，缩放前后这些文段的开头都要可视"）：
 *  · 文段能装下 → 居中；
 *  · 装不下（文段比视口还高）→ **开头**对齐到顶部留边，而不是把它挤出视口；
 *  · 结果不许为负（滚动位置没有负的）。
 */
import { describe, expect, it } from 'vitest'
import { centerScrollTop } from '../apps/renderer/src/lib/zoomAnchor'

/** 视口：顶端在 100、高 600 */
const host = { top: 100, height: 600 }

describe('centerScrollTop（缩放锚点）', () => {
  it('文段能装下：把它放到视口正中间', () => {
    // 文段（高 100）当前在视口下方 600px 处；居中要求它的顶边落在 100 + (600-100)/2 = 350
    const next = centerScrollTop(400, { top: 700, height: 100 }, host)
    // 目标 scrollTop = 当前 400 + (700 - 100) - 250 = 750
    expect(next).toBe(750)
    // 反算：新 scrollTop 下这段的顶边正好在 350
    expect(700 - (next - 400)).toBe(350)
  })

  it('文段与视口等高：按"开头可视"对齐顶部，滚动位置被夹回 0', () => {
    const next = centerScrollTop(0, { top: 100, height: 600 }, host)
    expect(next).toBe(0)
  })

  it('文段比视口高：开头对齐顶部留边（保证"开头可视"）', () => {
    const next = centerScrollTop(1000, { top: 1300, height: 2000 }, host)
    // 目标：顶边落在 host.top + 12 = 112
    expect(1300 - (next - 1000)).toBe(112)
  })

  it('文段已经在视口顶部：不产生负的滚动位置', () => {
    expect(centerScrollTop(0, { top: -500, height: 40 }, host)).toBe(0)
  })

  it('缩放前后来回对齐都收敛在同一个位置（幂等）', () => {
    const rect = { top: 700, height: 100 }
    const once = centerScrollTop(400, rect, host)
    const twice = centerScrollTop(once, { top: rect.top - (once - 400), height: rect.height }, host)
    expect(twice).toBe(once)
  })
})
