import type { DocumentFormat } from '@logicreader/shared'
import type { DocumentModel } from '@logicreader/document-model'

export interface ParseContext {
  filePath: string
  /** 实际读取字节的路径（.doc/.ppt 经 LibreOffice 转换后指向缓存 PDF） */
  readPath?: string
  docId: string
  docHash: string
  format: DocumentFormat
  title: string
  /** 解析进度回调（用于大文档） */
  onProgress?: (info: { page: number; total: number }) => void
}

export type DocumentParser = (ctx: ParseContext) => Promise<DocumentModel>
