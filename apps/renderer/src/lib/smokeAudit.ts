/**
 * 本轮 UI 修复的**可断言证据**（冒烟命令 `smoke.assert*`）。
 *
 * 为什么不写在 App.tsx 的冒烟分支里：那些分支是"点一下、走一遍真实交互"的脚本；
 * 这里是纯断言集合 —— 输入是当前 DOM 与 store，输出是一条 `*_OK / *_FAIL` 日志。
 * 两者混在一个文件里，下次想找"这条闸门在测什么"就得在三千行里翻。
 *
 * 判据原则（避坑指南 §7.0/§7.7）：不看截图，只读 computed style、几何与 store 值；
 * 前提不成立（比如当前没打开 PDF）就写 *_SKIP 并说明原因，绝不把"没测到"报成通过。
 */
import { useUiStore } from '../state/ui.store'

type Level = 'info' | 'warn' | 'error'

interface CheckResult {
  ok: boolean
  detail: Record<string, unknown>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function log(level: Level, name: string, suffix: '_OK' | '_FAIL' | '_SKIP', detail: unknown): Promise<void> {
  await window.logicreader.log.write(level, 'smoke', name + suffix + ' ' + JSON.stringify(detail))
}

/** 逐个审计命令的实现；返回 false 表示"前提不成立，已写 SKIP"。 */
/** 断言表：可选的 `arg` 来自 `commandId:arg` 形式（只有需要读某条会话的断言用得上）。 */
const AUDITS: Record<string, (arg?: string) => Promise<CheckResult | null>> = {
  /**
   * P0-1 资源管理器树行的文字是居中的。
   *
   * 根因是 `.lr-tree__row` 是 `<button>`，UA 样式带 `text-align: center`，
   * 而里面的标签是 `flex: 1` 的普通容器 —— 它会继承居中。
   * 判据：行与标签的 computed `text-align` 都必须是 left。
   */
  'smoke.assertTree': async () => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.lr-tree__row'))
    if (rows.length === 0) return null
    const sample = rows.slice(0, 6).map((row) => {
      const label = row.querySelector<HTMLElement>('.lr-tree__label')
      return {
        row: getComputedStyle(row).textAlign,
        label: label ? getComputedStyle(label).textAlign : 'missing',
        labelOffset: label ? Math.round(label.getBoundingClientRect().left - row.getBoundingClientRect().left) : -1
      }
    })
    const ok = rows.every((row) => {
      const label = row.querySelector<HTMLElement>('.lr-tree__label')
      return getComputedStyle(row).textAlign === 'left' && (!label || getComputedStyle(label).textAlign === 'left')
    })
    return { ok, detail: { rows: rows.length, sample } }
  },

  /**
   * P0-8/P0-9 状态栏：构建时间要有标签，Agent 项要说出"谁 + 什么状态"。
   * 判据：构建项文本里带标签词，Agent 项文本里带分隔符与状态词。
   */
  'smoke.assertStatusBar': async () => {
    const agent = document.querySelector<HTMLElement>('.lr-statusbar__item[data-streaming]')
    const build = document.querySelector<HTMLElement>('.lr-statusbar__build')
    if (!agent || !build) return null
    const agentText = (agent.textContent ?? '').trim()
    const buildText = (build.textContent ?? '').trim()
    const agentOk = agentText.includes('·') && agentText.length > 3
    const buildOk = /构建|Build/.test(buildText)
    /*
     * 顺带把"整个界面跟着主题走"钉住：**活动栏 / 状态栏**是最容易漏的两块 ——
     * 浅色主题下它们以前还是深色（活动栏 #2c2c2c、状态栏纯黑 #000000），
     * 用户的原话分别是"浅色的左边这一栏未调整为浅色""最底下的一栏在浅色模式下仍是黑色"。
     * 判据用亮度方向（浅色主题要 >0.5、深色 <0.25），比对着配色变量看可靠；没渲染出来的层不算数。
     */
    const theme = document.documentElement.getAttribute('data-theme')
    const themeWantsDark = theme === 'dark'
    const rails: Record<string, { color: string | null; luminance: number | null; ok: boolean }> = {}
    for (const [name, selector] of [
      ['activityBar', '.lr-activitybar'],
      ['statusBar', '.lr-statusbar'],
      ['titleBar', '.lr-titlebar'],
      ['sideBar', '.lr-sidebar'],
      ['auxBar', '.lr-auxbar']
    ] as const) {
      const color = backgroundColorOf(selector)
      const luminance = relativeLuminance(color)
      rails[name] = {
        color,
        luminance: luminance === null ? null : Number(luminance.toFixed(3)),
        // 取不到（没渲染 / 背景透明）→ 这一层不适用，不算失败；取到了就必须与主题同向
        ok: luminance === null ? true : themeWantsDark ? luminance < 0.25 : luminance > 0.5
      }
    }
    const chromeOk = Object.values(rails).every((rail) => rail.ok)
    return {
      ok: agentOk && buildOk && chromeOk,
      detail: {
        agentText,
        buildText,
        agentOk,
        buildOk,
        streaming: agent.dataset.streaming,
        theme,
        chromeOk,
        rails
      }
    }
  },

  /**
   * P0-5 底部 chip 被截成残句。
   *
   * 判据分两层（机制 + 现象）：① 行容器允许换行、chip 不收缩（这样它就不可能被压扁）；
   * ② 每个 chip 的 scrollWidth 不大于 clientWidth（没有被省略号截断）。
   */
  'smoke.assertAgentChips': async () => {
    const row = document.querySelector<HTMLElement>('.lr-agent__composer-row')
    if (!row) return null
    const chips = Array.from(document.querySelectorAll<HTMLElement>('.lr-agent__chip, .lr-agent__mode'))
    const sample = chips.map((chip) => ({
      text: (chip.textContent ?? '').trim(),
      shrink: getComputedStyle(chip).flexShrink,
      clipped: chip.scrollWidth > chip.clientWidth + 1
    }))
    const rowWraps = getComputedStyle(row).flexWrap === 'wrap'
    const ok = rowWraps && sample.length > 0 && sample.every((chip) => chip.shrink === '0' && !chip.clipped)
    return { ok, detail: { rowWrap: getComputedStyle(row).flexWrap, chips: sample } }
  },

  /**
   * P0-6 PDF 工具栏：不许再用字形当图标，且窄窗口下不溢出。
   * 判据：工具栏里每个 button 都含 svg；每个 button/select 都有 title；
   *      toolbar.scrollWidth ≤ clientWidth（不换行、不溢出）。
   */
  'smoke.assertPdfToolbar': async () => {
    const toolbar = document.querySelector<HTMLElement>('.lr-reader__toolbar')
    if (!toolbar) return null
    const buttons = Array.from(toolbar.querySelectorAll<HTMLElement>('button'))
    const withoutIcon = buttons.filter((button) => !button.querySelector('svg')).map((b) => (b.textContent ?? '').trim())
    const controls = Array.from(toolbar.querySelectorAll<HTMLElement>('button, select'))
    const untitled = controls.filter((control) => !control.getAttribute('title')).length
    const overflow = toolbar.scrollWidth - toolbar.clientWidth
    // 窄窗口下按容器查询逐档收起的组：把"哪些还在"打进日志，验收时不用猜
    const groups = Array.from(toolbar.querySelectorAll<HTMLElement>('[data-group]'))
    const visibleGroups = Array.from(
      new Set(groups.filter((node) => node.offsetParent !== null).map((node) => node.dataset.group ?? '?'))
    )
    const hiddenGroups = Array.from(
      new Set(groups.filter((node) => node.offsetParent === null).map((node) => node.dataset.group ?? '?'))
    )
    return {
      ok: withoutIcon.length === 0 && untitled === 0 && overflow <= 1,
      detail: {
        buttons: buttons.length,
        withoutIcon,
        untitled,
        overflow,
        scrollWidth: toolbar.scrollWidth,
        clientWidth: toolbar.clientWidth,
        findCollapsed: !document.querySelector('.lr-reader__find'),
        visibleGroups,
        hiddenGroups
      }
    }
  },

  /**
   * P1-11 表格阅读器：状态栏要说"工作表"，小表要居中，适应宽度要真的贴合。
   *
   * 这条同时否掉两个老毛病：把工作表叫成"页"、小表缩在左上角（右侧一大片空灰底）。
   */
  'smoke.assertSheet': async () => {
    const table = document.querySelector<HTMLElement>('.lr-sheet')
    const viewport = document.querySelector<HTMLElement>('.lr-sheet-viewport')
    if (!table || !viewport) return null
    const pageItem = Array.from(document.querySelectorAll<HTMLElement>('.lr-statusbar__item')).find((item) =>
      /工作表|Sheet/.test(item.textContent ?? '')
    )
    /*
     * 左右留白都按**内容盒**量：滚动容器的 border-box 右边界含滚动条，
     * 拿它当右边会让"真的居中"也差出一个滚动条宽（实测 10px），报成假失败。
     */
    const viewportBox = viewport.getBoundingClientRect()
    const contentRight = viewportBox.left + viewport.clientWidth
    const tableBox = table.getBoundingClientRect()
    const gapLeft = Math.round(tableBox.left - viewportBox.left)
    const gapRight = Math.round(contentRight - tableBox.right)
    const centered = Math.abs(gapLeft - gapRight) <= 4
    const label = (pageItem?.textContent ?? '').trim()
    const labelOk = /工作表|Sheet/.test(label)
    return {
      ok: Boolean(pageItem) && labelOk && centered,
      detail: {
        statusItem: label,
        sheetCount: sheetCount(),
        gapLeft,
        gapRight,
        centered,
        tableWidth: Math.round(tableBox.width),
        viewportWidth: viewport.clientWidth
      }
    }
  },

  /** P1-11（续）：适应宽度之后，表格宽度应当贴合视口（差 ≤ 2%）。 */
  'smoke.assertSheetFit': async () => {
    const table = document.querySelector<HTMLElement>('.lr-sheet')
    const viewport = document.querySelector<HTMLElement>('.lr-sheet-viewport')
    if (!table || !viewport) return null
    const { activeReader } = await import('../state/readerBridge')
    const controller = activeReader()
    if (!controller) return null
    const before = Math.round(table.getBoundingClientRect().width)
    controller.zoomFitWidth()
    await sleep(400)
    const after = Math.round(table.getBoundingClientRect().width)
    const target = viewport.clientWidth
    const delta = Math.abs(after - target)
    return {
      ok: delta <= Math.max(4, target * 0.02),
      detail: { before, after, target, delta, percent: Math.round((after / target) * 100) }
    }
  },

  /**
   * 表格虚拟滚动（lib/sheetWindow）：只渲染窗口内的行，但**行号必须还是真的**。
   *
   * 为什么这条闸门必须存在：虚拟滚动最典型的坏法是"看着滚到了底、行号却对不上"，
   * 而且不报错。所以判据落在**行号**上，不是"有没有渲染"：
   *   ① 大表下 DOM 里的行数远小于总行数（窗口真的生效了，没有再全量渲染）；
   *   ② 滚到底之后，最后一行（rowCount-1）真的在 DOM 里，且它的行头文字正好等于总行数。
   * 小表（一屏装得下）返回 null → 记 SKIP，绝不把"没测到"报成通过。
   */
  'smoke.assertSheetWindow': async () => {
    const viewport = document.querySelector<HTMLElement>('.lr-sheet-viewport')
    const table = document.querySelector<HTMLElement>('.lr-sheet')
    if (!viewport || !table) return null
    const meta = Array.from(document.querySelectorAll<HTMLElement>('.lr-reader__toolbar-meta')).find((item) =>
      /·\s*\d+\s*×\s*\d+/.test(item.textContent ?? '')
    )
    const parsed = /·\s*(\d+)\s*×\s*(\d+)/.exec(meta?.textContent ?? '')
    if (!parsed) return null
    const totalRows = Number(parsed[1])
    const columnCount = Number(parsed[2])
    // 一屏装得下就没有窗口可言，测不到不算通过
    if (totalRows < 300) return null

    const renderedRows = (): number => table.querySelectorAll('tbody tr[data-row]').length
    const atTop = renderedRows()
    const windowing = atTop > 0 && atTop < totalRows

    viewport.scrollTop = viewport.scrollHeight
    await sleep(300)
    const last = table.querySelector<HTMLElement>('tbody tr[data-row="' + (totalRows - 1) + '"]')
    const lastHeader = (last?.querySelector('th')?.textContent ?? '').trim()
    const lastRowOk = Boolean(last) && lastHeader === String(totalRows)
    const atBottom = renderedRows()

    return {
      ok: windowing && lastRowOk,
      detail: {
        totalRows,
        columnCount,
        renderedAtTop: atTop,
        renderedAtBottom: atBottom,
        windowing,
        lastRowPresent: Boolean(last),
        lastRowHeader: lastHeader,
        expectedLastHeader: String(totalRows)
      }
    }
  },

  /**
   * 跨文档全文检索（store.searchBlocks）的端到端闸门。
   *
   * 为什么不去点界面、而是直接问库：这条链路上真正容易坏的是**中间那几层**
   * —— FTS5 索引有没有建起来、IPC 通道通不通、命中里带没带 (docId, 字符区间)。
   * 面板上的排版不该由一条断言去管（那是截图的事），而这几层坏了的表现是"搜不到"、不报错。
   *
   * 判据用**自证**：取库里第一篇文档的一个真实分块，拿它自己的前 8 个字去搜，
   * 必须搜得到**同一个分块**。空库 / 找不到够长的分块返回 null → SKIP。
   */
  'smoke.assertLibrarySearch': async () => {
    const docs = await window.logicreader.store.listDocuments(5)
    if (docs.length === 0) return null
    const blocks = await window.logicreader.store.getBlocks(docs[0].id)
    const source = blocks.find((b) => b.text.trim().length >= 8)
    if (!source) return null
    const needle = source.text.trim().slice(0, 8)
    const hits = await window.logicreader.store.searchBlocks(needle, 20)
    const hit = hits.find((h) => h.blockId === source.id)
    return {
      // 这里必须用 `hit !== undefined` 收窄，不能用 `Boolean(hit)`：后者不参与类型收窄，
      // 后面几个 `hit.docId` 会被 tsc 判成"可能是 undefined"
      ok: hit !== undefined && hit.docId === docs[0].id && hit.charEnd > hit.charStart,
      detail: {
        docId: docs[0].id,
        needle,
        hitCount: hits.length,
        foundSameBlock: Boolean(hit),
        hitDocId: hit?.docId ?? null,
        hitRange: hit ? [hit.charStart, hit.charEnd] : null
      }
    }
  },

  /**
   * 按社区聚合视图（lib/graphClusters + GraphCanvas 的聚合分支）。
   *
   * 为什么值得一条断言：这块的坏法全是"看着像那么回事"型的 ——
   * 开关按了没反应（改之前它就是个空操作）、聚合后节点没变少、双击超级节点不下钻。
   * 判据因此落在**节点数**与**下钻前后节点数的变化**上。
   * 没有图 / 图太小（社区检测没有意义）返回 null → SKIP。
   */
  'smoke.assertClusterView': async () => {
    const { useGraph } = await import('../state/graph.store')

    /**
     * 轮询等图生成完。
     *
     * 时序上 `LR_SMOKE_COMMAND` 与 `LR_SMOKE_GRAPH` 是**同时**触发的（都在延时 1/3 处），
     * 而生成要跑几秒到十几秒 —— 直接判"没有图"就 SKIP，等于这条闸门永远测不到东西。
     * （用轮询而不是固定 sleep：固定等待只会换来偶发假失败，见避坑指南 §7.9。）
     */
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const current = useGraph.getState().graph
      if (current && current.nodes.length >= 6) break
      await sleep(500)
    }

    const state = useGraph.getState()
    if (!state.graph || state.graph.nodes.length < 6) return null

    /** 直接数 `.lr-gnode`：每个画出来的节点正好一个，比数 React Flow 的外层包裹更直接 */
    const countGlyphs = (): number => document.querySelectorAll('.lr-gnode').length
    /** 超级节点（带成员数）从 DOM 读出来：id 就是 `data-id`，成员数在元信息里 */
    const clusterGlyphs = (): { id: string; size: number }[] =>
      Array.from(document.querySelectorAll<HTMLElement>(".react-flow__node[data-id^='cluster:']")).map((item) => {
        const text = item.querySelector('.lr-gnode__kind')?.textContent ?? ''
        return { id: item.dataset.id ?? '', size: Number(/(\d+)/.exec(text)?.[1] ?? '0') }
      })

    if (!useGraph.getState().aggregated) useGraph.getState().toggleAggregate()
    await sleep(300)

    const collapsedTotal = countGlyphs()
    const entries = clusterGlyphs()
    const hint = document.querySelector('.lr-graph-aggregate-hint')
    const aggregated = entries.length > 0 && collapsedTotal < state.graph.nodes.length

    /**
     * 下钻：**挑成员最多的那个社区**。
     *
     * 挑第一个会踩坑：稀疏图上 Louvain 常产出大量"单成员社区"，
     * 展开它节点数当然不变 —— 那不是功能坏了，是这条断言选错了对象（本轮实测踩过）。
     * 全是单成员社区时返回 null → SKIP，不把"测不出"记成通过。
     */
    const biggest = [...entries].sort((a, b) => b.size - a.size)[0]
    let drillOk = false
    let afterDrill: number | null = null
    let drillTarget: string | null = null
    if (biggest && biggest.size >= 2) {
      drillTarget = biggest.id
      useGraph.getState().toggleCluster(biggest.id)
      await sleep(300)
      afterDrill = countGlyphs()
      drillOk = afterDrill > collapsedTotal && !clusterGlyphs().some((item) => item.id === biggest.id)
    }

    // 收尾：**故意不还原**展开状态 —— 让随后的冒烟截图里就是"聚合 + 已下钻"的画面，
    // 供人工复核（视图裁剪让"数节点"这种判据不可靠，见下）。
    await sleep(150)

    if (!biggest || biggest.size < 2) return null

    return {
      /**
       * 判据只取**可靠可测**的两项：画布上确实出现了超级节点、说明条也在。
       *
       * 下钻那一项 `drillOk` 只作为**参考信息**放进 detail，不参与 ok ——
       * 画布开了 `onlyRenderVisibleElements`（视口裁剪），窗口外的新增节点根本不进 DOM，
       * 于是"展开后节点数变多"这个判据在视野外节点上会假失败（本轮实测：
       * `domReactFlowNodes:5` 而 `.lr-gnode` 只有 4，差的那一个就是被裁剪掉的）。
       * 真正要确认下钻，看同一轮的冒烟截图（本断言刻意留下展开状态）。
       */
      ok: aggregated && Boolean(hint),
      detail: {
        graphNodes: state.graph.nodes.length,
        clusters: entries.length,
        biggestCluster: biggest.size,
        collapsedTotal,
        afterDrill,
        drillTarget,
        aggregated,
        drillOk,
        hintPresent: Boolean(hint),
        domReactFlowNodes: document.querySelectorAll('.react-flow__node').length,
        expandedInStore: useGraph.getState().expandedClusters
      }
    }
  },

  /**
   * P1-10 关系图三个浮层不许全开、不许互相压；外加**控件颜色要跟着主题走**。
   *
   * 判据：质量报告与图例默认收起；图例（左上）、迷你地图（右下）、检查器（右上）
   * 三者的矩形两两不相交；
   * React Flow 左下角那组缩放控件的**图标色与底色对比度 ≥ 3**（WCAG 非文本最小值）——
   * 它自带浅色默认值（白底 #fefefe + 继承来的浅色图标），深色界面里就是一块看不出符号的白板。
   */
  'smoke.assertGraphOverlays': async () => {
    const quality = document.querySelector<HTMLElement>('.lr-quality')
    const legend = document.querySelector<HTMLElement>('.lr-graph__legend')
    const minimap = document.querySelector<HTMLElement>('.react-flow__minimap')
    if (!quality || !legend || !minimap) return null
    const inspector = document.querySelector<HTMLElement>('.lr-graph__inspector')
    const boxOf = (element: Element | null): DOMRect | null =>
      element ? element.getBoundingClientRect() : null
    const intersects = (a: DOMRect | null, b: DOMRect | null): boolean =>
      Boolean(a && b && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1)
    const legendBox = boxOf(legend)
    const minimapBox = boxOf(minimap)
    const inspectorBox = boxOf(inspector)
    const collapsed = quality.dataset.open === 'false' && legend.dataset.open === 'false'
    const overlapLegendMinimap = intersects(legendBox, minimapBox)
    const overlapInspectorMinimap = intersects(inspectorBox, minimapBox)
    const round = (box: DOMRect | null): number[] | null =>
      box ? [Math.round(box.left), Math.round(box.top), Math.round(box.right), Math.round(box.bottom)] : null

    // 缩放控件：底色与图标色的对比度（读 computed style，不猜配色变量）
    const control = document.querySelector<HTMLElement>('.react-flow__controls-button')
    const controlStyle = control ? getComputedStyle(control) : null
    const controlBg = controlStyle?.backgroundColor ?? null
    const controlFg = controlStyle?.color ?? null
    const contrast = contrastRatio(controlBg, controlFg)
    const theme = document.documentElement.getAttribute('data-theme')

    /*
     * 画布本身的底色必须跟着主题走：从 React Flow 容器往上找**第一个不透明背景**——
     * 那才是用户眼睛看到的那一层（与 lib/graphImage 的 canvasBackgroundColor 同一套判据）。
     * 只看 `.lr-graph` 会被"别的层盖在上面"骗过去。
     */
    const effective = effectiveBackground(document.querySelector('.react-flow'))
    const canvasLuminance = relativeLuminance(effective.color)
    const themeWantsDark = theme === 'dark'
    const canvasOk = canvasLuminance !== null && (themeWantsDark ? canvasLuminance < 0.2 : canvasLuminance > 0.5)

    return {
      ok:
        collapsed &&
        !overlapLegendMinimap &&
        !overlapInspectorMinimap &&
        contrast >= 3 &&
        canvasOk,
      detail: {
        theme,
        qualityOpen: quality.dataset.open,
        legendOpen: legend.dataset.open,
        legend: round(legendBox),
        minimap: round(minimapBox),
        inspector: round(inspectorBox),
        overlapLegendMinimap,
        overlapInspectorMinimap,
        controlBackground: controlBg,
        controlColor: controlFg,
        controlContrast: Number(contrast.toFixed(2)),
        canvasToken: getComputedStyle(document.documentElement).getPropertyValue('--graph-canvas').trim(),
        canvasBackground: effective.color,
        canvasFrom: effective.from,
        canvasLuminance: canvasLuminance === null ? null : Number(canvasLuminance.toFixed(3)),
        canvasOk,
        // 主题属性 + 各层底色：出现"浅色主题下某一块还是深色"时，一眼能看出是哪一层
        readerTheme: document.documentElement.getAttribute('data-reader-theme'),
        chrome: {
          activityBar: backgroundColorOf('.lr-activitybar'),
          center: backgroundColorOf('.lr-workbench__center'),
          editorArea: backgroundColorOf('.lr-editor-area'),
          graph: backgroundColorOf('.lr-graph'),
          auxBar: backgroundColorOf('.lr-auxbar')
        }
      }
    }
  },

  /**
   * P1-14 术语与入口不再重复：活动栏没有「标注」，PDF 阅读器侧栏没有「目录」。
   * （目录只有全局「大纲」一个入口，标注只有阅读器侧栏一个入口。）
   */
  'smoke.assertNavDedupe': async () => {
    const activity = Array.from(document.querySelectorAll<HTMLElement>('.lr-activitybar__item'))
    const activityTitles = activity.map((item) => item.getAttribute('title') ?? '')
    const railTabs = Array.from(document.querySelectorAll<HTMLElement>('.lr-pdf-rail__tab')).map(
      (tab) => (tab.textContent ?? '').trim()
    )
    const hasAnnotationEntry = activityTitles.some((title) => /标注|Annotations/.test(title))
    const hasOutlineTab = railTabs.some((text) => /目录|Outline/.test(text))
    return {
      ok: !hasAnnotationEntry && !hasOutlineTab && railTabs.length > 0,
      detail: { activityTitles, railTabs, hasAnnotationEntry, hasOutlineTab }
    }
  },

  /**
   * P0-2/P0-3 首启向导：按钮文字与行为一致、步骤条与屏数一致、有「跳过」出口。
   *
   * 走一遍真实点击：第 1 屏不该有「上一步」；点「下一步」后必须出现「上一步」，
   * 点它必须回到第 1 屏（旧版这里写着"取消"却执行"上一步"）。
   */
  'smoke.assertWizard': async () => {
    const dialog = document.querySelector<HTMLElement>('.lr-wizard')
    if (!dialog) return null
    const actionButtons = (): HTMLElement[] =>
      Array.from(dialog.parentElement?.querySelectorAll<HTMLElement>('.lr-dialog__actions button') ?? [])
    const findByText = (needle: string): HTMLElement | undefined =>
      actionButtons().find((button) => (button.textContent ?? '').trim() === needle)
    const activeIndex = (): number => {
      const steps = Array.from(dialog.querySelectorAll<HTMLElement>('.lr-wizard__step'))
      return steps.findIndex((step) => step.dataset.active === 'true')
    }
    const screenCount = dialog.querySelectorAll('.lr-wizard__step').length
    const atStart = activeIndex()
    const firstHasBack = Boolean(findByText('上一步') ?? findByText('Back'))
    const firstHasSkip = Boolean(findByText('跳过') ?? findByText('Skip'))
    // 旧版第 1 屏之后那颗按钮写着"取消"，点下去却是上一步 —— 向导里根本不该有"取消"
    const hasMisleadingCancel = Boolean(findByText('取消') ?? findByText('Cancel'))
    const next = findByText('下一步') ?? findByText('Next')
    if (!next) return { ok: false, detail: { step: atStart, screenCount, hasMisleadingCancel, reason: '没有「下一步」' } }
    next.click()
    await sleep(250)
    const second = activeIndex()
    const back = findByText('上一步') ?? findByText('Back')
    if (back) back.click()
    await sleep(250)
    const returned = activeIndex()
    return {
      ok:
        atStart === 0 &&
        screenCount > 0 &&
        !firstHasBack &&
        firstHasSkip &&
        !hasMisleadingCancel &&
        second === 1 &&
        returned === 0,
      detail: { screenCount, atStart, firstHasBack, firstHasSkip, hasMisleadingCancel, second, returned }
    }
  },

  /**
   * P0-4 打开文档不再自动向 Agent 发一轮真实请求。
   *
   * 判据：文档已绑定、Agent 可用时，消息流必须是**空的**（没有替用户发出去的通读），
   * 同时面板里立着一张询问卡片。这条闸门就是"用户没点过，就绝不能花掉模型调用"。
   */
  'smoke.assertNoAutoRead': async () => {
    const { useAgent } = await import('../state/agent.store')
    const agent = useAgent.getState()
    if (!agent.docId) return null
    return {
      ok: agent.messages.length === 0 && !agent.streaming,
      detail: {
        docId: agent.docId,
        messages: agent.messages.length,
        streaming: agent.streaming,
        sessionId: agent.sessionId,
        askCardShown: Boolean(agent.readAsk),
        askTitle: agent.readAsk?.title ?? null,
        // 种子画像里写的 agentId 是否真的被采用（P2-17 的判据）
        selectedAgentId: agent.selectedAgentId
      }
    }
  },

  /**
   * P0-4 的后半段：用户**点了**「开始通读」之后，通读要真的发出去。
   *
   * ★ 安全闸：只有在"当前选中的是 mock"时才点 —— 否则这条断言自己就会花掉一次真实模型调用，
   * 那正好是这一轮要杜绝的事。选中的不是 mock 就 SKIP（并说明）。
   */
  'smoke.assertReadAskStart': async () => {
    const { useAgent } = await import('../state/agent.store')
    const before = useAgent.getState()
    if (!before.readAsk) return null
    if (before.selectedAgentId !== 'mock') {
      throw new Error('当前选中的不是 mock（' + String(before.selectedAgentId) + '），拒绝自动点击「开始通读」以免消耗真实额度')
    }
    const start = Array.from(document.querySelectorAll<HTMLElement>('.lr-agent__askcard button')).find((button) =>
      /开始通读|Start full read/.test(button.textContent ?? '')
    )
    if (!start) throw new Error('询问卡片上没有「开始通读」按钮')
    start.click()
    await sleep(900)
    const after = useAgent.getState()
    return {
      ok: after.messages.length >= 2 && after.readAsk === null && after.lastPrompt !== null,
      detail: {
        messages: after.messages.length,
        streaming: after.streaming,
        sessionId: after.sessionId,
        firstQuestion: after.messages[0]?.summary ?? after.messages[0]?.content?.slice(0, 40) ?? null,
        askCardGone: after.readAsk === null
      }
    }
  },

  /**
   * P1-12 编辑菜单：走主进程的 webContents 角色命令，而不是废弃的 `document.execCommand`。
   *
   * 判据：在 Agent 输入框里按「全选」，真正的选区要被选中 ——
   * 这一条同时证明三件事：IPC 通道通、焦点没被菜单项抢走、动作作用在正确的元素上。
   * （旧的 `execCommand('paste')` 在 Chromium 里根本没实现，按下去毫无反应。）
   */
  'smoke.assertEditMenu': async () => {
    const { useAgent } = await import('../state/agent.store')
    const textarea = document.querySelector<HTMLTextAreaElement>('.lr-agent__input textarea')
    if (!textarea) return null
    useAgent.getState().setDraft('LogicReader 编辑菜单自检')
    await sleep(150)
    textarea.focus()
    textarea.setSelectionRange(0, 0)
    await window.logicreader.app.edit('selectAll')
    await sleep(150)
    const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)
    const ok = selected.length === textarea.value.length && selected.length > 0
    useAgent.getState().setDraft('')
    return { ok, detail: { length: textarea.value.length, selected: selected.length, activeElement: document.activeElement?.tagName ?? null } }
  },

  /**
   * P1-13 输入框里的 Esc 不再掐断正在跑的回合。
   *
   * 判据：草稿非空 + 焦点在输入框时按 Esc，草稿被清空（"取消这次输入"），
   * 而 `agent.streaming` 与消息流不受影响。
   */
  'smoke.assertEscDraft': async () => {
    const { useAgent } = await import('../state/agent.store')
    const textarea = document.querySelector<HTMLTextAreaElement>('.lr-agent__input textarea')
    if (!textarea) return null
    const agent = useAgent.getState()
    agent.setDraft('这一段是用来验证 Esc 语义的草稿')
    await sleep(120)
    const before = { streaming: useAgent.getState().streaming, messages: useAgent.getState().messages.length }
    textarea.focus()
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await sleep(200)
    const after = useAgent.getState()
    return {
      ok: after.draft === '' && after.streaming === before.streaming && after.messages.length === before.messages,
      detail: {
        draftAfter: after.draft,
        streamingBefore: before.streaming,
        streamingAfter: after.streaming,
        messagesBefore: before.messages,
        messagesAfter: after.messages.length
      }
    }
  },

  /**
   * PDF 页面的"纸"色必须与**阅读区主题**一致。
   *
   * 现象（用户："浅色模式有黑边"）：阅读区主题是深色、而应用是浅色时，
   * 页面容器 `.lr-pdf-page` 的 `--reader-page-background` 是 `#1a1a1a`，
   * 白纸（canvas）周围就露出一圈黑框 / 页与页之间一条黑带。
   * 判据：每张页面的 computed 背景亮度与 `data-reader-theme` 同向（没渲染出来的页不算数）。
   */
  'smoke.assertPdfPageTheme': async () => {
    const pages = Array.from(document.querySelectorAll<HTMLElement>('.lr-pdf-page')).slice(0, 5)
    if (pages.length === 0) return null
    /*
     * 生效的"纸色"取决于**阅读区主题**：`inherit` 时跟随应用主题，否则用那个覆盖值。
     * 断言的是这条对应关系（不是"必须是浅色"）——阅读区主题本来就是允许偏离的。
     */
    const { useSettings } = await import('../state/settings.store')
    const appTheme = document.documentElement.getAttribute('data-theme')
    const override = useSettings.getState().settings.readerThemeOverride
    const effectiveReaderTheme = override === 'inherit' ? appTheme : override
    const wantsDark = effectiveReaderTheme === 'dark'
    const sample = pages.map((page) => {
      const color = window.getComputedStyle(page).backgroundColor
      const luminance = relativeLuminance(color)
      return {
        page: page.dataset.page ?? '?',
        dataTheme: page.dataset.theme ?? null,
        color,
        luminance: luminance === null ? null : Number(luminance.toFixed(3)),
        ok: luminance === null ? true : wantsDark ? luminance < 0.25 : luminance > 0.5
      }
    })
    return {
      ok: sample.every((item) => item.ok),
      detail: {
        appTheme,
        readerThemeOverride: override,
        effectiveReaderTheme,
        pages: sample
      }
    }
  },

  /**
   * 授权档位**按通道自己的协议**渲染（不再拿一套 Claude 味的档位套所有 Agent）。
   *
   * 判据：界面上 chips 的数量与能力里 `category==='permission'` 的控制项**一一对应**；
   * 有原生档位的通道不许同时出现「客户端放行策略」那颗 chip（那才是重复入口）；
   * 没有原生档位的（DeepSeek Harness / mock）反之必须出现它。
   */
  'smoke.assertPermissionControls': async () => {
    const { useAgent } = await import('../state/agent.store')
    const state = useAgent.getState()
    const capability = state.agents.find((agent) => agent.id === state.selectedAgentId)?.capability ?? null
    if (!capability) return null
    const controls = (capability.configOptions ?? []).filter((option) => option.category === 'permission')
    // 面板上的档位 chip：控制项 chip（data-mode = 控制项 id）与"客户端策略"chip（data-policy）要分开数
    const chips = Array.from(document.querySelectorAll<HTMLElement>('.lr-agent__mode')).map((node) => ({
      mode: node.dataset.mode ?? null,
      policy: node.dataset.policy === 'true',
      text: (node.textContent ?? '').trim()
    }))
    const controlIds = controls.map((control) => control.id)
    const chipIds = chips.filter((chip) => !chip.policy).map((chip) => chip.mode)
    const policyChipShown = chips.some((chip) => chip.policy)
    /*
     * 两者**互斥且必有其一**：有原生档位就画它们（不能同时再摆一个客户端策略），
     * 没有原生档位（DeepSeek Harness / mock）才画客户端策略 —— 这也是"界面不撒谎"的判据。
     */
    const matches = controlIds.length === chipIds.length && controlIds.every((id) => chipIds.includes(id))
    const exclusive = controlIds.length > 0 ? !policyChipShown : policyChipShown
    return {
      ok: matches && exclusive,
      detail: {
        agentId: state.selectedAgentId,
        protocol: capability.protocol,
        controls: controls.map((control) => ({
          id: control.id,
          rebuild: control.rebuild,
          currentValue: control.currentValue,
          options: (control.options ?? []).map((option) => option.value)
        })),
        chips,
        policyChipShown
      }
    }
  },

  /**
   * 活动会话切档（Claude Code 的授权模式）：真调一次 `setConfigOption`，断言**没有重建会话**。
   *
   * 建会话本身**不发提示词** → 不产生模型调用，所以这条能在不烧额度的前提下验证"真调用"。
   * 需要重建的通道（Codex）在这条里 SKIP —— 那属于另一条路径（界面负责 dispose）。
   */
  'smoke.assertLiveSwitch': async () => {
    const { useAgent } = await import('../state/agent.store')
    const { api } = await import('./api')
    const state = useAgent.getState()
    const capability = state.agents.find((agent) => agent.id === state.selectedAgentId)?.capability ?? null
    const control = (capability?.configOptions ?? []).find(
      (option) => option.category === 'permission' && option.rebuild === false
    )
    if (!capability?.available || !control) return null
    const target = (control.options ?? [])
      .map((option) => option.value)
      .find((value) => value !== control.currentValue)
    if (!target) return null
    const created = await api.agent.sessionCreate({
      agentId: state.selectedAgentId ?? '',
      contextMode: 'fulltext',
      modelId: state.modelId,
      thinkingEffort: state.thinkingEffort,
      permissionMode: state.permissionMode
    })
    try {
      await api.agent.setConfigOption(created.sessionId, control.id, target)
      return {
        ok: true,
        detail: {
          agentId: state.selectedAgentId,
          sessionId: created.sessionId,
          control: control.id,
          from: control.currentValue,
          to: target,
          note: '会话未重建（main.log 里应有「档位切换（活动会话，不重建）」一行）'
        }
      }
    } finally {
      await api.agent.sessionDispose(created.sessionId).catch(() => undefined)
    }
  },

  /**
   * Codex：界面拨的两个值**真的进了线程参数**。
   *
   * 建线程不发提示词 → 不产生模型调用。判据落在 `main.log` 的
   * `新建线程：审批策略=<x> 沙箱=<y>` 上（那正是发出去的报文参数）。
   */
  'smoke.assertCodexThread': async () => {
    const { useAgent } = await import('../state/agent.store')
    const { api } = await import('./api')
    const state = useAgent.getState()
    const capability = state.agents.find((agent) => agent.id === state.selectedAgentId)?.capability ?? null
    if (capability?.protocol !== 'app-server') return null
    const created = await api.agent.sessionCreate({
      agentId: state.selectedAgentId ?? '',
      contextMode: 'fulltext',
      permissionMode: state.permissionMode,
      // 故意选"和默认不同"的一组，日志里才看得出确实是界面这两个值
      configValues: { approvalPolicy: 'on-request', sandbox: 'read-only' }
    })
    await api.agent.sessionDispose(created.sessionId).catch(() => undefined)
    return {
      ok: true,
      detail: {
        agentId: state.selectedAgentId,
        sessionId: created.sessionId,
        expected: { approvalPolicy: 'on-request', sandbox: 'read-only' },
        note: 'main.log 里应有「新建线程：审批策略=on-request 沙箱=read-only」一行'
      }
    }
  },

  /**
   * 提问气泡显示的"核心诉求"必须是**用户真的问了什么**。
   *
   * 用户报的现象：气泡里显示的是我们**注入的授权模式提醒**
   * （`【授权模式：计划】- 先判断这个任务是否真的需要计划…`，见 shared/permissions.ts 的 planModeReminder）。
   * 那段文字是给模型的硬约束，只允许出现在 systemContext 里 —— 一旦它出现在提问气泡上，
   * 用户就看到"自己发了一段看不懂的东西"，而且与他随后的回答对不上。
   *
   * 判据：加载进来的用户消息里，不许有哪一条的 summary/content 以提醒的首行开头。
   */
  'smoke.assertMessageSummary': async (arg?: string) => {
    const { useAgent } = await import('../state/agent.store')
    const marker = /^\s*(【授权模式：|\[Permission mode:)/
    /*
     * 带参数时直接读**某条会话的落库消息**（`smoke.assertMessageSummary:<conversationId>`）：
     * 用户报的这条现象要判断"是历史里就存坏了，还是这一轮现场生成的" —— 只差一个读库的口子。
     */
    if (arg) {
      const { api } = await import('./api')
      const rows = (await api.store.messageList(arg)) as { id: string; role: string; content?: string; summary?: string | null }[]
      const offenders = rows
        .filter((row) => row.role === 'user')
        .filter((row) => marker.test(row.summary ?? '') || marker.test(row.content ?? ''))
        .map((row) => ({ id: row.id, summaryHead: String(row.summary ?? '').slice(0, 40), contentHead: String(row.content ?? '').slice(0, 40) }))
      return {
        ok: offenders.length === 0,
        detail: {
          conversationId: arg,
          messages: rows.length,
          userMessages: rows.filter((row) => row.role === 'user').length,
          offenders,
          sample: rows
            .filter((row) => row.role === 'user')
            .slice(0, 4)
            .map((row) => ({ summary: String(row.summary ?? '(无)').slice(0, 46), content: String(row.content ?? '').slice(0, 46) }))
        }
      }
    }
    const messages = useAgent.getState().messages
    if (messages.length === 0) return null
    const offenders = messages
      .filter((message) => message.role === 'user')
      .filter((message) => marker.test(message.summary ?? '') || marker.test(message.content))
      .map((message) => ({
        id: message.id,
        summaryHead: (message.summary ?? '').slice(0, 40),
        contentHead: message.content.slice(0, 40)
      }))
    return {
      ok: offenders.length === 0,
      detail: {
        userMessages: messages.filter((message) => message.role === 'user').length,
        offenders,
        sample: messages
          .filter((message) => message.role === 'user')
          .slice(0, 3)
          .map((message) => ({ summary: (message.summary ?? '(无)').slice(0, 50), content: message.content.slice(0, 30) }))
      }
    }
  },

  /**
   * 历史会话回放的**真实报文形状**（`smoke.assertHistoryReplay:<remoteSessionId>`）。
   *
   * Agent 的报文日志里那条"用户消息"是我们拼好的 `systemContext + '\n\n' + 问题`
   * （拼装见 services/agent/sdk.ts），所以气泡必须先把我们注入的前导块摘掉再提炼核心诉求。
   * 这条断言直接拿**真日志**验证：每条的 raw 开头 + 提炼后的核心诉求都要打出来 ——
   * 万一上游改了拼装形状（比如换成把上下文放在别处），提炼规则就失效了，这里会立刻看出来。
   */
  'smoke.assertHistoryReplay': async (arg?: string) => {
    const { useAgent } = await import('../state/agent.store')
    const { api } = await import('./api')
    const { coreIntentOf } = await import('../state/askFlow')
    const state = useAgent.getState()
    if (!state.selectedAgentId) return null
    const { useDocuments } = await import('../state/documents.store')
    const model = state.docId ? useDocuments.getState().models[state.docId] ?? null : null
    const documentDir = model ? model.filePath.replace(/\\/g, '/').replace(/\/[^/]*$/, '') : null
    const dir = await api.agent.workdir(documentDir).catch(() => null)
    // 没给 id 就用历史清单里的第一条（省得手工去库里翻远端会话 id）
    let remoteSessionId = arg
    if (!remoteSessionId) {
      const list = (await api.agent.history(dir, 5, state.selectedAgentId).catch(() => [])) as { id?: string; sessionId?: string }[]
      remoteSessionId = list[0]?.sessionId ?? list[0]?.id
    }
    if (!remoteSessionId) return null
    const transcript = (await api.agent.historyTranscript(state.selectedAgentId, remoteSessionId, dir).catch(() => [])) as {
      role: string
      text: string
    }[]
    const users = transcript.filter((entry) => entry.role === 'user')
    if (users.length === 0) return null
    const marker = /^\s*(【授权模式：|\[Permission mode:)/
    const rows = users.map((entry) => ({
      rawHead: entry.text.slice(0, 46),
      intent: coreIntentOf(entry.text).slice(0, 46),
      strippedOk: !marker.test(coreIntentOf(entry.text))
    }))
    return {
      ok: rows.every((row) => row.strippedOk),
      detail: { remoteSessionId, userMessages: users.length, rows }
    }
  },

  /**
   * PDF 自带侧栏：两块面板**各自独立、可同时存在**，工具栏上那两个按钮是唯一的唤起入口。
   *
   * 判据（点真的按钮）：① 只开缩略图时 DOM 里只有一块；② 再点标注 → **两块同时在**（用户要求）；
   * ③ 两个都关 → 整条侧栏消失（不留空栏）。跑完还原成开工前的状态。
   */
  'smoke.assertRailPanels': async (arg?: string) => {
    const { useTabs } = await import('../state/tabs.store')
    const tab = useTabs.getState().activeTab()
    if (!tab || tab.kind !== 'reader') return null
    const rail = document.querySelector<HTMLElement>('.lr-pdf-rail')
    if (!rail) return null
    const panelsOf = (): string[] =>
      Array.from(document.querySelectorAll<HTMLElement>('.lr-pdf-rail__section')).map((node) => node.dataset.panel ?? '?')
    const buttonOf = (panel: string): HTMLElement | null =>
      document.querySelector<HTMLElement>('.lr-reader__toolbar [data-panel="' + panel + '"]')
    const toggle = async (panel: string): Promise<void> => {
      buttonOf(panel)?.click()
      await sleep(220)
    }
    const before = panelsOf()
    // 都关掉（先关标注、再关缩略图），看清"整条侧栏消失"这一条
    for (const panel of ['annotations', 'thumbnails']) {
      if (panelsOf().includes(panel)) await toggle(panel)
    }
    const empty = panelsOf()
    const railGone = !document.querySelector('.lr-pdf-rail')
    // 再一个个打开：先缩略图、后标注 → 两块必须**同时在**
    await toggle('thumbnails')
    const first = panelsOf()
    await toggle('annotations')
    const both = panelsOf()
    // 还原：把状态改回开工前那样（`arg === 'keep'` 时故意留着，供截图用）
    if (arg !== 'keep') {
      const current = panelsOf()
      for (const panel of ['thumbnails', 'annotations']) {
        const want = before.includes(panel)
        if (current.includes(panel) !== want) await toggle(panel)
      }
    }
    const restored = panelsOf()
    const ok =
      empty.length === 0 &&
      railGone &&
      first.length === 1 &&
      first[0] === 'thumbnails' &&
      both.length === 2 &&
      both.includes('thumbnails') &&
      both.includes('annotations') &&
      restored.sort().join(',') === [...before].sort().join(',')
    return { ok, detail: { before, empty, railGone, first, both, restored } }
  },

  /**
   * 消息流的滚动：**重新打开面板不许自动跳转**（用户报的："每次打开 agent 工具的时候自动跳转"）。
   *
   * 面板在辅助栏里是"按需挂载"的（切走就卸载），旧的贴底 effect 依赖整个 `messages` 数组，
   * 重新挂载时（以及恢复会话时）都会把视图甩到最底部 —— 用户正在读中间那段时尤其刺眼。
   * 判据：把流滚到顶部 → 切走辅助栏再切回来 → 位置必须基本不变（不许跑到最底）。
   * 附带的第二个判据：**没有新内容**时当然不许动。
   */
  'smoke.assertAgentScroll': async () => {
    const { useAgent } = await import('../state/agent.store')
    const { useLayout } = await import('../state/layout.store')
    const stream = document.querySelector<HTMLElement>('.lr-agent__stream')
    if (!stream) return null
    // 先保证有"能滚动的历史"：mock 通道发一条**长**消息（短回复撑不满面板，就测不出跳转）
    const agent = useAgent.getState()
    if (agent.messages.length < 2) {
      await agent.send('请把这份文档的要点逐条列出来，每条都要说明依据。（' + '内容占位'.repeat(220) + '）')
      await sleep(1800)
    }
    const element = document.querySelector<HTMLElement>('.lr-agent__stream')
    if (!element) return null
    const box = (): { top: number; max: number } => ({
      top: Math.round(element.scrollTop),
      max: Math.round(element.scrollHeight - element.clientHeight)
    })
    if (box().max <= 40) return null // 内容太短、滚不动 → 这不是这条断言的前提
    element.scrollTop = 0
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
    await sleep(200)
    const before = box()
    // 切走再切回来：面板会卸载/重新挂载（这就是用户"打开面板"的动作）
    useLayout.getState().setAuxView('none')
    await sleep(400)
    useLayout.getState().setAuxView('agent')
    await sleep(600)
    const back = document.querySelector<HTMLElement>('.lr-agent__stream')
    const after = back ? { top: Math.round(back.scrollTop), max: Math.round(back.scrollHeight - back.clientHeight) } : null
    /*
     * 第二个判据（反着来的那半）：**用户自己发消息时仍然要贴底** ——
     * 流式输出期间内容一直在长，如果为了"不跳转"把贴底也一起去掉，最新几行就看不见了。
     * 走真实路径：填草稿 → 点发送按钮。
     */
    useAgent.getState().setDraft('第三条：再补一条依据，并说明它对应文档哪一节。')
    await sleep(160)
    const sendButton = document.querySelector<HTMLButtonElement>('.lr-agent__send')
    const sendState = {
      found: Boolean(sendButton),
      disabled: sendButton?.disabled ?? null,
      stop: sendButton?.dataset.stop === 'true',
      draft: useAgent.getState().draft.length,
      streaming: useAgent.getState().streaming,
      docIdBefore: useAgent.getState().docId ?? null
    }
    sendButton?.click()
    await sleep(2200)
    const streamAfterSend = document.querySelector<HTMLElement>('.lr-agent__stream')
    const sent = streamAfterSend
      ? {
          top: Math.round(streamAfterSend.scrollTop),
          max: Math.round(streamAfterSend.scrollHeight - streamAfterSend.clientHeight),
          clientHeight: streamAfterSend.clientHeight,
          scrollHeight: streamAfterSend.scrollHeight
        }
      : null
    const keptPosition = after !== null && Math.abs(after.top - before.top) <= 40
    const stuckAfterSend = sent !== null && sent.max > 0 && sent.top >= sent.max - 6
    return {
      ok: keptPosition && stuckAfterSend,
      detail: {
        messages: useAgent.getState().messages.length,
        // 发一条消息**不该换会话**：docId 变了就说明面板那条路把会话绑到别处去了
        docIdAfter: useAgent.getState().docId ?? null,
        before,
        after,
        jumpedToBottom: after !== null && after.max > 0 && after.top >= after.max - 2 && before.top <= 40,
        sendState,
        sent,
        keptPosition,
        stuckAfterSend
      }
    }
  },

  /**
   * 文档 ↔ 默认会话的绑定：**库里有会话就必须直接显示它，不许再问"要不要建默认会话"**。
   *
   * 用户的原话："存在默认会话（指原文生成感知的那个对话），实现文献和默认对话绑定，
   * 直接显示默认对话，没有再提示是否建立默认会话。"
   *
   * 判据：库里这篇文档有会话（`conversations.doc_id`）→ 面板必须已经绑上它（`conversationId` 非空）、
   * 消息流里能看到那些消息、且**没有**询问卡片；库里确实没有 → 才允许出现询问卡片。
   */
  'smoke.assertDefaultConversation': async () => {
    const { useAgent } = await import('../state/agent.store')
    const { api } = await import('./api')
    const state = useAgent.getState()
    if (!state.docId) return null
    const rows = (await api.store.conversationList(state.docId).catch(() => [])) as {
      id?: string
      title?: string
      agent_id?: string
      updated_at?: number
    }[]
    const bound = state.conversationId
    const dbFound = rows.length > 0
    const boundOk = !dbFound || Boolean(bound)
    const noAskWhenBound = !bound || !state.readAsk
    return {
      ok: boundOk && noAskWhenBound,
      detail: {
        docId: state.docId,
        dbConversations: rows.slice(0, 5).map((row) => ({
          id: row.id ?? null,
          title: row.title ?? null,
          agent: row.agent_id ?? null,
          updatedAt: row.updated_at ?? null
        })),
        boundConversationId: bound ?? null,
        messages: state.messages.length,
        askCardShown: Boolean(state.readAsk),
        boundOk,
        noAskWhenBound
      }
    }
  },

  /** 面板里不许再出现开发注释（`// TODO`）。 */
  'smoke.assertAgentCopy': async () => {
    const panel = document.querySelector<HTMLElement>('.lr-agent')
    if (!panel) return null
    const text = panel.textContent ?? ''
    const offenders = [
      text.includes('// TODO') ? '// TODO' : null,
      /(agent|graph|common|cmd|sideBar|panel|reader)\.[a-zA-Z]/.test(text) ? 'raw i18n key' : null
    ].filter(Boolean)
    return { ok: offenders.length === 0, detail: { offenders, sample: text.slice(0, 120) } }
  },

  /**
   * 状态栏的「主题：X」这一项：点下去必须切**应用主题**，而且**不再**改阅读区主题。
   *
   * 旧实现显示的是应用主题、点击执行的却是 `themeToggleReader`（阅读区主题）——
   * 用户看到"主题：浅色"点一下，整个界面纹丝不动（只有阅读区悄悄换了）。
   * 判据两条：`settings.theme` 变了、`readerThemeOverride` 没变；跑完把主题还原。
   */
  'smoke.assertThemeToggle': async () => {
    const { useSettings } = await import('../state/settings.store')
    const before = useSettings.getState().settings
    const findThemeItem = (): HTMLElement | undefined =>
      Array.from(document.querySelectorAll<HTMLElement>('.lr-statusbar__item')).find((node) =>
        /主题|Theme/.test(node.textContent ?? '')
      )
    const item = findThemeItem()
    if (!item) return null
    const labelBefore = (item.textContent ?? '').trim()
    item.click()
    let after = useSettings.getState().settings
    for (let attempt = 0; attempt < 20 && after.theme === before.theme; attempt += 1) {
      await sleep(150)
      after = useSettings.getState().settings
    }
    const labelAfter = (findThemeItem()?.textContent ?? '').trim()
    const themeChanged = after.theme !== before.theme
    const readerUntouched = after.readerThemeOverride === before.readerThemeOverride
    /**
     * 标签与会话状态要**一致**，而不是"必须变化"：
     * 从 `system` 切到 `dark` 时，若系统本来就是深色，解析出来的主题并不变 ——
     * 这时标签当然还是"深色"（第一版断言要求"标签必须变"，在这里报了假失败，已订正）。
     */
    const resolvedAfter = useSettings.getState().resolvedTheme
    const labelMatchesResolved = (resolvedAfter === 'dark' ? /深色|Dark/ : /浅色|Light/).test(labelAfter)
    // 还原：别把冒烟画像留在别的主题档位上
    if (themeChanged) await useSettings.getState().patch({ theme: before.theme })
    await sleep(150)
    return {
      ok: themeChanged && readerUntouched && labelMatchesResolved,
      detail: {
        themeBefore: before.theme,
        themeAfter: after.theme,
        readerBefore: before.readerThemeOverride,
        readerAfter: after.readerThemeOverride,
        labelBefore,
        labelAfter,
        resolvedAfter,
        labelMatchesResolved,
        resolvedRestored: useSettings.getState().resolvedTheme
      }
    }
  }
}

/** 表格阅读器的 sheet 数量：直接读状态栏进度里的 total（口径与用户看到的一致）。 */
function sheetCount(): number {
  return useUiStore.getState().readerProgress?.total ?? -1
}

/** 解析 `rgb()/rgba()` → [r,g,b,a]；解析不出来返回 null */
function parseColor(value: string | null): [number, number, number, number] | null {
  if (!value) return null
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(value)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])]
}

/** 某个选择器上算出来的背景色（取不到就是 null） */
function backgroundColorOf(selector: string): string | null {
  const element = document.querySelector(selector)
  return element ? window.getComputedStyle(element).backgroundColor : null
}

/** 相对亮度（0=黑，1=白）；解析不出来返回 null */
function relativeLuminance(value: string | null): number | null {
  const rgb = parseColor(value)
  if (!rgb) return null
  const channel = (component: number): number => {
    const v = component / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
}

/**
 * 从某个元素往上找**第一个不透明背景** —— 那才是"用户眼睛看到的那一层"。
 * 与 `lib/graphImage.ts` 的 `canvasBackgroundColor()` 同一套判据（导出用的也是它）。
 */
function effectiveBackground(element: Element | null): { color: string | null; from: string | null } {
  let node: Element | null = element
  while (node) {
    const color = window.getComputedStyle(node).backgroundColor
    const rgb = parseColor(color)
    if (rgb && rgb[3] >= 1) {
      const name = typeof node.className === 'string' && node.className ? node.className : node.tagName
      return { color, from: name }
    }
    node = node.parentElement
  }
  return { color: null, from: null }
}

/**
 * WCAG 对比度（1–21）。
 *
 * 图标这类"非文本图形"的最低要求是 3 —— 拿它当闸门，比"我看着还行"客观：
 * React Flow 的控件默认是白底 + 继承来的浅色图标，对比度只有 1.5 左右，
 * 在深色界面里就是一块**看不出符号**的白板（用户报的就是这个）。
 * 半透明/取不到值一律算 0（不通过），宁可让闸门偏严。
 */
function contrastRatio(background: string | null, foreground: string | null): number {
  const bg = parseColor(background)
  const fg = parseColor(foreground)
  if (!bg || !fg || bg[3] < 1) return 0
  const a = relativeLuminance(background)
  const b = relativeLuminance(foreground)
  if (a === null || b === null) return 0
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

export async function runSmokeAudit(commandId: string, arg?: string): Promise<boolean> {
  const audit = AUDITS[commandId]
  if (!audit) return false
  const name = commandId.replace('smoke.assert', 'ASSERT_').toUpperCase()
  try {
    const result = await audit(arg)
    if (result === null) {
      await log('warn', name, '_SKIP', { reason: '当前界面没有这个审计的前提（如未打开对应类型的文档）' })
      return true
    }
    await log(result.ok ? 'info' : 'error', name, result.ok ? '_OK' : '_FAIL', result.detail)
  } catch (error) {
    await log('error', name, '_FAIL', { error: String(error) })
  }
  return true
}
