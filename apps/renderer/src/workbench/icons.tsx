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

export const IconAnnotations = (p: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M5 5h9l5 5v9H5z" />
      <path d="M14 5v5h5" />
      <path d="M8 14h6" />
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
