/**
 * "从关系图跳到原文"的唯一实现 —— 节点单击后的「跳转」按钮、连线跳转、
 * 以及旁边逻辑链面板里的每一跳，全部走这里，避免同类动作出现两套行为。
 *
 * 两件事：
 *  1. 打开（或按文件路径重开）目标文档的阅读器标签 —— 规划书 §5.5.7 的原话是"打开文档"；
 *  2. 发出定位请求：`hold` 让高亮常驻（关系图跳转），`chain` 带上来源节点，
 *     阅读器据此在文段旁边显示这个节点的局部逻辑链。
 *
 * 定位请求由阅读器侧的 `useRevealRequest` 在内容就绪后落地（见 lib/revealRequest.ts）。
 */
import type { EditorTab } from '@logicreader/shared'
import { describeLocator } from '@logicreader/document-model'
import { openFileInWorkbench } from '../commands'
import i18n from '../i18n'
import { api } from './api'
import { useDocuments } from '../state/documents.store'
import { useTabs } from '../state/tabs.store'
import { useUiStore, type RevealChain } from '../state/ui.store'

export interface RevealOptions {
  /** 高亮常驻（关系图跳转用），而不是 1.6 秒闪一下 */
  hold?: boolean
  /** 来源节点（关系图），阅读器会在文段旁显示它的局部逻辑链 */
  chain?: RevealChain
}

export async function revealInReader(
  docId: string,
  charStart: number,
  charEnd: number,
  options: RevealOptions = {}
): Promise<boolean> {
  const tabs = useTabs.getState()
  const findReader = (): EditorTab | null =>
    tabs.groups.flatMap((group) => group.tabs).find((tab) => tab.kind === 'reader' && tab.docId === docId) ?? null
  let readerTab = findReader()
  if (!readerTab) {
    /*
     * 会话里只有关系图标签时（阅读器被关掉，或上次退出时就没开），文档模型不在内存里，
     * 因此除了内存里的 filePath，还要回数据库取一次 —— 否则"图还在、文档打不开"，
     * 跳转又变成静默失败。
     */
    const filePath =
      useDocuments.getState().models[docId]?.filePath ?? (await api.store.getDocument(docId))?.path ?? null
    if (!filePath) return false
    const tabId = await openFileInWorkbench(filePath)
    if (!tabId) return false
    readerTab = useTabs.getState().findTab(tabId)
  }
  if (readerTab) useTabs.getState().activate(readerTab.id)
  useUiStore.getState().requestReveal({
    docId,
    charStart,
    charEnd,
    hold: options.hold,
    chain: options.chain
  })
  return true
}

/** 字符偏移 → 人话位置（"第 12 页" / "第 3 行" / "Sheet1!A5:E5"…），用于来源角标与状态栏 */
export function locationLabel(docId: string, charStart: number): string {
  const model = useDocuments.getState().models[docId]
  if (!model) return ''
  const block = model.blocks.find((item) => item.charStart <= charStart && item.charEnd >= charStart)
  return block ? describeLocator(block.locator, { locale: i18n.language }) : ''
}
