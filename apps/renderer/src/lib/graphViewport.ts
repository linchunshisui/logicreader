/**
 * 关系图小窗的**视口数学**（纯函数）：世界坐标（= 全局画布坐标）↔ 窗口像素。
 *
 * 为什么必须用全局画布那一套坐标：用户明确要求"整个图谱要和全局关系图一致"。
 * 画布里节点位置来自 `graph.positions`（布局 Worker 算好后落库），
 * 所以小窗直接吃同一份坐标、同一套节点尺寸 —— 看到的就是同一张图，只是窗口大小不同。
 *
 * 约定：`{k, tx, ty}` 表示把世界坐标先缩放 k 倍、再平移 (tx, ty) 得到窗口像素，
 * 即 `screen = world * k + t`。缩放时锚点下的世界坐标必须保持不动（见 `zoomAt`）。
 */

/** 与全局画布一致的节点尺寸（见 styles/graph.css 的 .lr-gnode） */
export const GRAPH_NODE_WIDTH = 220
export const GRAPH_NODE_HEIGHT = 64

export const MIN_ZOOM = 0.02
export const MAX_ZOOM = 4
/**
 * "看得清节点上的字"的缩放门槛。
 * 卡片标题在画布坐标里是 13px（见 .lr-localmap--whole .lr-localmap__label），
 * 0.9 倍 ≈ 11.7px —— 中文标题在这个字号下能舒服地读；再小就要凑近看了。
 * 注意这是**下限**：用户已经放得更大时，"定位"只居中不回缩（不能把人家拉回去）。
 */
export const READABLE_ZOOM = 0.9

export interface Viewport {
  k: number
  tx: number
  ty: number
}

export interface GraphBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export function clampZoom(k: number): number {
  if (!Number.isFinite(k)) return 1
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k))
}

/** 节点矩形的包围盒（含节点尺寸；空图返回 null）。 */
export function graphBounds(points: readonly Point[]): GraphBounds | null {
  if (points.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x + GRAPH_NODE_WIDTH > maxX) maxX = point.x + GRAPH_NODE_WIDTH
    if (point.y + GRAPH_NODE_HEIGHT > maxY) maxY = point.y + GRAPH_NODE_HEIGHT
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}

/** 让整张图刚好铺进窗口并居中（留出 padding 像素的边距）。 */
export function fitViewport(bounds: GraphBounds, viewWidth: number, viewHeight: number, padding = 10): Viewport {
  const usableWidth = Math.max(1, viewWidth - padding * 2)
  const usableHeight = Math.max(1, viewHeight - padding * 2)
  const k = clampZoom(Math.min(usableWidth / Math.max(1, bounds.width), usableHeight / Math.max(1, bounds.height)))
  return {
    k,
    tx: (viewWidth - bounds.width * k) / 2 - bounds.minX * k,
    ty: (viewHeight - bounds.height * k) / 2 - bounds.minY * k
  }
}

/** 以窗口上的 (anchorX, anchorY) 为锚点缩放：该点下的世界坐标保持不动（滚轮缩放的标准做法）。 */
export function zoomAt(viewport: Viewport, factor: number, anchorX: number, anchorY: number): Viewport {
  const k = clampZoom(viewport.k * factor)
  const ratio = viewport.k === 0 ? 1 : k / viewport.k
  return {
    k,
    tx: anchorX - (anchorX - viewport.tx) * ratio,
    ty: anchorY - (anchorY - viewport.ty) * ratio
  }
}

/** 把世界坐标里的某个点挪到窗口正中（跳转/换中心节点后用它把焦点找回来）。 */
export function centerOn(viewport: Viewport, worldX: number, worldY: number, viewWidth: number, viewHeight: number): Viewport {
  return {
    k: viewport.k,
    tx: viewWidth / 2 - worldX * viewport.k,
    ty: viewHeight / 2 - worldY * viewport.k
  }
}

/**
 * 「定位当前节点」：把该点挪到窗口正中，并保证**至少**放大到能看清文字（`READABLE_ZOOM`）。
 * 已经比它更大时保持原缩放（只居中），避免"点一下反而缩小"。
 */
export function focusViewport(
  viewport: Viewport,
  worldX: number,
  worldY: number,
  viewWidth: number,
  viewHeight: number,
  minZoom = READABLE_ZOOM
): Viewport {
  const k = clampZoom(Math.max(viewport.k, minZoom))
  return { k, tx: viewWidth / 2 - worldX * k, ty: viewHeight / 2 - worldY * k }
}

export function toScreen(viewport: Viewport, point: Point): Point {
  return { x: point.x * viewport.k + viewport.tx, y: point.y * viewport.k + viewport.ty }
}

export function toWorld(viewport: Viewport, screenX: number, screenY: number): Point {
  const k = viewport.k === 0 ? 1 : viewport.k
  return { x: (screenX - viewport.tx) / k, y: (screenY - viewport.ty) / k }
}
