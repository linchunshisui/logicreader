import { useState } from 'react'

/** 各阅读器共用的缩放范围 */
export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 8

export function clampZoom(value: number, min = ZOOM_MIN, max = ZOOM_MAX): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(max, Math.max(min, value))
}

/**
 * 解析用户输入的倍率。
 * 支持 "250"、"250%"（百分数）与 "2.5"（含小数点按比例解释，等价 250%）。
 */
export function parseZoomInput(raw: string): number | null {
  const text = raw.trim().replace(/%$/, '')
  if (text.length === 0) return null
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0) return null
  return text.includes('.') ? value : value / 100
}

/**
 * 可手动输入倍率的缩放控件。
 * 回车或失焦生效，Esc 取消；输入非法时原样回退，不会改变当前缩放。
 */
export function ZoomInput(props: {
  scale: number
  onCommit: (scale: number) => void
  min?: number
  max?: number
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const display = draft ?? String(Math.round(props.scale * 100))
  const commit = (): void => {
    if (draft === null) return
    const parsed = parseZoomInput(draft)
    if (parsed !== null) props.onCommit(clampZoom(parsed, props.min, props.max))
    setDraft(null)
  }
  return (
    <span className="lr-zoom-input">
      <input
        className="lr-zoom-input__field"
        value={display}
        inputMode="decimal"
        aria-label="缩放倍率"
        title="缩放倍率（可直接输入，回车生效）"
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
            event.currentTarget.blur()
          } else if (event.key === 'Escape') {
            setDraft(null)
            event.currentTarget.blur()
          }
        }}
        onBlur={commit}
      />
      <span className="lr-zoom-input__suffix">%</span>
    </span>
  )
}
