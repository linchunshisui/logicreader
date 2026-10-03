import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CMD } from '@logicreader/shared'
import { useSettings } from '../../state/settings.store'
import { api } from '../../lib/api'
import { executeCommand } from '../../state/commands.store'
import { notify } from '../../state/notifications.store'
import { useUiStore } from '../../state/ui.store'

type CategoryId = 'appearance' | 'reader' | 'agent' | 'graph' | 'storage' | 'about'

const CATEGORIES: { id: CategoryId; labelKey: string }[] = [
  { id: 'appearance', labelKey: 'settings.category.appearance' },
  { id: 'reader', labelKey: 'settings.category.reader' },
  { id: 'agent', labelKey: 'settings.category.agent' },
  { id: 'graph', labelKey: 'settings.category.graph' },
  { id: 'storage', labelKey: 'settings.category.storage' },
  { id: 'about', labelKey: 'settings.category.about' }
]

export function SettingsView(): JSX.Element {
  const { t } = useTranslation()
  const { settings, patch, appInfo } = useSettings()
  const [category, setCategory] = useState<CategoryId>(
    () => (useUiStore.getState().settingsCategory as CategoryId | null) ?? 'appearance'
  )

  useEffect(() => {
    const requested = useUiStore.getState().settingsCategory as CategoryId | null
    if (requested) {
      setCategory(requested)
      useUiStore.getState().setSettingsCategory(null)
    }
  }, [])
  const [stats, setStats] = useState<Record<string, number> | null>(null)

  const row = (label: string, control: JSX.Element, hint?: string): JSX.Element => (
    <div className="lr-setting" key={label}>
      <div className="lr-setting__label">
        <span>{label}</span>
        {hint ? <span className="lr-setting__hint">{hint}</span> : null}
      </div>
      <div className="lr-setting__control">{control}</div>
    </div>
  )

  const select = (value: string, options: { value: string; label: string }[], onChange: (v: string) => void): JSX.Element => (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )

  const checkbox = (checked: boolean, onChange: (v: boolean) => void): JSX.Element => (
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
  )

  return (
    <div className="lr-settings lr-scroll">
      <div className="lr-settings__inner">
        <h1 className="lr-settings__title">{t('settings.title')}</h1>
        <nav className="lr-settings__nav">
          {CATEGORIES.map((item) => (
            <button
              key={item.id}
              className="lr-settings__nav-item"
              data-active={category === item.id}
              onClick={() => setCategory(item.id)}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </nav>

        <div className="lr-settings__body">
          {category === 'appearance' ? (
            <>
              {row(
                t('settings.appearance.theme'),
                select(
                  settings.theme,
                  [
                    { value: 'system', label: t('settings.appearance.themeSystem') },
                    { value: 'light', label: t('settings.appearance.themeLight') },
                    { value: 'dark', label: t('settings.appearance.themeDark') }
                  ],
                  (value) => void patch({ theme: value })
                )
              )}
              {row(
                t('settings.appearance.locale'),
                select(
                  settings.locale,
                  [
                    { value: 'system', label: t('settings.appearance.localeSystem') },
                    { value: 'zh-CN', label: '简体中文' },
                    { value: 'en-US', label: 'English' }
                  ],
                  (value) => void patch({ locale: value })
                )
              )}
              {row(
                t('settings.appearance.readerThemeOverride'),
                select(
                  settings.readerThemeOverride,
                  [
                    { value: 'inherit', label: t('settings.appearance.readerThemeInherit') },
                    { value: 'light', label: t('settings.appearance.readerThemeLight') },
                    { value: 'dark', label: t('settings.appearance.readerThemeDark') }
                  ],
                  (value) => void patch({ readerThemeOverride: value })
                )
              )}
              {row(
                t('settings.appearance.uiScale'),
                <input
                  type="range"
                  min={0.8}
                  max={1.6}
                  step={0.05}
                  value={settings.uiScale}
                  onChange={(event) => void patch({ uiScale: Number(event.target.value) })}
                />,
                settings.uiScale.toFixed(2) + '×'
              )}
            </>
          ) : null}

          {category === 'reader' ? (
            <>
              {row(
                t('settings.reader.pdfDarkMode'),
                select(
                  settings.pdfDarkMode,
                  [
                    { value: 'off', label: t('settings.reader.pdfDarkOff') },
                    { value: 'invert', label: t('settings.reader.pdfDarkInvert') },
                    { value: 'smart', label: t('settings.reader.pdfDarkSmart') }
                  ],
                  (value) => void patch({ pdfDarkMode: value })
                )
              )}
              {row(
                t('settings.reader.pdfImagePolicy'),
                select(
                  settings.pdfImagePolicy,
                  [
                    { value: 'keep', label: t('settings.reader.imageKeep') },
                    { value: 'brighten', label: t('settings.reader.imageBrighten') },
                    { value: 'invert', label: t('settings.reader.imageInvert') }
                  ],
                  (value) => void patch({ pdfImagePolicy: value })
                )
              )}
              {row(
                t('settings.reader.viewMode'),
                select(
                  settings.reader.viewMode,
                  [
                    { value: 'single', label: t('settings.reader.viewSingle') },
                    { value: 'continuous', label: t('settings.reader.viewContinuous') },
                    { value: 'spread', label: t('settings.reader.viewSpread') }
                  ],
                  (value) => void patch({ reader: { viewMode: value } })
                )
              )}
              {row(
                t('settings.reader.contextParagraphs'),
                <div className="lr-setting__inline">
                  <input
                    type="number"
                    min={0}
                    max={5}
                    value={settings.reader.contextParagraphsBefore}
                    onChange={(event) =>
                      void patch({ reader: { contextParagraphsBefore: Number(event.target.value) } })
                    }
                  />
                  <span>{t('settings.reader.contextBefore', { n: settings.reader.contextParagraphsBefore })}</span>
                  <input
                    type="number"
                    min={0}
                    max={5}
                    value={settings.reader.contextParagraphsAfter}
                    onChange={(event) =>
                      void patch({ reader: { contextParagraphsAfter: Number(event.target.value) } })
                    }
                  />
                  <span>{t('settings.reader.contextAfter', { n: settings.reader.contextParagraphsAfter })}</span>
                </div>
              )}
              {row(
                t('settings.reader.locationHeader'),
                checkbox(settings.reader.includeLocationHeader, (value) =>
                  void patch({ reader: { includeLocationHeader: value } })
                )
              )}
              {row(
                t('settings.reader.smoothScroll'),
                checkbox(settings.reader.smoothScroll, (value) => void patch({ reader: { smoothScroll: value } }))
              )}
            </>
          ) : null}

          {category === 'agent' ? (
            <>
              {row(
                t('settings.agent.workspaceMode'),
                select(
                  settings.agent.workspaceMode,
                  [
                    { value: 'document', label: t('settings.agent.workspaceDocument') },
                    { value: 'isolated', label: t('settings.agent.workspaceIsolated') }
                  ],
                  (value) => void patch({ agent: { workspaceMode: value as 'document' } })
                ),
                t('settings.agent.workspaceHint')
              )}
              {row(
                t('settings.agent.allowWrite'),
                checkbox(settings.agent.allowWrite, (value) => void patch({ agent: { allowWrite: value } }))
              )}
              {row(
                t('settings.agent.allowExecute'),
                checkbox(settings.agent.allowExecute, (value) => void patch({ agent: { allowExecute: value } }))
              )}
              {row(
                t('settings.agent.allowedDirs'),
                <div className="lr-setting__inline">
                  <button
                    className="lr-button lr-button--secondary"
                    onClick={async () => {
                      const dir = await api.dialog.openFolder()
                      if (!dir) return
                      await patch({ agent: { allowedWriteDirs: [...settings.agent.allowedWriteDirs, dir] } })
                    }}
                  >
                    {t('settings.agent.addDir')}
                  </button>
                  <span className="lr-setting__hint">{settings.agent.allowedWriteDirs.length}</span>
                </div>
              )}
              <p className="lr-setting__note">{t('settings.agent.keyStorage')}</p>
            </>
          ) : null}

          {category === 'graph' ? (
            <>
              {row(
                t('settings.graph.targetNodeLimit'),
                <input
                  type="number"
                  min={20}
                  max={2000}
                  value={settings.graph.targetNodeLimit}
                  onChange={(event) => void patch({ graph: { targetNodeLimit: Number(event.target.value) } })}
                />
              )}
              {row(
                t('settings.graph.chunkTokens'),
                <input
                  type="number"
                  min={500}
                  max={12000}
                  step={100}
                  value={settings.graph.chunkTokens}
                  onChange={(event) => void patch({ graph: { chunkTokens: Number(event.target.value) } })}
                />
              )}
              {row(
                t('settings.graph.concurrency'),
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={settings.graph.concurrency}
                  onChange={(event) => void patch({ graph: { concurrency: Number(event.target.value) } })}
                />
              )}
              {row(
                t('settings.graph.entityThreshold'),
                <input
                  type="number"
                  min={0.5}
                  max={1}
                  step={0.01}
                  value={settings.graph.entityResolutionThreshold}
                  onChange={(event) =>
                    void patch({ graph: { entityResolutionThreshold: Number(event.target.value) } })
                  }
                />
              )}
              {row(
                t('settings.graph.stageModels'),
                checkbox(settings.graph.stageModels, (value) => void patch({ graph: { stageModels: value } }))
              )}
              {row(
                t('settings.graph.aggregate'),
                checkbox(settings.graph.aggregate, (value) => void patch({ graph: { aggregate: value } }))
              )}
            </>
          ) : null}

          {category === 'storage' ? (
            <>
              {row(
                t('settings.storage.userData'),
                <div className="lr-setting__inline">
                  <code className="lr-setting__path">{appInfo?.userDataPath ?? '-'}</code>
                  <button
                    className="lr-button lr-button--secondary"
                    onClick={() => {
                      if (appInfo) void api.fs.openPath(appInfo.userDataPath)
                    }}
                  >
                    {t('settings.storage.openUserData')}
                  </button>
                </div>
              )}
              {row(
                t('settings.storage.dbBackend'),
                <div className="lr-setting__inline">
                  <span>SQLite / JSON</span>
                  <button
                    className="lr-button lr-button--secondary"
                    onClick={async () => {
                      const next = await api.store.stats()
                      setStats(next)
                    }}
                  >
                    {t('settings.storage.stats')}
                  </button>
                  {stats ? <code className="lr-setting__path">{JSON.stringify(stats)}</code> : null}
                </div>
              )}
              {row(
                t('settings.storage.clearSession'),
                <button
                  className="lr-button lr-button--secondary"
                  onClick={async () => {
                    const answer = await api.dialog.message({
                      type: 'question',
                      message: t('dialog.clearSession'),
                      buttons: [t('common.confirm'), t('common.cancel')],
                      cancelId: 1
                    })
                    if (answer !== 0) return
                    await api.session.clear()
                    notify(t('dialog.sessionCleared'), 'success')
                  }}
                >
                  {t('settings.storage.clearSession')}
                </button>
              )}
              {row(
                t('settings.storage.reopenLast'),
                <button className="lr-button lr-button--secondary" onClick={() => void executeCommand(CMD.sessionReopenLast)}>
                  {t('cmd.workbench.action.reopenLastSession')}
                </button>
              )}
            </>
          ) : null}

          {category === 'about' ? (
            <div className="lr-about">
              <h2>LogicReader</h2>
              <p>{t('app.tagline')}</p>
              <dl>
                <dt>{t('settings.about.version')}</dt>
                <dd>{appInfo?.version ?? '-'}</dd>
                <dt>{t('settings.about.electron')}</dt>
                <dd>{appInfo?.electron ?? '-'}</dd>
                <dt>{t('settings.about.chrome')}</dt>
                <dd>{appInfo?.chrome ?? '-'}</dd>
                <dt>{t('settings.about.node')}</dt>
                <dd>{appInfo?.node ?? '-'}</dd>
                <dt>{t('settings.about.platform')}</dt>
                <dd>
                  {appInfo?.platform ?? '-'} / {appInfo?.arch ?? '-'}
                </dd>
                <dt>{t('settings.about.license')}</dt>
                <dd>{t('settings.about.libreOfficeLicense')}</dd>
              </dl>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
