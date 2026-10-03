/**
 * PDF 黑底白字三档模式（规划书 §5.3）。
 * 智能暗色 = 逐像素亮度反转 + 图像区域保护（保留彩色图表）。
 */
import { OPS, type PDFPageProxy, type PageViewport } from 'pdfjs-dist'
import type { PdfDarkMode, PdfImagePolicy } from '@logicreader/shared'

export interface ImageRegion {
  x: number
  y: number
  width: number
  height: number
}

/** 扫描操作符列表，换算出图像区域在页面中的归一化矩形。 */
export async function collectImageRegions(page: PDFPageProxy, viewport: PageViewport): Promise<ImageRegion[]> {
  let opList: { fnArray: number[]; argsArray: unknown[][] }
  try {
    opList = (await page.getOperatorList()) as unknown as { fnArray: number[]; argsArray: unknown[][] }
  } catch {
    return []
  }
  const { fnArray, argsArray } = opList
  const regions: ImageRegion[] = []
  let ctm: number[] = [1, 0, 0, 1, 0, 0]
  const stack: number[][] = []
  const mul = (m: number[], t: number[]): number[] => [
    m[0] * t[0] + m[2] * t[1],
    m[1] * t[0] + m[3] * t[1],
    m[0] * t[2] + m[2] * t[3],
    m[1] * t[2] + m[3] * t[3],
    m[0] * t[4] + m[2] * t[5] + m[4],
    m[1] * t[4] + m[3] * t[5] + m[5]
  ]

  const pushRegion = (matrix: number[], w = 1, h = 1): void => {
    const corners: [number, number][] = [
      [0, 0],
      [w, 0],
      [0, -h],
      [w, -h]
    ]
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const [ux, uy] of corners) {
      const px = matrix[0] * ux + matrix[2] * uy + matrix[4]
      const py = matrix[1] * ux + matrix[3] * uy + matrix[5]
      const [vx, vy] = viewport.convertToViewportPoint(px, py)
      minX = Math.min(minX, vx)
      maxX = Math.max(maxX, vx)
      minY = Math.min(minY, vy)
      maxY = Math.max(maxY, vy)
    }
    const width = Math.abs(maxX - minX) / viewport.width
    const height = Math.abs(maxY - minY) / viewport.height
    if (width < 0.004 || height < 0.004) return
    // 覆盖整页的区域不视为图像，避免整页不反色
    if (width * height > 0.92) return
    regions.push({
      x: Math.min(minX, maxX) / viewport.width,
      y: Math.min(minY, maxY) / viewport.height,
      width,
      height
    })
  }

  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i]
    const args = argsArray[i] ?? []
    switch (fn) {
      case OPS.save:
        stack.push([...ctm])
        break
      case OPS.restore:
        ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0]
        break
      case OPS.transform:
        ctm = mul(ctm, args as number[])
        break
      case OPS.paintFormXObjectBegin: {
        stack.push([...ctm])
        const matrix = args[0] as number[] | null
        if (matrix && matrix.length === 6) ctm = mul(ctm, matrix)
        break
      }
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? ctm
        break
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
        pushRegion(ctm)
        break
      case OPS.paintImageXObjectRepeat: {
        const positions = args[3] as number[] | undefined
        if (Array.isArray(positions)) {
          for (let p = 0; p + 1 < positions.length; p += 2) {
            pushRegion(mul(ctm, [args[1] as number, 0, 0, args[2] as number, positions[p], positions[p + 1]]))
          }
        } else pushRegion(ctm)
        break
      }
      case OPS.paintInlineImageXObjectGroup:
      case OPS.paintImageMaskXObjectGroup: {
        const map = (fn === OPS.paintInlineImageXObjectGroup ? args[1] : args[0]) as
          | { transform?: number[]; w?: number; h?: number }[]
          | undefined
        if (Array.isArray(map)) {
          for (const entry of map) {
            const matrix = entry.transform ? mul(ctm, entry.transform) : ctm
            const w = entry.w ?? 1
            const h = entry.h ?? 1
            pushRegion(matrix, w > 2 ? w : 1, h > 2 ? h : 1)
          }
        }
        break
      }
      default:
        break
    }
  }
  return mergeRegions(regions)
}

function mergeRegions(regions: ImageRegion[]): ImageRegion[] {
  const out: ImageRegion[] = []
  for (const region of regions) {
    const hit = out.find(
      (r) =>
        region.x < r.x + r.width + 0.01 &&
        region.x + region.width > r.x - 0.01 &&
        region.y < r.y + r.height + 0.01 &&
        region.y + region.height > r.y - 0.01
    )
    if (hit) {
      const x = Math.min(hit.x, region.x)
      const y = Math.min(hit.y, region.y)
      hit.width = Math.max(hit.x + hit.width, region.x + region.width) - x
      hit.height = Math.max(hit.y + hit.height, region.y + region.height) - y
      hit.x = x
      hit.y = y
    } else {
      out.push({ ...region })
    }
  }
  return out.slice(0, 400)
}

function invertLightness(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max - min < 0.02) {
    const v = Math.round((1 - l) * 255)
    return [v, v, v]
  }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  h /= 6
  const l2 = 1 - l
  const q = l2 < 0.5 ? l2 * (1 + s) : l2 + s - l2 * s
  const p = 2 * l2 - q
  const channel = (t: number): number => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  return [Math.round(channel(h + 1 / 3) * 255), Math.round(channel(h) * 255), Math.round(channel(h - 1 / 3) * 255)]
}

const BLOCK = 4

/**
 * 就地处理画布像素。
 * @returns 处理耗时（毫秒）
 */
export function applySmartDark(
  canvas: HTMLCanvasElement,
  regions: ImageRegion[],
  policy: PdfImagePolicy,
  brightness: number
): number {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return 0
  const started = performance.now()
  const { width, height } = canvas
  if (width === 0 || height === 0) return 0
  const image = ctx.getImageData(0, 0, width, height)
  const data = image.data

  const gridW = Math.ceil(width / BLOCK)
  const gridH = Math.ceil(height / BLOCK)
  const mask = new Uint8Array(gridW * gridH)
  for (const region of regions) {
    const x0 = Math.max(0, Math.floor(region.x * width))
    const x1 = Math.min(width, Math.ceil((region.x + region.width) * width))
    const y0 = Math.max(0, Math.floor(region.y * height))
    const y1 = Math.min(height, Math.ceil((region.y + region.height) * height))
    for (let gy = Math.floor(y0 / BLOCK); gy <= Math.floor((y1 - 1) / BLOCK); gy += 1) {
      for (let gx = Math.floor(x0 / BLOCK); gx <= Math.floor((x1 - 1) / BLOCK); gx += 1) {
        if (gx >= 0 && gy >= 0 && gx < gridW && gy < gridH) mask[gy * gridW + gx] = 1
      }
    }
  }

  for (let y = 0; y < height; y += 1) {
    const rowBase = y * width
    const gridRow = Math.floor(y / BLOCK) * gridW
    for (let x = 0; x < width; x += 1) {
      const index = (rowBase + x) * 4
      if (data[index + 3] === 0) continue
      const r = data[index]
      const g = data[index + 1]
      const b = data[index + 2]
      if (mask[gridRow + Math.floor(x / BLOCK)] === 1) {
        if (policy === 'keep') continue
        if (policy === 'brighten') {
          data[index] = Math.min(255, Math.round(r * brightness + 24))
          data[index + 1] = Math.min(255, Math.round(g * brightness + 24))
          data[index + 2] = Math.min(255, Math.round(b * brightness + 24))
          continue
        }
        // invert：与文字区域一致的处理
      }
      const max = r > g ? (r > b ? r : b) : g > b ? g : b
      const min = r < g ? (r < b ? r : b) : g < b ? g : b
      if (max - min < 22) {
        // 灰度像素（正文与纸张）走快速通道
        data[index] = 255 - r
        data[index + 1] = 255 - g
        data[index + 2] = 255 - b
      } else {
        const [nr, ng, nb] = invertLightness(r, g, b)
        data[index] = nr
        data[index + 1] = ng
        data[index + 2] = nb
      }
    }
  }
  ctx.putImageData(image, 0, 0)
  return performance.now() - started
}

export function cssFilterFor(mode: PdfDarkMode): string {
  return mode === 'invert' ? 'invert(1) hue-rotate(180deg)' : 'none'
}

export function needsPixelProcessing(mode: PdfDarkMode, policy: PdfImagePolicy | null): boolean {
  return mode === 'smart'
}

void needsPixelProcessing
