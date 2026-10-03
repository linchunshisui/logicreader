import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { basename, type RecentEntry } from '@logicreader/shared'
import { api } from '../lib/api'
import { useUiStore } from '../state/ui.store'
import { useTabs } from '../state/tabs.store'
import { openFileInWorkbench } from '../commands'

interface Item {
  path: string
  title: string
  meta: string
}

export function QuickOpen(): JSX.Element | null {
  const { t } = useTranslation()
  const open = useUiStore((s) => s.quickOpenOpen)
  const close = useUiStore((s) => s.closeQuickOpen)
  const tabs = useTabs()
  const [query, setQuery] = useState('')
  const [recent, setRecent] = useState<RecentEntry[]>([])
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    void api.fs.recent().then(setRecent).catch(() => setRecent([]))
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  const items = useMemo<Item[]>(() => {
    const openFiles: Item[] = tabs.groups
      .flatMap((g) => g.tabs)
      .filter((tab) => tab.kind === 'reader')
      .map((tab) => ({
        path: (tab as { filePath: string }).filePath,
        title: (tab as { title?: string }).title || basename((tab as { filePath: string }).filePath),
        meta: t('sideBar.openEditors')
      }))
    const recentItems: Item[] = recent.map((entry) => ({
      path: entry.path,
      title: entry.title || basename(entry.path),
      meta: t('command.recent')
    }))
    const seen = new Set<string>()
    const all = [...openFiles, ...recentItems].filter((item) => {
      if (seen.has(item.path)) return false
      seen.add(item.path)
      return true
    })
    const q = query.trim().toLowerCase()
    if (!q) return all.slice(0, 60)
    return all
      .map((item) => ({ item, score: fuzzy(item.path.toLowerCase() + ' ' + item.title.toLowerCase(), q) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item)
      .slice(0, 60)
  }, [query, recent, tabs.groups, t])

  if (!open) return null

  return (
    <div className="lr-overlay" onMouseDown={close}>
      <div className="lr-quickinput" onMouseDown={(event) => event.stopPropagation()}>
        <div className="lr-quickinput__input">
          <span>⌕</span>
          <input
            ref={inputRef}
            value={query}
            placeholder={t('command.quickOpenPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setIndex((i) => Math.min(i + 1, items.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setIndex((i) => Math.max(i - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                const item = items[index]
                if (item) {
                  close()
                  void openFileInWorkbench(item.path)
                }
              } else if (event.key === 'Escape') {
                close()
              }
            }}
          />
        </div>
        <div className="lr-quickinput__list">
          {items.length === 0 ? (
            <div className="lr-quickinput__empty">{t('command.noMatch')}</div>
          ) : (
            items.map((item, i) => (
              <button
                key={item.path}
                className="lr-quickinput__item"
                data-active={i === index}
                onMouseEnter={() => setIndex(i)}
                onClick={() => {
                  close()
                  void openFileInWorkbench(item.path)
                }}
              >
                <span className="lr-quickinput__item-title">{item.title}</span>
                <span className="lr-quickinput__item-meta">{item.path}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function fuzzy(haystack: string, needle: string): number {
  if (haystack.includes(needle)) return 100 - haystack.indexOf(needle)
  let i = 0
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1
    if (i === needle.length) return 10
  }
  return 0
}
