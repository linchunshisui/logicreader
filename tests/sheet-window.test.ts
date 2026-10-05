import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ROW_HEIGHT,
  computeSheetWindow,
  rowScrollOffset
} from '../apps/renderer/src/lib/sheetWindow'

describe('表格窗口计算', () => {
  it('没有行时给一个空窗口，不产生占位高度', () => {
    expect(
      computeSheetWindow({ scrollTop: 0, viewportHeight: 600, rowHeight: 20, scale: 1, totalRows: 0 })
    ).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 })
  })

  it('在顶部时上方占位为 0，只留 overscan', () => {
    const w = computeSheetWindow({
      scrollTop: 0,
      viewportHeight: 200,
      rowHeight: 20,
      scale: 1,
      totalRows: 1000,
      overscan: 3
    })
    expect(w.start).toBe(0)
    expect(w.padTop).toBe(0)
    // 可视 200/20 = 10 行，再 +1（跨到边界的那一行）+ overscan 3
    expect(w.end).toBe(14)
    expect(w.padBottom).toBe((1000 - 14) * 20)
  })

  it('滚到中间时上下占位 + 窗口高度 = 总高度', () => {
    const w = computeSheetWindow({
      scrollTop: 4000,
      viewportHeight: 200,
      rowHeight: 20,
      scale: 1,
      totalRows: 1000,
      overscan: 5
    })
    expect(w.padTop + (w.end - w.start) * 20 + w.padBottom).toBe(1000 * 20)
    expect(w.padTop).toBe(w.start * 20)
  })

  it('滚到底时不会越过总行数，下方占位为 0', () => {
    const w = computeSheetWindow({
      scrollTop: 999999,
      viewportHeight: 200,
      rowHeight: 20,
      scale: 1,
      totalRows: 100,
      overscan: 8
    })
    expect(w.end).toBe(100)
    expect(w.padBottom).toBe(0)
    expect(w.start).toBeLessThan(100)
  })

  it('行数不足一屏时窗口覆盖全部行', () => {
    const w = computeSheetWindow({
      scrollTop: 0,
      viewportHeight: 800,
      rowHeight: 20,
      scale: 1,
      totalRows: 5,
      overscan: 10
    })
    expect(w.start).toBe(0)
    expect(w.end).toBe(5)
    expect(w.padBottom).toBe(0)
  })

  it('负的 scrollTop（弹性滚动）被夹到 0', () => {
    const w = computeSheetWindow({
      scrollTop: -300,
      viewportHeight: 200,
      rowHeight: 20,
      scale: 1,
      totalRows: 500,
      overscan: 0
    })
    expect(w.start).toBe(0)
    expect(w.padTop).toBe(0)
  })

  it('非法行高退回兜底值，不会除出 Infinity', () => {
    const w = computeSheetWindow({
      scrollTop: 0,
      viewportHeight: 200,
      rowHeight: 0,
      scale: 1,
      totalRows: 100,
      overscan: 2
    })
    expect(Number.isFinite(w.end)).toBe(true)
    expect(w.padTop).toBe(0)
    expect(w.end).toBe(Math.ceil(200 / DEFAULT_ROW_HEIGHT) + 1 + 2)
  })

  /**
   * 这条是这套坐标换算的核心回归：行号要按 **rowHeight × zoom** 折算（容器坐标），
   * 而占位高度必须用 **未缩放** 的 rowHeight（表格内部坐标，zoom 会再放大它一次）。
   * 两者混用就会滚到底行号对不上 —— 而且不报错。
   */
  it('倍率不为 1 时：行号按容器坐标算，占位高度按未缩放算', () => {
    const w = computeSheetWindow({
      scrollTop: 400,
      viewportHeight: 200,
      rowHeight: 20,
      scale: 2,
      totalRows: 1000,
      overscan: 0
    })
    // 400 / (20 × 2) = 第 10 行起
    expect(w.start).toBe(10)
    // 可视 200/(20×2)=5 行，再 +1
    expect(w.end).toBe(16)
    // 占位是未缩放的：10 × 20 —— 不是 10 × 40
    expect(w.padTop).toBe(200)
    expect(w.padBottom).toBe((1000 - 16) * 20)
  })

  it('非法倍率按 1 处理', () => {
    const base = { scrollTop: 400, viewportHeight: 200, rowHeight: 20, totalRows: 1000, overscan: 0 }
    expect(computeSheetWindow({ ...base, scale: 0 })).toEqual(computeSheetWindow({ ...base, scale: 1 }))
    expect(computeSheetWindow({ ...base, scale: Number.NaN })).toEqual(computeSheetWindow({ ...base, scale: 1 }))
  })
})

describe('跳转偏移量', () => {
  it('第一行偏移为 0', () => {
    expect(rowScrollOffset(0, 20, 1)).toBe(0)
  })

  it('偏移量随缩放放大：zoom 等比放大内容，容器坐标要跟着乘', () => {
    expect(rowScrollOffset(10, 20, 1)).toBe(200)
    expect(rowScrollOffset(10, 20, 1.5)).toBe(300)
    expect(rowScrollOffset(10, 20, 0.5)).toBe(100)
  })

  it('非法缩放按 1 处理', () => {
    expect(rowScrollOffset(10, 20, 0)).toBe(200)
    expect(rowScrollOffset(10, 20, Number.NaN)).toBe(200)
  })
})
