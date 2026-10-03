import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CMD, type AgentCapabilityView } from '@logicreader/shared'
import { api } from '../../lib/api'
import { useSettings } from '../../state/settings.store'
import { executeCommand } from '../../state/commands.store'
import { notify } from '../../state/notifications.store'

/** 首次启动向导（规划书 §8.4）：主题 → 语言 → 探测 Agent → LibreOffice 方案。 */
export function FirstRunWizard({ onDone }: { onDone: () => void }): JSX.Element {
  const { t } = useTranslation()
  const { settings, patch } = useSettings()
  const [step, setStep] = useState(0)
  const [agents, setAgents] = useState<AgentCapabilityView[] | null>(null)
  const [libreOffice, setLibreOffice] = useState<{ available: boolean; version: string | null; reason: string | null } | null>(null)

  useEffect(() => {
    if (step !== 2 || agents) return
    void api.agent.probeAll(true).then(setAgents).catch(() => setAgents([]))
  }, [step, agents])

  useEffect(() => {
    if (step !== 3 || libreOffice) return
    void api.convert.availability(true).then(setLibreOffice).catch(() => setLibreOffice(null))
  }, [step, libreOffice])

  const steps = [t('settings.appearance.theme'), t('settings.appearance.locale'), t('activity.agent'), 'LibreOffice']

  return (
    <div className="lr-overlay">
      <div className="lr-dialog lr-wizard">
        <div className="lr-wizard__steps">
          {steps.map((label, index) => (
            <div key={label} className="lr-wizard__step" data-active={index === step} data-done={index < step}>
              <span className="lr-wizard__index">{index + 1}</span>
              {label}
            </div>
          ))}
        </div>

        {step === 0 ? (
          <div className="lr-wizard__body">
            <p>{t('settings.appearance.theme')}</p>
            <div className="lr-wizard__choices">
              {(['system', 'light', 'dark'] as const).map((value) => (
                <button
                  key={value}
                  className="lr-dialog__precision-item"
                  data-active={settings.theme === value}
                  onClick={() => void patch({ theme: value })}
                >
                  {value === 'system'
                    ? t('settings.appearance.themeSystem')
                    : value === 'light'
                      ? t('settings.appearance.themeLight')
                      : t('settings.appearance.themeDark')}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="lr-wizard__body">
            <p>{t('settings.appearance.locale')}</p>
            <div className="lr-wizard__choices">
              {[
                { value: 'system', label: t('settings.appearance.localeSystem') },
                { value: 'zh-CN', label: '简体中文' },
                { value: 'en-US', label: 'English' }
              ].map((option) => (
                <button
                  key={option.value}
                  className="lr-dialog__precision-item"
                  data-active={settings.locale === option.value}
                  onClick={() => void patch({ locale: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="lr-wizard__body">
            <p>{t('settings.agent.detected')}</p>
            {!agents ? (
              <div className="lr-wizard__loading">
                <div className="lr-spinner" />
                {t('agent.probing')}
              </div>
            ) : (
              <ul className="lr-wizard__list">
                {agents.map((agent) => (
                  <li key={agent.id}>
                    <span data-available={agent.available}>{agent.available ? '✓' : '✗'}</span>
                    {agent.displayName}
                    <span className="lr-setting__hint">{agent.version ?? agent.error ?? ''}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="lr-setting__hint">{t('welcome.agentNone')}</p>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="lr-wizard__body">
            <p>LibreOffice</p>
            {libreOffice?.available ? (
              <p>
                ✓ {libreOffice.version ?? ''} — {t('welcome.libreOfficeReady')}
              </p>
            ) : (
              <>
                <p>{t('welcome.libreOfficeMissing')}</p>
                <div className="lr-wizard__choices">
                  <button
                    className="lr-button lr-button--secondary"
                    onClick={async () => {
                      const result = await api.convert.pickLibreOffice()
                      if (result) setLibreOffice(result)
                    }}
                  >
                    {t('settings.agent.addDir')}
                  </button>
                  <button className="lr-button lr-button--secondary" onClick={() => setStep(4)}>
                    {t('graph.askLater')}
                  </button>
                </div>
              </>
            )}
          </div>
        ) : null}

        {step === 4 ? (
          <div className="lr-wizard__body">
            <p>{t('welcome.tip')}</p>
            <p className="lr-setting__hint">{t('settings.storage.clearSession')}</p>
          </div>
        ) : null}

        <div className="lr-dialog__actions">
          {step > 0 ? (
            <button className="lr-button lr-button--secondary" onClick={() => setStep((value) => value - 1)}>
              {t('common.cancel')}
            </button>
          ) : null}
          {step < 4 ? (
            <button className="lr-button" onClick={() => setStep((value) => value + 1)}>
              {t('common.confirm')}
            </button>
          ) : (
            <button
              className="lr-button"
              onClick={() => {
                notify(t('welcome.title') + ' · ' + t('welcome.subtitle'), 'success')
                onDone()
              }}
            >
              {t('common.ok')}
            </button>
          )}
          <button
            className="lr-button lr-button--secondary"
            onClick={() => {
              onDone()
              void executeCommand(CMD.fileOpen)
            }}
          >
            {t('welcome.openFile')}
          </button>
        </div>
      </div>
    </div>
  )
}
