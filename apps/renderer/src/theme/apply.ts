import { GRAPH_TOKENS, READER_TOKENS, type ResolvedTheme } from '@logicreader/shared'

/** 把主题令牌写到 :root，供阅读器与关系图使用（规划书 §6.5）。 */
export function applyTheme(theme: ResolvedTheme, readerTheme: ResolvedTheme): void {
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.setAttribute('data-reader-theme', readerTheme)

  const tokens: Record<string, string> = {
    ...READER_TOKENS[readerTheme],
    ...GRAPH_TOKENS[theme]
  }
  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(key, value)
  }
}
