import { useTranslation } from 'react-i18next'
import { useNotifications } from '../state/notifications.store'
import { IconCheck, IconClose, IconError, IconInfo, IconWarning } from './icons'

export function Notifications(): JSX.Element | null {
  const { t } = useTranslation()
  const { items, dismiss, clear } = useNotifications()
  if (items.length === 0) return null

  return (
    <div className="lr-notifications">
      <div className="lr-notifications__header">
        <span>{t('notifications.title')}</span>
        <button className="lr-icon-button" title={t('notifications.clear')} onClick={clear}>
          <IconClose />
        </button>
      </div>
      {items.map((item) => {
        const Icon = item.severity === 'error' ? IconError : item.severity === 'warning' ? IconWarning : item.severity === 'success' ? IconCheck : IconInfo
        return (
          <div key={item.id} className="lr-notification" data-severity={item.severity}>
            <div className="lr-notification__header">
              <span className="lr-notification__icon">
                <Icon />
              </span>
              <div className="lr-notification__message">{item.message}</div>
              <button className="lr-icon-button" onClick={() => dismiss(item.id)} title={t('common.close')}>
                <IconClose />
              </button>
            </div>
            {item.detail ? <div className="lr-notification__detail">{item.detail}</div> : null}
            {item.actions && item.actions.length > 0 ? (
              <div className="lr-notification__actions">
                {item.actions.map((action, index) => (
                  <button
                    key={index}
                    className="lr-button lr-button--secondary"
                    onClick={() => {
                      void action.run()
                      if (!action.keepOpen) dismiss(item.id)
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
