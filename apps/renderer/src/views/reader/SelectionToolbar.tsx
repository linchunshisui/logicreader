import { useTranslation } from 'react-i18next'
import { useUiStore } from '../../state/ui.store'
import { executeCommand } from '../../state/commands.store'
import { CMD } from '@logicreader/shared'

/** 选区浮动工具条（规划书 §5.6.2）。位置固定在视口右下，避免遮挡选区。 */
export function SelectionToolbar(): JSX.Element | null {
  const { t } = useTranslation()
  const selection = useUiStore((s) => s.selection)
  if (!selection) return null

  const actions: { id: string; label: string; command?: string }[] = [
    { id: 'explain', label: t('reader.selectionToolbar.explain'), command: CMD.agentExplainSelection },
    { id: 'ask', label: t('reader.selectionToolbar.ask'), command: CMD.agentAskSelection },
    { id: 'translate', label: t('reader.selectionToolbar.translate'), command: CMD.agentTranslateSelection },
    { id: 'graph', label: t('reader.selectionToolbar.addToGraph'), command: CMD.agentAddSelectionToGraph },
    // 高亮已停用（产品决定：选中文字不需要再加色块）
    { id: 'citation', label: t('reader.selectionToolbar.copyCitation'), command: CMD.agentCopyCitation }
  ]

  return (
    <div className="lr-selection-toolbar">
      {actions.map((action) => (
        <button
          key={action.id}
          className="lr-selection-toolbar__item"
          onClick={() => action.command && void executeCommand(action.command)}
        >
          {action.label}
        </button>
      ))}
    </div>
  )
}
