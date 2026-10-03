/** 文档格式识别与阅读器路由。 */

export type DocumentFormat = 'pdf' | 'markdown' | 'docx' | 'doc' | 'sheet' | 'slide' | 'text'

export interface FormatDescriptor {
  format: DocumentFormat
  /** 阅读器视图 id */
  reader: 'reader-pdf' | 'reader-markdown' | 'reader-docx' | 'reader-sheet' | 'reader-text'
  /** 是否需要 LibreOffice 转换 */
  needsLibreOffice: boolean
  label: string
}

const TABLE: Record<string, FormatDescriptor> = {
  '.pdf': { format: 'pdf', reader: 'reader-pdf', needsLibreOffice: false, label: 'PDF' },
  '.md': { format: 'markdown', reader: 'reader-markdown', needsLibreOffice: false, label: 'Markdown' },
  '.markdown': { format: 'markdown', reader: 'reader-markdown', needsLibreOffice: false, label: 'Markdown' },
  '.mdx': { format: 'markdown', reader: 'reader-markdown', needsLibreOffice: false, label: 'MDX' },
  '.docx': { format: 'docx', reader: 'reader-docx', needsLibreOffice: false, label: 'Word' },
  '.doc': { format: 'doc', reader: 'reader-pdf', needsLibreOffice: true, label: 'Word 97-2003' },
  '.rtf': { format: 'doc', reader: 'reader-pdf', needsLibreOffice: true, label: 'RTF' },
  '.odt': { format: 'doc', reader: 'reader-pdf', needsLibreOffice: true, label: 'OpenDocument 文本文档' },
  '.xlsx': { format: 'sheet', reader: 'reader-sheet', needsLibreOffice: false, label: 'Excel' },
  '.xls': { format: 'sheet', reader: 'reader-sheet', needsLibreOffice: false, label: 'Excel 97-2003' },
  '.xlsm': { format: 'sheet', reader: 'reader-sheet', needsLibreOffice: false, label: 'Excel 宏工作簿' },
  '.csv': { format: 'sheet', reader: 'reader-sheet', needsLibreOffice: false, label: 'CSV' },
  '.ods': { format: 'sheet', reader: 'reader-sheet', needsLibreOffice: true, label: 'OpenDocument 表格' },
  '.pptx': { format: 'slide', reader: 'reader-pdf', needsLibreOffice: true, label: 'PowerPoint' },
  '.ppt': { format: 'slide', reader: 'reader-pdf', needsLibreOffice: true, label: 'PowerPoint 97-2003' },
  '.odp': { format: 'slide', reader: 'reader-pdf', needsLibreOffice: true, label: 'OpenDocument 演示文稿' },
  '.txt': { format: 'text', reader: 'reader-text', needsLibreOffice: false, label: '纯文本' },
  '.log': { format: 'text', reader: 'reader-text', needsLibreOffice: false, label: '日志' },
  '.json': { format: 'text', reader: 'reader-text', needsLibreOffice: false, label: 'JSON' },
  '.yml': { format: 'text', reader: 'reader-text', needsLibreOffice: false, label: 'YAML' },
  '.yaml': { format: 'text', reader: 'reader-text', needsLibreOffice: false, label: 'YAML' }
}

/** 打开文件对话框用的过滤器。 */
export const FILE_FILTERS = [
  { name: '全部支持的文档', extensions: Object.keys(TABLE).map((e) => e.slice(1)) },
  { name: 'PDF', extensions: ['pdf'] },
  { name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] },
  { name: 'Word', extensions: ['docx', 'doc', 'rtf', 'odt'] },
  { name: '表格', extensions: ['xlsx', 'xls', 'xlsm', 'csv', 'ods'] },
  { name: '演示文稿', extensions: ['pptx', 'ppt', 'odp'] },
  { name: '纯文本', extensions: ['txt', 'log', 'json', 'yml', 'yaml'] },
  { name: '全部文件', extensions: ['*'] }
]

export function extname(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath
  const i = base.lastIndexOf('.')
  return i <= 0 ? '' : base.slice(i).toLowerCase()
}

export function basename(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() ?? filePath
}

export function stripExtension(filePath: string): string {
  const base = basename(filePath)
  const i = base.lastIndexOf('.')
  return i <= 0 ? base : base.slice(0, i)
}

export function dirname(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i <= 0 ? norm : norm.slice(0, i)
}

export function describeFormat(filePath: string): FormatDescriptor | null {
  return TABLE[extname(filePath)] ?? null
}

export function isSupported(filePath: string): boolean {
  return describeFormat(filePath) !== null
}
