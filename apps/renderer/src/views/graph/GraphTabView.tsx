import type { GraphTab } from '@logicreader/shared'
import { GraphCanvas } from './GraphCanvas'

/** 关系图标签页：画布 + 工具栏 + 质量报告 + 生成对话框。 */
export function GraphTabView({ tab }: { tab: GraphTab }): JSX.Element {
  return <GraphCanvas docId={tab.docId} />
}
