import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CMD, basename, type AppInfo, type RecentEntry } from '@logicreader/shared'
import { api } from '../../lib/api'
import { executeCommand } from '../../state/commands.store'
import { openFileInWorkbench } from '../../commands'

export function WelcomeView(): JSX.Element {
  const { t } = useTranslation()
  const [recent, setRecent] = useState<RecentEntry[]>([])
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void api.fs.recent().then(setRecent).catch(() => undefined)
    void api.app.info().then(setInfo).catch(() => undefined)
  }, [])

  return (
    <div className="lr-welcome lr-scroll">
      <div className="lr-welcome__inner">
        <h1 className="lr-welcome__title">{t('welcome.title')}</h1>
        <p className="lr-welcome__subtitle">{t('welcome.subtitle')}</p>

        <div className="lr-welcome__columns">
          <section className="lr-welcome__column">
            <h2>{t('welcome.start')}</h2>
            <button className="lr-welcome__link" onClick={() => executeCommand(CMD.fileOpen)}>
              {t('welcome.openFile')}
            </button>
            <button className="lr-welcome__link" onClick={() => executeCommand(CMD.fileOpenFolder)}>
              {t('welcome.openFolder')}
            </button>
            <button className="lr-welcome__link" onClick={() => executeCommand(CMD.agentNewSession)}>
              {t('agent.newSession')}
            </button>
            <button className="lr-welcome__link" onClick={() => executeCommand(CMD.commandPalette)}>
              {t('menu.viewCommandPalette')}
            </button>
          </section>

          <section className="lr-welcome__column">
            <h2>{t('welcome.recent')}</h2>
            {recent.length === 0 ? (
              <p className="lr-empty">{t('welcome.noRecent')}</p>
            ) : (
              recent.slice(0, 8).map((entry) => (
                <button
                  key={entry.path}
                  className="lr-welcome__link"
                  title={entry.path}
                  onClick={() => void openFileInWorkbench(entry.path)}
                >
                  {entry.title || basename(entry.path)}
                  <span className="lr-welcome__path">{entry.path}</span>
                </button>
              ))
            )}
          </section>

          <section className="lr-welcome__column">
            <h2>{t('welcome.help')}</h2>
            <button className="lr-welcome__link" onClick={() => executeCommand(CMD.helpShortcuts)}>
              {t('welcome.shortcuts')}
            </button>
            <button className="lr-welcome__link" onClick={() => executeCommand(CMD.settingsOpen)}>
              {t('welcome.settings')}
            </button>
            <button className="lr-welcome__link" onClick={() => executeCommand(CMD.helpAbout)}>
              {t('menu.helpAbout')}
            </button>
          </section>
        </div>

        <footer className="lr-welcome__footer">
          {info ? (
            <span>
              {t('welcome.version', { version: info.version })} · Electron {info.electron} · Chromium {info.chrome} · Node {info.node}
            </span>
          ) : null}
          <span>{t('welcome.tip')}</span>
        </footer>
      </div>
    </div>
  )
}
