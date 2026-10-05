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
  /** 按钮内容：标题栏用文字，工具栏的「更多」用图标 */
  label: ReactNode
  /** 按钮的无障碍名与 tooltip（图标按钮必须给，否则只有一个形状） */
  labelText?: string
  items: MenuItem[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 覆盖按钮样式（标题栏菜单与工具栏溢出菜单的观感不同） */
  buttonClassName?: string
  /** 另一个菜单已打开时，悬停本项就切换过去 —— 只有标题栏需要这种习惯 */
  hoverSwitch?: boolean
}

export function Menu({ label, labelText, items, open, onOpenChange, buttonClassName, hoverSwitch = true }: MenuProps): JSX.Element {
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
        className={buttonClassName ?? 'lr-titlebar__menu-button'}
        data-open={open}
        title={labelText}
        aria-label={labelText}
        onClick={() => onOpenChange(!open)}
        onMouseEnter={() => {
          // 已有菜单打开时，悬停切换，符合 VS Code 习惯
          if (hoverSwitch && !open && document.querySelector('.lr-menu')) onOpenChange(true)
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
                /*
                 * 别让菜单项抢走焦点：原生菜单不抢焦点，而 Electron 的撤销/粘贴
                 * 作用在"当前聚焦的元素"上 —— 焦点一落到菜单按钮，编辑菜单就全成了空操作。
                 */
                onMouseDown={(event) => event.preventDefault()}
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
