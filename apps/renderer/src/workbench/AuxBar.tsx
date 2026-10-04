import { forwardRef } from 'react'
import { useTranslation } from 'react-i18next'
import { CMD } from '@logicreader/shared'
import { useLayout } from '../state/layout.store'
import { AgentSidebarView } from '../features/agent/AgentSidebarView'
import { executeCommand } from '../state/commands.store'
import { IconClose, IconPlus } from './icons'

/**
 * 宽度由 Workbench 通过 CSS 变量 `--lr-aux-w` 驱动（拖拽期间直接改变量，不重渲染）。
 * 这里**不再**用内联 `style.width`，否则内联样式会盖过变量、拖拽时宽度不动。
 *
 * 头部的 ＋ = 新建 Agent 会话：**长期是 disabled 的摆设**（用户点它毫无反应，还以为面板坏了），
 * 现在接通与「Agent 菜单 → 新建会话」同一条命令（真的清会话，不只是开面板）。
 */
export const AuxBar = forwardRef<HTMLElement>(function AuxBar(_props, ref): JSX.Element {
  const { t } = useTranslation()
  const { auxView, toggleAuxBar } = useLayout()

  return (
    <aside className="lr-auxbar" ref={ref}>
      <div className="lr-auxbar__header">
        <span>{t('agent.title')}</span>
        <div className="lr-auxbar__actions">
          <button
            className="lr-icon-button"
            title={t('agent.newSession')}
            onClick={() => void executeCommand(CMD.agentNewSession)}
          >
            <IconPlus />
          </button>
          <button className="lr-icon-button" title={t('common.close')} onClick={() => toggleAuxBar(false)}>
            <IconClose />
          </button>
        </div>
      </div>
      <div className="lr-auxbar__body">
        {auxView === 'agent' ? <AgentSidebarView /> : null}
      </div>
    </aside>
  )
})
