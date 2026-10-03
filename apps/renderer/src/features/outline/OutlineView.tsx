import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { flattenOutline, type OutlineNode } from '@logicreader/document-model'
import { useDocuments } from '../../state/documents.store'
import { useTabs } from '../../state/tabs.store'
import { useUiStore } from '../../state/ui.store'

export function OutlineView(): JSX.Element {
  const { t } = useTranslation()
  const tabs = useTabs()
  const documents = useDocuments()
  const requestReveal = useUiStore((s) => s.requestReveal)
  const activeTab = tabs.activeTab()

  const model = activeTab && activeTab.kind === 'reader' ? documents.models[activeTab.docId] ?? null : null

  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const flat = useMemo(() => (model ? flattenOutline(model.outline) : []), [model])

  if (!activeTab || activeTab.kind !== 'reader') {
    return <div className="lr-empty">{t('status.noDocument')}</div>
  }
  if (!model) {
    return <div className="lr-empty">{t('sideBar.outlineLoading')}</div>
  }
  if (flat.length === 0) {
    return <div className="lr-empty">{t('sideBar.outlineEmpty')}</div>
  }

  const isExpanded = (node: OutlineNode): boolean => expanded[node.id] !== false

  return (
    <div className="lr-view lr-scroll">
      <div className="lr-tree">
        {flat.map((node) => {
          const hasChildren = node.children.length > 0
          const visible = parentVisible(node, model.outline, isExpanded)
          if (!visible) return null
          return (
            <div
              key={node.id}
              className="lr-tree__row"
              style={{ paddingLeft: 4 + (node.level - 1) * 12 }}
              title={node.title}
              onClick={() => {
                requestReveal({ docId: model.docId, charStart: node.charStart, charEnd: node.charStart + 200 })
                if (hasChildren) setExpanded((prev) => ({ ...prev, [node.id]: !isExpanded(node) }))
              }}
            >
              <span className="lr-tree__chevron">{hasChildren ? (isExpanded(node) ? '▾' : '▸') : ''}</span>
              <span className="lr-tree__label">{node.title}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function parentVisible(node: OutlineNode, roots: OutlineNode[], isExpanded: (n: OutlineNode) => boolean): boolean {
  const path = findPath(roots, node)
  if (!path) return true
  return path.slice(0, -1).every((parent) => isExpanded(parent))
}

function findPath(roots: OutlineNode[], target: OutlineNode, trail: OutlineNode[] = []): OutlineNode[] | null {
  for (const node of roots) {
    const nextTrail = [...trail, node]
    if (node.id === target.id) return nextTrail
    const deeper = findPath(node.children, target, nextTrail)
    if (deeper) return deeper
  }
  return null
}
