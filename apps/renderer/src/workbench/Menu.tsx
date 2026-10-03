import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface MenuItem {
  id: string
  label: string
  shortcut?: string
  disabled?: boolean
  run?: () => void
  separator?: boolean
  /** 分组标题（不可点击） */
  header?: boolean
}

interface MenuProps {
  label: string
  items: MenuItem[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function Menu({ label, items, open, onOpenChange }: MenuProps): JSX.Element {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })

  useEffect(() => {
    if (!open || !anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    setPosition({ left: rect.left, top: rect.bottom + 2 })
    const onDown = (event: MouseEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return
      if (anchorRef.current?.contains(event.target as Node)) return
      onOpenChange(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onOpenChange])

  return (
    <>
      <button
        ref={anchorRef}
        className="lr-titlebar__menu-button"
        data-open={open}
        onClick={() => onOpenChange(!open)}
        onMouseEnter={() => {
          // 已有菜单打开时，悬停切换，符合 VS Code 习惯
          if (!open && document.querySelector('.lr-menu')) onOpenChange(true)
        }}
      >
        {label}
      </button>
      {open && (
        <div ref={menuRef} className="lr-menu" style={{ left: position.left, top: position.top }}>
          {items.map((item, index) =>
            item.separator ? (
              <div key={'sep-' + index} className="lr-menu__separator" />
            ) : item.header ? (
              <div key={'hdr-' + index} className="lr-menu__label">
                {item.label}
              </div>
            ) : (
              <button
                key={item.id}
                className="lr-menu__item"
                disabled={item.disabled}
                onClick={() => {
                  onOpenChange(false)
                  item.run?.()
                }}
              >
                <span>{item.label}</span>
                {item.shortcut ? <span className="lr-menu__shortcut">{item.shortcut}</span> : null}
              </button>
            )
          )}
        </div>
      )}
    </>
  )
}

export function MenuBar({ children }: { children: ReactNode }): JSX.Element {
  return <div className="lr-titlebar__menus">{children}</div>
}
