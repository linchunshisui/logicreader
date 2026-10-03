import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CMD, basename, type EditorTab } from '@logicreader/shared'
import { useTabs, type EditorGroupState } from '../state/tabs.store'
import { useLayout } from '../state/layout.store'
import { executeCommand } from '../state/commands.store'
import { EditorTabView } from '../views/registry'
import { IconClose } from './icons'

interface ContextMenuState {
  tabId: string
  x: number
  y: number
}

export function EditorArea(): JSX.Element {
  const { groups, activeGroupId } = useTabs()
  return (
    <div className="lr-editor-area">
      {groups.map((group) => (
        <EditorGroup key={group.id} group={group} active={group.id === activeGroupId} />
      ))}
    </div>
  )
}

function EditorGroup({ group, active }: { group: EditorGroupState; active: boolean }): JSX.Element {
  const tabs = useTabs()
  const { setActiveGroup } = useLayout()
  const dragIndex = useRef<number | null>(null)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const { t } = useTranslation()

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const current = group.tabs[group.activeIndex] ?? null

  return (
    <div
      className="lr-editor-group"
      data-active={active}
      onMouseDown={() => {
        if (!active) setActiveGroup(group.id)
      }}
    >
      <div className="lr-tabs" role="tablist">
        {group.tabs.map((tab, index) => {
          const isActive = index === group.activeIndex
          const label =
            tab.kind === 'welcome'
              ? t('tab.welcome')
              : tab.kind === 'settings'
                ? t('tab.settings')
                : tab.kind === 'graph'
                  ? // 图与论文绑定：标题是"文档名 · 逻辑关系图"（见 lib/graphName），
                    // 不再统一显示成"关系图"，否则同时开着几篇论文的图就分不清谁是谁
                    tab.title || t('tab.graph')
                  : tab.title || basename(tab.filePath)
          return (
            <div
              key={tab.id}
              className="lr-tab"
              data-active={isActive}
              role="tab"
              aria-selected={isActive}
              draggable
              onDragStart={() => {
                dragIndex.current = index
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (dragIndex.current === null || dragIndex.current === index) return
                tabs.reorder(group.id, dragIndex.current, index)
                dragIndex.current = null
              }}
              onMouseDown={(event) => {
                if (event.button === 1) {
                  tabs.closeTab(tab.id)
                  return
                }
                if (event.button === 0) tabs.activate(tab.id)
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                tabs.activate(tab.id)
                setMenu({ tabId: tab.id, x: event.clientX, y: event.clientY })
              }}
              title={tab.kind === 'reader' ? tab.filePath : label}
            >
              <span className="lr-tab__label">{label}</span>
              <button
                className="lr-tab__close"
                title={t('tab.closeTab')}
                onClick={(event) => {
                  event.stopPropagation()
                  tabs.closeTab(tab.id)
                }}
              >
                <IconClose size={12} />
              </button>
            </div>
          )
        })}
      </div>
      <div className="lr-editor-group__content">{current ? <EditorTabView tab={current} /> : <EmptyEditor />}</div>
      {menu ? (
        <div className="lr-menu" style={{ position: 'fixed', left: menu.x, top: menu.y, minWidth: 200 }}>
          <button className="lr-menu__item" onClick={() => tabs.closeTab(menu.tabId)}>
            {t('tab.closeTab')} <span className="lr-menu__shortcut">Ctrl+W</span>
          </button>
          <button className="lr-menu__item" onClick={() => tabs.closeOthers(menu.tabId)}>
            {t('tab.closeOthers')}
          </button>
          <button className="lr-menu__item" onClick={() => tabs.closeAll()}>
            {t('tab.closeAll')}
          </button>
          <div className="lr-menu__separator" />
          <button className="lr-menu__item" onClick={() => tabs.splitGroup(menu.tabId)}>
            {t('tab.splitRight')} <span className="lr-menu__shortcut">Ctrl+\\</span>
          </button>
          <button className="lr-menu__item" onClick={() => executeCommand(CMD.fileRevealInExplorer)}>
            {t('cmd.revealFileInOS')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function EmptyEditor(): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="lr-empty-editor">
      <p>{t('editor.noEditor')}</p>
      <div className="lr-empty-editor__actions">
        <button className="lr-button lr-button--secondary" onClick={() => executeCommand(CMD.fileOpen)}>
          {t('welcome.openFile')}
        </button>
        <button className="lr-button lr-button--secondary" onClick={() => executeCommand(CMD.fileReopenClosed)}>
          {t('editor.reopen')}
        </button>
      </div>
    </div>
  )
}

export type { EditorTab }
