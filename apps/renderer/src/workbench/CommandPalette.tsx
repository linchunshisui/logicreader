import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCommands, type CommandDescriptor } from '../state/commands.store'
import { useUiStore } from '../state/ui.store'

export function CommandPalette(): JSX.Element | null {
  const { t } = useTranslation()
  const open = useUiStore((s) => s.commandPaletteOpen)
  const close = useUiStore((s) => s.closeCommandPalette)
  const { commands, recent, execute } = useCommands()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const items = useMemo(() => {
    const all = Object.values(commands).filter((command) => (command.enabled ? command.enabled() : true))
    const scored = all
      .map((command) => ({ command, score: score(command, query, t(command.titleKey), recent) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 60)
    return scored.map((item) => item.command)
  }, [commands, query, recent, t])

  useEffect(() => {
    if (index >= items.length) setIndex(0)
  }, [items.length, index])

  if (!open) return null

  const run = (command: CommandDescriptor): void => {
    close()
    void execute(command.id)
  }

  return (
    <div className="lr-overlay" onMouseDown={close}>
      <div className="lr-quickinput" onMouseDown={(event) => event.stopPropagation()}>
        <div className="lr-quickinput__input">
          <span>›</span>
          <input
            ref={inputRef}
            value={query}
            placeholder={t('command.placeholder')}
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
                if (item) run(item)
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
            items.map((command, i) => (
              <button
                key={command.id}
                className="lr-quickinput__item"
                data-active={i === index}
                onMouseEnter={() => setIndex(i)}
                onClick={() => run(command)}
              >
                <span className="lr-quickinput__item-title">{t(command.titleKey)}</span>
                <span className="lr-quickinput__item-meta">{t(command.categoryKey)}</span>
                {command.keybinding ? <span className="lr-quickinput__item-meta">{command.keybinding}</span> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function score(command: CommandDescriptor, query: string, title: string, recent: string[]): number {
  const q = query.trim().toLowerCase()
  const freq = recent.includes(command.id) ? 20 - recent.indexOf(command.id) : 0
  if (!q) return 1 + freq
  const hay = (title + ' ' + command.id + ' ' + (command.keywords ?? []).join(' ')).toLowerCase()
  if (hay.includes(q)) return 100 - hay.indexOf(q) + freq
  // 简单的子序列匹配
  let i = 0
  for (const ch of hay) {
    if (ch === q[i]) i += 1
    if (i === q.length) return 20 + freq
  }
  return 0
}
