/**
 * 论文标签与关系图标签的**绑定**规则（用户要求）：
 *
 *   · 关闭论文 → 连它的关系图一起关；
 *   · 关闭关系图 → **不动**论文；
 *   · 关别的论文的图/论文，不受影响；
 *   · "重新打开已关闭的编辑器"先还回用户点名关掉的那个（论文），再还关系图。
 *
 * 这些规则全在 `tabs.store.closeTab` 里，与界面无关，所以直接用 store 断言，
 * 不依赖 GUI 冒烟。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { GraphTab, GraphViewState, ReaderTab, ReaderViewState } from '@logicreader/shared'
import { useTabs } from '../apps/renderer/src/state/tabs.store'

const readerView = (): ReaderViewState => ({
  page: 1,
  anchorId: null,
  scrollTopRatio: 0,
  scrollTop: 0,
  zoom: 'fit-width',
  viewMode: 'continuous',
  rotation: 0,
  themeOverride: 'inherit',
  pdfDarkMode: 'off',
  pdfImagePolicy: 'keep',
  sidebarView: 'outline',
  expandedOutlineIds: [],
  activeAnnotationId: null
})

const graphView = (): GraphViewState => ({
  viewport: { x: 0, y: 0, zoom: 1 },
  layoutMode: 'layered',
  selectedNodeIds: [],
  collapsedClusterIds: [],
  filters: { edgeKinds: [], nodeKinds: [] },
  searchTerm: ''
})

const readerTab = (docId: string, id: string): ReaderTab => ({
  kind: 'reader',
  id,
  docId,
  filePath: 'D:\\papers\\' + docId + '.pdf',
  title: docId,
  view: readerView()
})

const graphTab = (docId: string, id: string): GraphTab => ({
  kind: 'graph',
  id,
  docId,
  graphId: null,
  title: docId + ' · 逻辑关系图',
  view: graphView()
})

const tabIds = (): string[] =>
  useTabs
    .getState()
    .groups.flatMap((group) => group.tabs.map((tab) => tab.id))
    .sort()

describe('论文与关系图标签的绑定', () => {
  beforeEach(() => {
    useTabs.setState({
      groups: [{ id: 'g1', tabs: [], activeIndex: 0 }],
      activeGroupId: 'g1',
      closed: []
    })
  })

  it('关闭论文时连它的关系图一起关', () => {
    const tabs = useTabs.getState()
    tabs.openTab(readerTab('docA', 'tab-a'))
    tabs.openTab(graphTab('docA', 'tab-graph-a'))
    expect(tabIds()).toEqual(['tab-a', 'tab-graph-a'])

    useTabs.getState().closeTab('tab-a')
    expect(tabIds()).toEqual([])
    // 两个都进了"重新打开"历史，且用户点名关掉的论文排在前面
    expect(useTabs.getState().closed.map((tab) => tab.id)).toEqual(['tab-a', 'tab-graph-a'])
  })

  it('关闭关系图不会关掉论文', () => {
    const tabs = useTabs.getState()
    tabs.openTab(readerTab('docA', 'tab-a'))
    tabs.openTab(graphTab('docA', 'tab-graph-a'))

    useTabs.getState().closeTab('tab-graph-a')
    expect(tabIds()).toEqual(['tab-a'])
    expect(useTabs.getState().closed.map((tab) => tab.id)).toEqual(['tab-graph-a'])
  })

  it('只影响同一篇论文：别篇的图照旧开着', () => {
    const tabs = useTabs.getState()
    tabs.openTab(readerTab('docA', 'tab-a'))
    tabs.openTab(graphTab('docA', 'tab-graph-a'))
    tabs.openTab(readerTab('docB', 'tab-b'))
    tabs.openTab(graphTab('docB', 'tab-graph-b'))

    useTabs.getState().closeTab('tab-a')
    expect(tabIds()).toEqual(['tab-b', 'tab-graph-b'])
  })

  it('分屏时也能连带关闭（图在另一个编辑组）', () => {
    const tabs = useTabs.getState()
    tabs.openTab(readerTab('docA', 'tab-a'))
    tabs.openTab(graphTab('docA', 'tab-graph-a'))
    // 把关系图拆到另一个组
    useTabs.getState().splitGroup('tab-graph-a')
    expect(useTabs.getState().groups.length).toBe(2)

    useTabs.getState().closeTab('tab-a')
    expect(tabIds()).toEqual([])
    expect(useTabs.getState().groups.every((group) => group.tabs.length === 0 || group.id === 'g1')).toBe(true)
  })

  it('关闭的是当前激活标签时，激活位置落到同一组的其它标签上', () => {
    const tabs = useTabs.getState()
    tabs.openTab(graphTab('docB', 'tab-graph-b'))
    tabs.openTab(readerTab('docA', 'tab-a'))
    tabs.openTab(graphTab('docA', 'tab-graph-a'))
    expect(useTabs.getState().activeTab()?.id).toBe('tab-graph-a')

    useTabs.getState().closeTab('tab-a')
    // docA 的图跟着关掉，剩下的激活标签必须是仍然存在的那个
    expect(tabIds()).toEqual(['tab-graph-b'])
    expect(useTabs.getState().activeTab()?.id).toBe('tab-graph-b')
  })
})
