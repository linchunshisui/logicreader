import { create } from 'zustand'

export interface SelectionInfo {
  docId: string
  tabId: string
  text: string
  charStart: number
  charEnd: number
  anchorId: string | null
  locationLabel: string
  /**
   * 选区在**视口**里的位置（选中范围的联合矩形）。
   * 浮动工具条用它把按钮组摆在**选区旁边**，而不是永远趴在视口底部
   * —— 底部固定在"选中的文字就在底部"时正好挡住选区（用户实测）。
   * 早期写入方（或恢复路径）没带这个字段时为 null，工具条退回底部定位。
   */
  rect: { x: number; y: number; width: number; height: number } | null
}

/** 跳转的来源：关系图里的哪个节点（阅读器据此在文段旁显示相关逻辑链） */
export interface RevealChain {
  nodeId: string
  /** 节点标题：面板头部直接用，省得再去查图数据 */
  title: string
  /** 触发入口：节点本身，还是某条连线 */
  via?: 'node' | 'edge'
}

export interface RevealRequest {
  docId: string
  charStart: number
  charEnd: number
  /** 每次请求递增，保证同一位置也能重复触发 */
  nonce: number
  /** 高亮持续时间（默认 1.6 秒，见规划书 §5.5.7） */
  durationMs?: number
  /**
   * 等待目标内容就绪的最长时间。
   * 阅读器标签是**按需挂载**的（EditorArea 只渲染当前标签），跳转到达时 DOM 往往还没准备好，
   * 由 `lib/revealRequest` 在这个窗口内重试；默认 6 秒。
   */
  readyTimeoutMs?: number
  /** 若定位不到则打开该 tab */
  tabId?: string
  /**
   * 让高亮**常驻**（直到下一次跳转或被手动关掉）。
   * 关系图跳转用它 —— 用户要求"跳转后高亮维持"；
   * 目录/查找/标注列表这类"路过看一眼"的入口仍然是默认的 1.6 秒闪一下。
   */
  hold?: boolean
  /** 本次跳转来自关系图的哪个节点 */
  chain?: RevealChain
}

interface UiState {
  commandPaletteOpen: boolean
  quickOpenOpen: boolean
  statusMessage: string
  statusMessageAt: number
  selection: SelectionInfo | null
  /** 当前聚焦的阅读器 tabId，用于状态栏与命令路由 */
  activeReaderTabId: string | null
  /** 阅读进度（状态栏） */
  readerProgress: { page: number; total: number; zoom: number; percent: number } | null
  revealRequest: RevealRequest | null
  /** 打开设置页时希望定位到的分类 */
  settingsCategory: string | null
  setSettingsCategory: (category: string | null) => void
  requestReveal: (request: Omit<RevealRequest, 'nonce'>) => void
  /** 结束这次跳转上下文（清掉常驻高亮与旁边的逻辑链面板） */
  clearReveal: () => void
  /** 聚焦 Agent 输入框的请求位（命令/快捷键发起；面板挂载后消费，非 0 即待处理） */
  agentFocusRequest: number
  requestAgentFocus: () => void
  consumeAgentFocus: () => void
  openCommandPalette: () => void
  closeCommandPalette: () => void
  toggleCommandPalette: () => void
  openQuickOpen: () => void
  closeQuickOpen: () => void
  setStatusMessage: (message: string) => void
  setSelection: (selection: SelectionInfo | null) => void
  setActiveReaderTab: (tabId: string | null) => void
  setReaderProgress: (progress: UiState['readerProgress']) => void
}

export const useUiStore = create<UiState>((set) => ({
  commandPaletteOpen: false,
  quickOpenOpen: false,
  statusMessage: '',
  statusMessageAt: 0,
  selection: null,
  activeReaderTabId: null,
  readerProgress: null,
  openCommandPalette: () => set({ commandPaletteOpen: true, quickOpenOpen: false }),
  closeCommandPalette: () => set({ commandPaletteOpen: false }),
  toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen, quickOpenOpen: false })),
  revealRequest: null,
  settingsCategory: null,
  setSettingsCategory: (category) => set({ settingsCategory: category }),
  requestReveal: (request) => set({ revealRequest: { ...request, nonce: Date.now() } }),
  clearReveal: () => set({ revealRequest: null }),
  agentFocusRequest: 0,
  requestAgentFocus: () => set({ agentFocusRequest: Date.now() }),
  consumeAgentFocus: () => set({ agentFocusRequest: 0 }),
  openQuickOpen: () => set({ quickOpenOpen: true, commandPaletteOpen: false }),
  closeQuickOpen: () => set({ quickOpenOpen: false }),
  setStatusMessage: (message) => set({ statusMessage: message, statusMessageAt: Date.now() }),
  setSelection: (selection) => set({ selection }),
  setActiveReaderTab: (tabId) => set({ activeReaderTabId: tabId }),
  setReaderProgress: (progress) => set({ readerProgress: progress })
}))

export function statusMessage(): string {
  return useUiStore.getState().statusMessage
}
