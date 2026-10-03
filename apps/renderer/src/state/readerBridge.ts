/**
 * 阅读器桥：当前激活的阅读器把自身能力注册进来，
 * 命令面板 / 快捷键 / 浮动工具条通过它调用，避免把具体视图耦合进命令层。
 */
export interface ReaderController {
  docId: string
  tabId: string
  kind: 'pdf' | 'markdown' | 'docx' | 'sheet' | 'text'
  zoomIn: () => void
  zoomOut: () => void
  zoomFitWidth: () => void
  zoomFitPage: () => void
  zoomActual: () => void
  /** 直接按比例设置缩放（1 = 100%），用于手动输入倍率 */
  setZoom: (scale: number) => void
  rotate: () => void
  setViewMode: (mode: 'single' | 'continuous' | 'spread') => void
  nextPage: () => void
  previousPage: () => void
  gotoPage: (page: number) => void
  find: (query: string) => void
  findNext: () => void
  findPrevious: () => void
  openFind: () => void
  addAnnotation: (kind: 'highlight' | 'underline' | 'strike' | 'note' | 'rect' | 'arrow' | 'ink') => void
  deleteActiveAnnotation: () => void
  clearAnnotations: () => void
  exportAnnotated: () => void
  revealRange: (charStart: number, charEnd: number) => void
  copyCitation: () => string
}

let controller: ReaderController | null = null

export function registerReaderController(next: ReaderController | null): () => void {
  controller = next
  return () => {
    if (controller === next) controller = null
  }
}

export function activeReader(): ReaderController | null {
  return controller
}
