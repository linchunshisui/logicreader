/** 轻量内联图标（24px 网格，stroke = currentColor），避免引入图标库。 */
interface IconProps {
  size?: number
  className?: string
}

function svg(path: JSX.Element, props: IconProps, viewBox = '0 0 24 24'): JSX.Element {
  const size = props.size ?? 20
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      aria-hidden="true"
    >
      {path}
    </svg>
  )
}

export const IconFiles = (p: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M4 4h9l3 3v13H4z" />
      <path d="M13 4v3h3" />
      <path d="M7 12h6M7 15h6" />
    </>,
    p
  )

export const IconOutline = (p: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M4 6h4M4 12h4M4 18h4" />
      <path d="M11 6h9M11 12h7M11 18h5" />
    </>,
    p
  )

export const IconGraph = (p: IconProps): JSX.Element =>
  svg(
    <>
      <circle cx="6" cy="7" r="2.4" />
      <circle cx="18" cy="7" r="2.4" />
      <circle cx="12" cy="17" r="2.4" />
      <path d="M8.2 8.2 10.6 15M15.8 8.2 13.4 15M8.4 7h7.2" />
    </>,
    p
  )

export const IconAgent = (p: IconProps): JSX.Element =>
  svg(
    <>
      <rect x="4" y="7" width="16" height="11" rx="2.5" />
      <path d="M12 4v3" />
      <circle cx="9.2" cy="12.4" r="1.1" />
      <circle cx="14.8" cy="12.4" r="1.1" />
      <path d="M9.6 15.4h4.8" />
    </>,
    p
  )

export const IconSearch = (p: IconProps): JSX.Element =>
  svg(
    <>
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="M15 15l4.5 4.5" />
    </>,
    p
  )

export const IconSettings = (p: IconProps): JSX.Element =>
  svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
    </>,
    p
  )

export const IconClose = (p: IconProps): JSX.Element => svg(<path d="M6 6l12 12M18 6L6 18" />, { size: 14, ...p })

export const IconChevronRight = (p: IconProps): JSX.Element => svg(<path d="M9 6l6 6-6 6" />, { size: 14, ...p })

export const IconChevronDown = (p: IconProps): JSX.Element => svg(<path d="M6 9l6 6 6-6" />, { size: 14, ...p })

export const IconPlus = (p: IconProps): JSX.Element => svg(<path d="M12 5v14M5 12h14" />, { size: 16, ...p })

export const IconRefresh = (p: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 5v6h-6" />
    </>,
    { size: 16, ...p }
  )

export const IconInfo = (p: IconProps): JSX.Element =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>,
    { size: 16, ...p }
  )

export const IconWarning = (p: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17h.01" />
    </>,
    { size: 16, ...p }
  )

export const IconError = (p: IconProps): JSX.Element =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>,
    { size: 16, ...p }
  )

export const IconCheck = (p: IconProps): JSX.Element => svg(<path d="M5 13l4.5 4.5L19 7" />, { size: 16, ...p })

export const IconFolderOpen = (p: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1" />
      <path d="M3 9h17l-2 9H5z" />
    </>,
    { size: 16, ...p }
  )

export const IconFile = (p: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
    </>,
    { size: 16, ...p }
  )

export const IconLogo = (p: IconProps): JSX.Element =>
  svg(
    <>
      <circle cx="6.5" cy="8" r="2.2" />
      <circle cx="17.5" cy="8" r="2.2" />
      <circle cx="12" cy="17" r="2.2" />
      <path d="M8.4 9.4 10.8 15M15.6 9.4 13.2 15M8.7 8h6.6" />
    </>,
    { size: 16, ...p }
  )

/* ------------------------------------------------------------ 阅读器工具栏
 *
 * 这些位置原先直接写字形（◀ ▶ − ＋ ⇔ ⤢ ⟳ U S ⤓ 🔬）：
 * 字形是字体渲染的，字体一换就变样，而且 ⇔ / ⤢ 这种"适应宽度 / 适应页面"
 * 靠字形根本分不出来。统一换成与活动栏同一套 24px 描边图标。
 */

export const IconChevronLeft = (p: IconProps): JSX.Element => svg(<path d="M15 6l-6 6 6 6" />, { size: 16, ...p })

export const IconArrowUp = (p: IconProps): JSX.Element => svg(<path d="M12 19V5M6 11l6-6 6 6" />, { size: 16, ...p })

export const IconArrowDown = (p: IconProps): JSX.Element => svg(<path d="M12 5v14M6 13l6 6 6-6" />, { size: 16, ...p })

export const IconZoomIn = (p: IconProps): JSX.Element =>
  svg(
    <>
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="M15 15l4.5 4.5M10.5 8v5M8 10.5h5" />
    </>,
    { size: 16, ...p }
  )

export const IconZoomOut = (p: IconProps): JSX.Element =>
  svg(
    <>
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="M15 15l4.5 4.5M8 10.5h5" />
    </>,
    { size: 16, ...p }
  )

/** 适应宽度：页宽贴着容器宽（左右两条竖线 + 中间的横向伸缩箭头） */
export const IconFitWidth = (p: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M4 5v14M20 5v14" />
      <path d="M8 12h8M10.5 9.5 8 12l2.5 2.5M13.5 9.5 16 12l-2.5 2.5" />
    </>,
    { size: 16, ...p }
  )

/** 适应页面：整页装进容器（四角括号 + 中间的点） */
export const IconFitPage = (p: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
      <circle cx="12" cy="12" r="1.6" />
    </>,
    { size: 16, ...p }
  )

export const IconRotate = (p: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <path d="M20 4v6h-6" />
    </>,
    { size: 16, ...p }
  )

/** 实际大小（100%）：一个 1:1 的框，不再随窗口伸缩 */
export const IconActualSize = (p: IconProps): JSX.Element =>
  svg(
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9.5 15V9.5L8 10.5M14 15v-4a1.5 1.5 0 0 1 1.5-1.5c1 0 1.5.6 1.5 1.5v4" />
    </>,
    { size: 16, ...p }
  )

export const IconUnderline = (p: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M7 5v6a5 5 0 0 0 10 0V5" />
      <path d="M5 19h14" />
    </>,
    { size: 16, ...p }
  )

export const IconStrike = (p: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M16.5 7.5A4.5 4.5 0 0 0 12.6 5h-.8a3.4 3.4 0 0 0-1.4 6.5" />
      <path d="M7.5 16.5A4.5 4.5 0 0 0 11.4 19h.8a3.4 3.4 0 0 0 1.4-6.5" />
      <path d="M4 12h16" />
    </>,
    { size: 16, ...p }
  )

export const IconExport = (p: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M12 4v10M8 10l4 4 4-4" />
      <path d="M5 18h14" />
    </>,
    { size: 16, ...p }
  )

export const IconRuler = (p: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M3 14.5 14.5 3 21 9.5 9.5 21z" />
      <path d="M7 11l2 2M10 8l2 2M13 5l2 2" />
    </>,
    { size: 16, ...p }
  )

export const IconMore = (p: IconProps): JSX.Element =>
  svg(
    <>
      <circle cx="6" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="18" cy="12" r="1.2" fill="currentColor" />
    </>,
    { size: 16, ...p }
  )

/** 缩略图：2×2 的页格 */
export const IconThumbnails = (p: IconProps): JSX.Element =>
  svg(
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.4" />
      <rect x="13" y="4" width="7" height="7" rx="1.4" />
      <rect x="4" y="13" width="7" height="7" rx="1.4" />
      <rect x="13" y="13" width="7" height="7" rx="1.4" />
    </>,
    { size: 16, ...p }
  )

/** 页内标注：一页 + 两道标记线 */
export const IconAnnotate = (p: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
      <path d="M9 13h6M9 17h4" />
    </>,
    { size: 16, ...p }
  )

/* ------------------------------------------------------------ Agent 面板
 *
 * 底部那排 chip 只有文字，辅助栏一窄就各自被截成 "Clau…" / "历…" / "思…"：
 * 图标 + 短标签才能既保住信息、又不抢宽度。
 */

export const IconStop = (p: IconProps): JSX.Element =>
  svg(<rect x="7" y="7" width="10" height="10" rx="1.6" fill="currentColor" stroke="none" />, { size: 14, ...p })

export const IconSend = (p: IconProps): JSX.Element => svg(<path d="M12 19V5M6 11l6-6 6 6" />, { size: 15, ...p })

export const IconHistory = (p: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path d="M3.5 4.5V10H9" />
      <path d="M12 8v4.4l3 1.8" />
    </>,
    { size: 14, ...p }
  )

export const IconModel = (p: IconProps): JSX.Element =>
  svg(
    <>
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
      <path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3" />
    </>,
    { size: 14, ...p }
  )

export const IconGauge = (p: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M4 17a8 8 0 1 1 16 0" />
      <path d="M12 17l4-5" />
    </>,
    { size: 14, ...p }
  )

export const IconShield = (p: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z" />
      <path d="M9.2 12.2l2 2 3.6-4" />
    </>,
    { size: 14, ...p }
  )
