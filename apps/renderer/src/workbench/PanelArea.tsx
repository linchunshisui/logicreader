import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LogEntry } from '@logicreader/shared'
import { CH } from '@logicreader/shared'
import { useLayout } from '../state/layout.store'
import { api } from '../lib/api'

const TAB_LABEL: Record<string, string> = {
  output: 'panel.output',
  problems: 'panel.problems',
  log: 'panel.log',
  'graph-log': 'panel.graphLog',
  terminal: 'panel.terminal'
}

export function PanelArea(): JSX.Element {
  const { t } = useTranslation()
  const { panelActiveTab, panelTabs, setPanelActiveTab, togglePanel } = useLayout()
  const [entries, setEntries] = useState<LogEntry[]>([])

  useEffect(() => {
    void api.log
      .read(400)
      .then(setEntries)
      .catch(() => undefined)
    return api.log.onEntry((entry) => {
      setEntries((prev) => [...prev.slice(-600), entry])
    })
  }, [])

  const levelFilter = panelActiveTab === 'problems' ? ['error', 'warn'] : null
  const visible = levelFilter ? entries.filter((e) => levelFilter.includes(e.level)) : entries

  return (
    <section className="lr-panel">
      <div className="lr-panel__tabs">
        {panelTabs.map((tab) => (
          <button
            key={tab}
            className="lr-panel__tab"
            data-active={panelActiveTab === tab}
            onClick={() => setPanelActiveTab(tab)}
          >
            {t(TAB_LABEL[tab] ?? tab)}
          </button>
        ))}
        <div className="lr-panel__spacer" />
        <button className="lr-icon-button" title={t('panel.clear')} onClick={() => setEntries([])}>
          ⌫
        </button>
        <button className="lr-icon-button" title={t('panel.togglePanel')} onClick={() => togglePanel(false)}>
          ✕
        </button>
      </div>
      <div className="lr-panel__body lr-scroll">
        {visible.length === 0 ? (
          <div className="lr-empty">{panelActiveTab === 'problems' ? t('panel.noProblems') : t('panel.noOutput')}</div>
        ) : (
          visible
            .slice()
            .reverse()
            .map((entry) => (
              <div key={entry.id} className="lr-log-line" data-level={entry.level}>
                <span className="lr-log-line__time">{new Date(entry.at).toLocaleTimeString()}</span>
                <span className="lr-log-line__level">{entry.level}</span>
                <span>
                  [{entry.scope}] {entry.message}
                  {entry.detail ? ' :: ' + entry.detail : ''}
                </span>
              </div>
            ))
        )}
      </div>
    </section>
  )
}

export { CH }
