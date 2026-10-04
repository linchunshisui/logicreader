import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useUiStore } from '../../state/ui.store'
import { executeCommand } from '../../state/commands.store'
import { CMD } from '@logicreader/shared'

/** 工具条与选区边缘的间距 */
const GAP = 8

/**
 * 选区浮动工具条（规划书 §5.6.2）。
 *
 * 位置：**跟着选区走**（用户反馈：固定在视口底部会挡住"正好选在底部"的文字，
 * 想点工具条上的动作按钮时得先挪开视线再挪回来）。
 *  - 有选区位置（`selection.rect`）→ 摆在选区**上方**居中；贴近视口顶部放不下时改到**下方**；
 *  - 水平方向夹在视口内（长选区/边缘选区时居中会越界）；
 *  - 没有位置信息（表格单元格选区 / 旧路径）→ 退回视口底部居中（旧行为）。
 */
export function SelectionToolbar(): JSX.Element | null {
  const { t } = useTranslation()
  const selection = useUiStore((s) => s.selection)
  const toolbarRef = useRef<HTMLDivElement>(null)
  /** 首帧用"选区上方"的估算位置渲染，量到实际尺寸后在 layout effect 里夹紧 */
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const rect = selection?.rect
    const toolbar = toolbarRef.current
    if (!rect) {
      // 退回旧定位（CSS 里 bottom:18px 水平居中）
      setPosition(null)
      return
    }
    const viewportWidth = window.innerWidth
    const toolbarWidth = toolbar?.offsetWidth ?? 0
    const toolbarHeight = toolbar?.offsetHeight ?? 0
    const centerX = rect.x + rect.width / 2
    // 水平：按选区中心居中，夹在视口内（留 8px 边距）
    const left = Math.max(8, Math.min(centerX - toolbarWidth / 2, viewportWidth - toolbarWidth - 8))
    // 垂直：默认选区上方；顶上放不下（选区太靠上）→ 选区下方
    const above = rect.y - toolbarHeight - GAP
    const top = above >= 8 ? above : rect.y + rect.height + GAP
    setPosition({ left, top })
  }, [selection])

  if (!selection) return null

  const actions: { id: string; label: string; command?: string }[] = [
    { id: 'explain', label: t('reader.selectionToolbar.explain'), command: CMD.agentExplainSelection },
    { id: 'ask', label: t('reader.selectionToolbar.ask'), command: CMD.agentAskSelection },
    { id: 'translate', label: t('reader.selectionToolbar.translate'), command: CMD.agentTranslateSelection },
    { id: 'graph', label: t('reader.selectionToolbar.addToGraph'), command: CMD.agentAddSelectionToGraph },
    // 高亮已停用（产品决定：选中文字不需要再加色块）
    { id: 'citation', label: t('reader.selectionToolbar.copyCitation'), command: CMD.agentCopyCitation }
  ]

  return (
    <div
      ref={toolbarRef}
      className="lr-selection-toolbar"
      data-near-selection={position !== null}
      style={position ? { left: position.left, top: position.top, bottom: 'auto', transform: 'none' } : undefined}
    >
      {actions.map((action) => (
        <button
          key={action.id}
          className="lr-selection-toolbar__item"
          onMouseDown={(event) => {
            /**
             * 按下工具条会让正文选区塌掉（浏览器把点击当"取消选择"），
             * selectionchange 兜底随后把 selection 置 null、工具条先消失 —— click 就落空了。
             * 挡下默认行为，选区保留到 click 处理完。
             */
            event.preventDefault()
          }}
          onClick={() => action.command && void executeCommand(action.command)}
        >
          {action.label}
        </button>
      ))}
    </div>
  )
}
