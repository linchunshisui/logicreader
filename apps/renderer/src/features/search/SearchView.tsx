import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SearchHit } from '@logicreader/shared'
import { api } from '../../lib/api'
import { useDocuments } from '../../state/documents.store'
import { useTabs } from '../../state/tabs.store'
import { useUiStore } from '../../state/ui.store'
import { openFileInWorkbench } from '../../commands'

type Scope = 'doc' | 'library'

/** 库级检索的防抖：每敲一个字都往库里查一遍，在长文档库上会白烧 IO */
const LIBRARY_DEBOUNCE_MS = 150
const LIBRARY_LIMIT = 100

/** 命中片段：以命中处为中心截一段；命中位置未知（matchStart < 0）时就截开头 */
function hitSnippet(hit: SearchHit, query: string): string {
  const start = hit.matchStart >= 0 ? Math.max(0, hit.matchStart - 20) : 0
  const end = hit.matchStart >= 0 ? hit.matchStart + query.length + 30 : 50
  return hit.text.slice(start, end).replace(/\n/g, ' ')
}

export function SearchView(): JSX.Element {
  const { t } = useTranslation()
  const tabs = useTabs()
  const documents = useDocuments()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('doc')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [openError, setOpenError] = useState<string | null>(null)
  const requestReveal = useUiStore((s) => s.requestReveal)
  const activeTab = tabs.activeTab()
  const model = activeTab && activeTab.kind === 'reader' ? documents.models[activeTab.docId] ?? null : null

  /**
   * 本文档范围：仍是内存里的子串扫描。
   * 这一条**刻意不改成走库**：它的语义是"当前打开的这篇"，而且对任意长度（含单个字）都即时，
   * 不必为短词再去走一遍兜底路径。
   */
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

  /* 库级范围：走 FTS5 索引（跨文档，内存里扫不动），输入防抖后查询 */
  useEffect(() => {
    if (scope !== 'library' || query.trim().length === 0) {
      setHits([])
      setOpenError(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      api.store.searchBlocks(query, LIBRARY_LIMIT).then(
        (found) => {
          if (!cancelled) setHits(found)
        },
        () => {
          if (!cancelled) setHits([])
        }
      )
    }, LIBRARY_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [scope, query])

  /**
   * 打开命中所在的文档并跳过去。
   *
   * 两件事都不能省：
   * ① 文档**可能根本没打开过**（库级检索本来就会命中没打开的文档），
   *    所以先复用 `openFileInWorkbench`（它负责去重、建标签、激活、记最近打开）；
   * ② 跳转用一个**已存在的**通道 `requestReveal`：它会在 6 秒窗口内重试到内容就绪，
   *    所以"刚打开、阅读器还在异步加载"这件事不需要在这里自己等 —— 别在这里加 sleep。
   */
  const openHit = useCallback(
    async (hit: SearchHit) => {
      setOpenError(null)
      const alreadyOpen = Boolean(documents.models[hit.docId])
      if (!alreadyOpen) {
        const tabId = await openFileInWorkbench(hit.docPath)
        if (!tabId) {
          setOpenError(t('sideBar.searchOpenFailed', { message: hit.docTitle || hit.docPath }))
          return
        }
      }
      requestReveal({ docId: hit.docId, charStart: hit.charStart, charEnd: hit.charEnd })
    },
    [documents.models, requestReveal, t]
  )

  const trimmed = query.trim().length > 0

  return (
    <div className="lr-view">
      <div className="lr-search-box">
        <input
          value={query}
          placeholder={scope === 'library' ? t('sideBar.searchLibraryPlaceholder') : t('sideBar.searchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="lr-search-scope">
        <button
          className="lr-search-scope__item"
          data-active={scope === 'doc'}
          onClick={() => setScope('doc')}
        >
          {t('sideBar.searchScopeDoc')}
        </button>
        <button
          className="lr-search-scope__item"
          data-active={scope === 'library'}
          onClick={() => setScope('library')}
        >
          {t('sideBar.searchScopeLibrary')}
        </button>
      </div>
      <div className="lr-scroll" style={{ flex: 1 }}>
        {scope === 'library'
          ? !trimmed
            ? null
            : hits.length === 0
              ? <div className="lr-empty">{t('sideBar.searchEmpty')}</div>
              : (
                <>
                  <div className="lr-search-count">{t('sideBar.searchResults', { count: hits.length })}</div>
                  <div className="lr-search-hint">{t('sideBar.searchLibraryHint')}</div>
                  {openError ? <div className="lr-search-error">{openError}</div> : null}
                  {hits.map((hit) => (
                    <div key={hit.blockId}>
                      <div className="lr-search-doc" title={hit.docPath}>{hit.docTitle || hit.docPath}</div>
                      <button className="lr-search-result" onClick={() => void openHit(hit)}>
                        {hitSnippet(hit, query)}
                      </button>
                    </div>
                  ))}
                </>
              )
          : query.length === 0
            ? null
            : results.length === 0
              ? <div className="lr-empty">{t('sideBar.searchEmpty')}</div>
              : (
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
