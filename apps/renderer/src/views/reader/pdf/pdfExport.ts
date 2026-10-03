/** 用 pdf-lib 把标注写入新的 PDF 副本（原文件不动）—— 规划书 FR-4.7。 */
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFNumber, PDFHexString, rgb, type PDFPage } from 'pdf-lib'
import { api } from '../../../lib/api'

export interface ExportAnnotation {
  kind: 'highlight' | 'underline' | 'strike' | 'note' | 'rect' | 'arrow' | 'ink'
  color: string
  note: string | null
  page: number
  /** 归一化矩形（原点左上） */
  rects: { x: number; y: number; width: number; height: number }[]
  /** 自由涂鸦的归一化点序列 */
  points?: { x: number; y: number }[]
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  const num = Number.parseInt(full.slice(0, 6) || 'ffff00', 16)
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255]
}

function toPdfRect(rect: { x: number; y: number; width: number; height: number }, pageWidth: number, pageHeight: number): number[] {
  const x1 = rect.x * pageWidth
  const x2 = (rect.x + rect.width) * pageWidth
  const y2 = pageHeight - rect.y * pageHeight
  const y1 = pageHeight - (rect.y + rect.height) * pageHeight
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]
}

function addAnnot(page: PDFPage, subtype: string, rect: number[], color: [number, number, number], alpha = 0.35): PDFDict {
  const context = page.doc.context
  const dict = context.obj({}) as PDFDict
  dict.set(PDFName.of('Type'), PDFName.of('Annot'))
  dict.set(PDFName.of('Subtype'), PDFName.of(subtype))
  dict.set(PDFName.of('Rect'), context.obj(rect))
  dict.set(PDFName.of('C'), context.obj([color[0], color[1], color[2]]))
  dict.set(PDFName.of('F'), PDFNumber.of(4))
  dict.set(PDFName.of('CA'), PDFNumber.of(alpha))
  page.node.addAnnot(context.register(dict))
  return dict
}

export async function exportAnnotatedPdf(
  inputPath: string,
  outputPath: string,
  annotations: ExportAnnotation[]
): Promise<number> {
  const bytes = await api.fs.readBinary(inputPath)
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  const pages = pdf.getPages()
  let written = 0

  for (const annotation of annotations) {
    const page = pages[annotation.page - 1]
    if (!page) continue
    const { width, height } = page.getSize()
    const color = hexToRgb(annotation.color)
    const rects = annotation.rects.length > 0 ? annotation.rects : [{ x: 0.05, y: 0.05, width: 0.2, height: 0.03 }]
    const pdfRects = rects.map((rect) => toPdfRect(rect, width, height))
    const unionRect = pdfRects.reduce(
      (acc, rect) => [
        Math.min(acc[0], rect[0]),
        Math.min(acc[1], rect[1]),
        Math.max(acc[2], rect[2]),
        Math.max(acc[3], rect[3])
      ],
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
    )

    const context = page.doc.context
    let dict: PDFDict | null = null
    switch (annotation.kind) {
      case 'highlight':
      case 'underline':
      case 'strike': {
        const subtype = annotation.kind === 'highlight' ? 'Highlight' : annotation.kind === 'underline' ? 'Underline' : 'StrikeOut'
        dict = addAnnot(page, subtype, unionRect, color, annotation.kind === 'highlight' ? 0.4 : 0)
        const quadPoints: number[] = []
        for (const rect of pdfRects) {
          quadPoints.push(rect[0], rect[3], rect[2], rect[3], rect[0], rect[1], rect[2], rect[1])
        }
        dict.set(PDFName.of('QuadPoints'), context.obj(quadPoints))
        break
      }
      case 'rect':
        dict = addAnnot(page, 'Square', unionRect, color, 0)
        break
      case 'arrow': {
        dict = addAnnot(page, 'Line', unionRect, color, 0)
        dict.set(
          PDFName.of('L'),
          context.obj([unionRect[0], unionRect[1], unionRect[2], unionRect[3]])
        )
        break
      }
      case 'ink': {
        dict = addAnnot(page, 'Ink', unionRect, color, 0)
        const points = annotation.points ?? []
        if (points.length > 1) {
          const path: number[] = []
          for (const point of points) {
            path.push(point.x * width, height - point.y * height)
          }
          const inkList = context.obj([context.obj(path)]) as PDFArray
          dict.set(PDFName.of('InkList'), inkList)
        }
        break
      }
      case 'note':
      default: {
        dict = addAnnot(page, 'Text', unionRect, color, 0)
        break
      }
    }

    if (dict && annotation.note) {
      dict.set(PDFName.of('Contents'), PDFHexString.fromText(annotation.note))
    }
    written += 1
  }

  const out = await pdf.save({ useObjectStreams: true })
  await api.fs.writeBinary(outputPath, new Uint8Array(out))
  return written
}

export { rgb }
