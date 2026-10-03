import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDocuments } from '../../state/documents.store'
import { useTabs } from '../../state/tabs.store'
import { useUiStore } from '../../state/ui.store'

export function SearchView(): JSX.Element {
  const { t } = useTranslation()
  const tabs = useTabs()
  const [query, setQuery] = useState('')
  const documents = useDocuments()
  const requestReveal = useUiStore((s) => s.requestReveal)
  const activeTab = tabs.activeTab()
  const model = activeTab && activeTab.kind === 'reader' ? documents.models[activeTab.docId] ?? null : null

  const results = useMemo(() => {
    if (!model || query.trim().length === 0) return []
    const needle = query.toLowerCase()
    const hay = model.text.toLowerCase()
    const out: { charStart: number; snippet: string }[] = []
    let index = hay.indexOf(needle)
    while (index >= 0 && out.length < 200) {
      out.push({
        charStart: index,
        snippet: model.text.slice(Math.max(0, index - 20), index + needle.length + 30).replace(/\n/g, ' ')
      })
      index = hay.indexOf(needle, index + Math.max(1, needle.length))
    }
    return out
  }, [model, query])

  return (
    <div className="lr-view">
      <div className="lr-search-box">
        <input
          value={query}
          placeholder={t('sideBar.searchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="lr-scroll" style={{ flex: 1 }}>
        {query.length === 0 ? null : results.length === 0 ? (
          <div className="lr-empty">{t('sideBar.searchEmpty')}</div>
        ) : (
          <>
            <div className="lr-search-count">{t('sideBar.searchResults', { count: results.length })}</div>
            {results.map((result, index) => (
              <button
                key={index}
                className="lr-search-result"
                onClick={() => {
                  if (!model) return
                  requestReveal({ docId: model.docId, charStart: result.charStart, charEnd: result.charStart + query.length })
                }}
              >
                {result.snippet}
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
