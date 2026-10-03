/**
 * 关系图的显示名：**文档名 + 逻辑关系图**。
 *
 * 为什么单独抽出来：图不再是一个孤立的"关系图"标签页 —— 它与论文绑定，
 * 标签栏里可能同时开着好几篇论文的图，标题必须一眼看出这张图属于哪篇。
 * 名字只有渲染进程能给出（界面语言在这边），三处共用它：
 *   1. 关系图标签页的标题（也可由 GraphCanvas 在恢复会话/切语言后对齐）；
 *   2. 导出文件的默认文件名（JSON / Markdown / SVG / PNG / JPG）；
 *   3. 主进程落库的 `graph.title` 用同一规则生成（那边按系统语言，见 graph.service）。
 */
import i18n from '../i18n'
import { useDocuments } from '../state/documents.store'
import { useTabs } from '../state/tabs.store'

/**
 * @param storedTitle 主进程落库的 `graph.title`（渲染进程拿不到文档名时用它兜底）
 *
 * 为什么需要兜底：会话里可能**只恢复了关系图标签**（论文没打开，模型不在内存里），
 * 这时光看 docId 是拼不出名字的 —— 而落库标题就是同一个规则生成的
 * （`graph.service.graphDisplayTitle`）。旧图（本次改动之前生成的）标题里没有后缀，
 * 这里补上，避免同一个标签一会儿带后缀一会儿不带。
 */
export function graphDisplayName(docId: string, storedTitle?: string | null): string {
  const suffix = i18n.t('graph.title')
  const model = useDocuments.getState().models[docId]
  const readerTab = useTabs.getState().findByDoc(docId, 'reader')
  const fromTab = readerTab?.kind === 'reader' ? readerTab.title : ''
  const docTitle = (model?.title || fromTab || '').trim()
  if (docTitle) return docTitle + ' · ' + suffix
  const stored = (storedTitle ?? '').trim()
  if (!stored) return suffix
  return stored.includes(suffix) ? stored : stored + ' · ' + suffix
}
