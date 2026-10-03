import { forwardRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useLayout } from '../state/layout.store'
import { AgentSidebarView } from '../features/agent/AgentSidebarView'
import { IconClose, IconPlus } from './icons'

/**
 * 宽度由 Workbench 通过 CSS 变量 `--lr-aux-w` 驱动（拖拽期间直接改变量，不重渲染）。
 * 这里**不再**用内联 `style.width`，否则内联样式会盖过变量、拖拽时宽度不动。
 */
export const AuxBar = forwardRef<HTMLElement>(function AuxBar(_props, ref): JSX.Element {
  const { t } = useTranslation()
  const { auxView, toggleAuxBar } = useLayout()

  return (
    <aside className="lr-auxbar" ref={ref}>
      <div className="lr-auxbar__header">
        <span>{t('agent.title')}</span>
        <div className="lr-auxbar__actions">
          <button className="lr-icon-button" title={t('agent.newSession')} disabled>
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
