import { describe, expect, it } from 'vitest'
import { selectionRectOf } from '../apps/renderer/src/lib/readerSelection'

/**
 * 选区视口矩形（浮动工具条的定位依据）。
 *
 * 回归背景（第六十轮用户反馈）：工具条固定在视口底部，"正好选在底部"的文字被它挡住——
 * 用户选中 "Maximum Compound Divergence (MCD)" 想对 Agent 提问，按钮组压在选区上。
 * 修法是让 `SelectionInfo` 带上选区的**视口联合矩形**，工具条摆到选区旁边。
 * 这里钉住联合矩形的计算契约：跨行选区取"包住所有片段"的那一个。
 */
describe('selectionRectOf：选区的视口联合矩形', () => {
  /** 造一个带 getClientRects 的假 Range（jsdom 不实现布局，无法真算矩形）。 */
  function fakeRange(rects: { left: number; top: number; right: number; bottom: number; width?: number; height?: number }[]): Range {
    return {
      getClientRects: () =>
        rects.map((rect) => ({
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width ?? rect.right - rect.left,
          height: rect.height ?? rect.bottom - rect.top
        }))
    } as unknown as Range
  }

  it('跨行选区：取"包住所有片段"的联合矩形', () => {
    const rect = selectionRectOf(
      fakeRange([
        { left: 100, top: 200, right: 300, bottom: 216 },
        { left: 50, top: 220, right: 400, bottom: 236 }
      ])
    )
    expect(rect).toEqual({ x: 50, y: 200, width: 350, height: 36 })
  })

  it('零尺寸片段（换行符之类）被忽略，不参与联合', () => {
    const rect = selectionRectOf(
      fakeRange([
        { left: 0, top: 100, right: 0, bottom: 116 },
        { left: 120, top: 140, right: 260, bottom: 156 }
      ])
    )
    expect(rect).toEqual({ x: 120, y: 140, width: 140, height: 16 })
  })

  it('全部片段都无效 → null（工具条退回底部定位）', () => {
    expect(selectionRectOf(fakeRange([{ left: 10, top: 10, right: 10, bottom: 10 }]))).toBeNull()
  })

  it('没有片段 → null', () => {
    expect(selectionRectOf(fakeRange([]))).toBeNull()
  })
})
