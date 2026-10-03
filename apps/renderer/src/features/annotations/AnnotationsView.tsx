import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AnnotationRecord } from '@logicreader/shared'
import { api } from '../../lib/api'
import { useTabs } from '../../state/tabs.store'
import { useUiStore } from '../../state/ui.store'

export function AnnotationsView(): JSX.Element {
  const { t } = useTranslation()
  const tabs = useTabs()
  const [items, setItems] = useState<AnnotationRecord[]>([])
  const [filter, setFilter] = useState<'all' | string>('all')
  const requestReveal = useUiStore((s) => s.requestReveal)
  const activeTab = tabs.activeTab()

  useEffect(() => {
    if (!activeTab || activeTab.kind !== 'reader') {
      setItems([])
      return
    }
    void api.store.listAnnotations(activeTab.docId).then(setItems).catch(() => setItems([]))
  }, [activeTab, tabs.groups])

  if (!activeTab || activeTab.kind !== 'reader') {
    return <div className="lr-empty">{t('status.noDocument')}</div>
  }

  const kinds = Array.from(new Set(items.map((item) => item.kind)))
  const visible = filter === 'all' ? items : items.filter((item) => item.kind === filter)

  return (
    <div className="lr-view">
      <div className="lr-filter-row">
        <button className="lr-chip" data-active={filter === 'all'} onClick={() => setFilter('all')}>
          {t('sideBar.annotationsFilterAll')}
        </button>
        {kinds.map((kind) => (
          <button key={kind} className="lr-chip" data-active={filter === kind} onClick={() => setFilter(kind)}>
            {t('reader.annotate' + kind.charAt(0).toUpperCase() + kind.slice(1), kind)}
          </button>
        ))}
      </div>
      <div className="lr-scroll" style={{ flex: 1 }}>
        {visible.length === 0 ? (
          <div className="lr-empty">{t('sideBar.annotationsEmpty')}</div>
        ) : (
          visible.map((item) => (
            <button
              key={item.id}
              className="lr-annotation-row"
              onClick={async () => {
                const anchor = await api.store.getAnchor(item.anchorId)
                if (anchor) requestReveal({ docId: item.docId, charStart: anchor.charStart, charEnd: anchor.charEnd })
              }}
            >
              <span className="lr-annotation-row__color" style={{ background: item.color }} />
              <span className="lr-annotation-row__body">
                <span className="lr-annotation-row__kind">{item.kind}</span>
                <span className="lr-annotation-row__note">{item.note ?? ''}</span>
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
