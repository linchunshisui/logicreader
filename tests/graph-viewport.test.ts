import { describe, expect, it } from 'vitest'
import {
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
  MAX_ZOOM,
  MIN_ZOOM,
  READABLE_ZOOM,
  centerOn,
  clampZoom,
  fitViewport,
  focusViewport,
  graphBounds,
  toScreen,
  toWorld,
  zoomAt
} from '../apps/renderer/src/lib/graphViewport'

/**
 * 关系图小窗的视口数学。
 *
 * 用户的要求是"整个图谱和全局关系图一致、可缩放"，所以这里钉的是两条硬契约：
 *  ① 「适应」之后整张图**必须真的全在窗口里**（不靠肉眼）；② 缩放时**锚点下的那个点不能跑**（否则滚轮会"漂"）。
 */
describe('关系图视口', () => {
  it('包围盒把节点尺寸算进去', () => {
    const bounds = graphBounds([
      { x: 100, y: 50 },
      { x: 400, y: 300 }
    ])!
    expect(bounds.minX).toBe(100)
    expect(bounds.minY).toBe(50)
    expect(bounds.maxX).toBe(400 + GRAPH_NODE_WIDTH)
    expect(bounds.maxY).toBe(300 + GRAPH_NODE_HEIGHT)
    expect(graphBounds([])).toBeNull()
  })

  it('「适应」之后整张图都在窗口内且居中', () => {
    const bounds = graphBounds([
      { x: 0, y: 0 },
      { x: 1000 - GRAPH_NODE_WIDTH, y: 500 - GRAPH_NODE_HEIGHT }
    ])!
    const viewport = fitViewport(bounds, 300, 300, 10)
    const topLeft = toScreen(viewport, { x: bounds.minX, y: bounds.minY })
    const bottomRight = toScreen(viewport, { x: bounds.maxX, y: bounds.maxY })
    expect(topLeft.x).toBeGreaterThanOrEqual(10 - 1e-6)
    expect(topLeft.y).toBeGreaterThanOrEqual(10 - 1e-6)
    expect(bottomRight.x).toBeLessThanOrEqual(300 - 10 + 1e-6)
    expect(bottomRight.y).toBeLessThanOrEqual(300 - 10 + 1e-6)
    // 居中：两侧留白相等
    expect(topLeft.x).toBeCloseTo(300 - bottomRight.x, 6)
    expect(topLeft.y).toBeCloseTo(300 - bottomRight.y, 6)
  })

  it('缩放时锚点下的世界坐标保持不动（滚轮不漂）', () => {
    const viewport = { k: 1, tx: 20, ty: 30 }
    const anchor = { x: 120, y: 90 }
    const before = toWorld(viewport, anchor.x, anchor.y)
    const zoomed = zoomAt(viewport, 1.25, anchor.x, anchor.y)
    const after = toWorld(zoomed, anchor.x, anchor.y)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
    expect(zoomed.k).toBeCloseTo(1.25, 6)
  })

  it('缩放有上下限，不会缩放成 0 或无穷', () => {
    expect(zoomAt({ k: 1, tx: 0, ty: 0 }, 1000, 0, 0).k).toBe(MAX_ZOOM)
    expect(zoomAt({ k: 1, tx: 0, ty: 0 }, 0.00001, 0, 0).k).toBe(MIN_ZOOM)
    expect(clampZoom(Number.NaN)).toBe(1)
  })

  it('「定位当前节点」把该点放到窗口正中', () => {
    const viewport = centerOn({ k: 0.5, tx: 0, ty: 0 }, 800, 400, 300, 200)
    const screen = toScreen(viewport, { x: 800, y: 400 })
    expect(screen.x).toBeCloseTo(150, 6)
    expect(screen.y).toBeCloseTo(100, 6)
  })

  it('「定位当前节点」要放大到看得清字：适应时的 10% → 至少 90%，并居中', () => {
    const fitted = fitViewport(
      graphBounds([
        { x: 0, y: 0 },
        { x: 3000 - GRAPH_NODE_WIDTH, y: 2000 - GRAPH_NODE_HEIGHT }
      ])!,
      300,
      300
    )
    expect(fitted.k).toBeLessThan(READABLE_ZOOM)
    const focused = focusViewport(fitted, 1500, 1000, 300, 300)
    expect(focused.k).toBeCloseTo(READABLE_ZOOM, 6)
    const screen = toScreen(focused, { x: 1500, y: 1000 })
    expect(screen.x).toBeCloseTo(150, 6)
    expect(screen.y).toBeCloseTo(150, 6)
  })

  it('已经放得比"能看清"更大时，「定位」只居中、不回缩', () => {
    const focused = focusViewport({ k: 2.5, tx: 0, ty: 0 }, 100, 100, 300, 300)
    expect(focused.k).toBe(2.5)
    const screen = toScreen(focused, { x: 100, y: 100 })
    expect(screen.x).toBeCloseTo(150, 6)
    expect(screen.y).toBeCloseTo(150, 6)
  })

  it('屏幕 ↔ 世界坐标互为逆变换', () => {
    const viewport = { k: 0.37, tx: -12, ty: 44 }
    const world = toWorld(viewport, 123, 77)
    const back = toScreen(viewport, world)
    expect(back.x).toBeCloseTo(123, 6)
    expect(back.y).toBeCloseTo(77, 6)
  })

  it('退化的图（单点/零尺寸）也不会算出 NaN', () => {
    const bounds = graphBounds([{ x: 0, y: 0 }])!
    const viewport = fitViewport(bounds, 300, 300)
    for (const value of [viewport.k, viewport.tx, viewport.ty]) {
      expect(Number.isFinite(value)).toBe(true)
    }
  })
})
