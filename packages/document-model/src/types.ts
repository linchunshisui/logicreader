/** 统一文档模型与锚点系统 —— 规划书 §5.1，是整个产品的地基。 */
import type { DocumentFormat } from '@logicreader/shared'

export type BlockKind =
  | 'heading' | 'paragraph' | 'list-item' | 'code' | 'table'
  | 'image' | 'quote' | 'formula' | 'page-break' | 'cell' | 'shape'

export interface Rect {
  /** 归一化坐标 0..1（相对页面宽高） */
  x: number
  y: number
  width: number
  height: number
}

export type Locator =
  | {
      kind: 'pdf'
      page: number
      rects: Rect[]
      /**
       * 选区在文档文本中的**片段列表**（按文档顺序）。
       * 一次划选未必对应连续区间：图表标签、多栏混排时，选中的文字在文档模型里可能是若干段。
       * charStart/charEnd 仍是这些片段的最小包围区间（供分块、AI 上下文等按区间工作的模块使用），
       * fragments 才是"用户到底选了什么"的精确定义。
       */
      fragments?: { start: number; end: number }[]
    }
  | { kind: 'text'; line: number; column: number }
  | { kind: 'docx'; paraIndex: number; runRange?: [number, number] }
  | { kind: 'sheet'; sheet: string; range: string }
  | { kind: 'slide'; slide: number; shapeId?: string }

export interface Block {
  id: string
  docId: string
  seq: number
  kind: BlockKind
  level?: number
  text: string
  charStart: number
  charEnd: number
  locator: Locator
  parentId?: string
  /** 附加信息：如表格的行列、图片尺寸、代码语言 */
  meta?: Record<string, unknown>
}

export interface OutlineNode {
  id: string
  title: string
  level: number
  blockId: string
  charStart: number
  /** 格式原生跳转目标（PDF 的 dest、DOCX 的段落索引等） */
  locator?: Locator
  children: OutlineNode[]
}

export interface Anchor {
  id: string
  docId: string
  docHash: string
  blockIds: string[]
  charStart: number
  charEnd: number
  quote: string
  quoteHash: string
  primary: Locator
  extras: Locator[]
  status: 'ok' | 'stale'
  /** 是否由用户手动创建（用于区分自动抽取的锚点） */
  origin?: 'selection' | 'graph' | 'annotation' | 'search'
  createdAt?: number
}

export interface DocumentModel {
  docId: string
  docHash: string
  format: DocumentFormat
  title: string
  filePath: string
  blocks: Block[]
  /** 归一化全文；blocks 的 charStart/charEnd 均指向该字符串 */
  text: string
  outline: OutlineNode[]
  pageCount: number | null
  meta: Record<string, unknown>
}

export function emptyDocumentModel(partial: Partial<DocumentModel> & { docId: string; docHash: string; filePath: string; title: string; format: DocumentFormat }): DocumentModel {
  return {
    blocks: [],
    text: '',
    outline: [],
    pageCount: null,
    meta: {},
    ...partial
  }
}
