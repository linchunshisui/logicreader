/**
 * 关系图 → 位图（PNG / JPG）。
 *
 * **为什么在渲染进程做**：主进程没有 SVG 光栅化器，离线环境又不想为此再引一个原生依赖；
 * 而 Chromium 本身就能把 SVG 画进 canvas —— 用现成能力，零新依赖。
 * 主进程负责"图长什么样"（`graph.renderSvg` 产出 SVG），这里只负责"变成像素"。
 *
 * 两个格式的差别只有一个：**JPG 没有 alpha 通道**。
 * 所以它必须先铺一层底色（用户要求的"与界面一致"的画布色，见 `canvasBackgroundColor`），
 * 而 PNG 不铺底、保持透明（`background: null`）。
 */
import { api } from './api'

export type GraphImageFormat = 'png' | 'jpg'

export interface RasterizedImage {
  bytes: Uint8Array
  width: number
  height: number
  /** 实际铺的底色（PNG 为 null） */
  background: string | null
}

/** 默认 2 倍：1 倍在 4K 屏/打印里明显发糊，2 倍是体积与清晰度的常用折中 */
export const DEFAULT_IMAGE_SCALE = 2

export interface RasterizeOptions {
  format: GraphImageFormat
  /** JPG 的底色；PNG 忽略。拿不到时退回白色 */
  background?: string | null
  scale?: number
  /** JPG 质量（0–1） */
  quality?: number
}

export async function rasterizeSvg(svg: string, options: RasterizeOptions): Promise<RasterizedImage> {
  const scale = options.scale ?? DEFAULT_IMAGE_SCALE
  const background = options.format === 'jpg' ? options.background ?? '#ffffff' : null
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    // decode() 等的是"真的解出来了"，比 onload 更适合带内容的外链/Blob
    await image.decode()
    const width = Math.max(1, Math.round((image.naturalWidth || 1200) * scale))
    const height = Math.max(1, Math.round((image.naturalHeight || 800) * scale))
    const canvas = document.createElement('canvas')
    // 必须先定尺寸再取上下文：改尺寸会清空画布
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建 2D 画布上下文，导出图片失败')
    if (background) {
      context.fillStyle = background
      context.fillRect(0, 0, width, height)
    }
    context.drawImage(image, 0, 0, width, height)
    const mime = options.format === 'jpg' ? 'image/jpeg' : 'image/png'
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, options.quality ?? 0.92))
    if (!out) throw new Error('导出图片失败：canvas.toBlob 返回空')
    return { bytes: new Uint8Array(await out.arrayBuffer()), width, height, background }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * "用户看到的画布底色"：从元素自身往上找第一个**不透明**的背景色。
 *
 * 不写死颜色表：主题（深/浅/跟随系统）与自定义主题都只体现在 CSS 变量上，
 * 读实际算出来的颜色，导出的 JPG 才和眼前这一屏一致。
 */
export function canvasBackgroundColor(start?: HTMLElement | null): string {
  // 1) 优先读"实际渲染出来的"背景色：关系图标签在 DOM 里时，这就是用户眼前那一块
  let element: HTMLElement | null =
    start ?? document.querySelector<HTMLElement>('.lr-graph__canvas') ?? document.querySelector<HTMLElement>('.lr-graph')
  while (element) {
    const color = window.getComputedStyle(element).backgroundColor
    if (color && isVisibleColor(color)) return color
    element = element.parentElement
  }
  /*
   * 2) 关系图标签不在 DOM 里时（切到了阅读器标签、或从别处发起导出），退回主题令牌：
   *    它由 applyTheme 写在 :root 上，任何时候都取得到。
   *    这一条不是可有可无的兜底 —— 少了它就会**静默退回白色**，
   *    而"底色与界面一致"恰恰是这个功能的要求（本轮就被冒烟抓到过一次）。
   */
  const token = window.getComputedStyle(document.documentElement).getPropertyValue('--graph-canvas').trim()
  if (token && isVisibleColor(token)) return token
  return '#ffffff'
}

/** transparent / rgba(…,0) 都不算"看得见的底色" */
export function isVisibleColor(color: string): boolean {
  const text = color.trim().toLowerCase()
  if (text.length === 0 || text === 'transparent') return false
  const match = /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*([\d.]+)\s*)?\)/.exec(text)
  if (match) return match[1] == null ? true : Number(match[1]) > 0
  return true
}

/** 导出对话框用的扩展名 */
export function imageExtension(format: GraphImageFormat): string {
  return format === 'jpg' ? 'jpg' : 'png'
}

/**
 * 导出关系图图片：取 SVG → 光栅化 → 写文件。
 *
 * **UI 与冒烟共用这一个函数**：只有这样，"冒烟通过"才等于"用户点导出得到的结果通过"。
 * 冒烟从磁盘回读这个函数写出的文件再判像素，而不是判它返回的内存字节。
 */
export async function exportGraphImage(
  graphId: string,
  format: GraphImageFormat,
  targetPath: string,
  scale?: number
): Promise<RasterizedImage> {
  const background = canvasBackgroundColor()
  const svg = await api.graph.renderSvg(graphId, { background: format === 'jpg' ? background : null })
  const image = await rasterizeSvg(svg, { format, background, scale })
  await api.fs.writeBinary(targetPath, image.bytes)
  return image
}
