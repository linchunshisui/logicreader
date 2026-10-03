import { useEffect, useState } from 'react'

/**
 * 代码块高亮：Shiki 体积较大，按需懒加载，只有真正出现代码块时才引入。
 */
export function CodeBlock({ code, lang }: { code: string; lang?: string }): JSX.Element {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const shiki = await import('shiki')
        const highlighter = await shiki.createHighlighter({
          themes: ['github-dark', 'github-light'],
          langs: [lang && lang.length > 0 ? lang : 'text', 'plaintext']
        })
        const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'github-light' : 'github-dark'
        const language = lang && highlighter.getLoadedLanguages().includes(lang) ? lang : 'text'
        const out = highlighter.codeToHtml(code, { lang: language, theme })
        if (!cancelled) setHtml(out)
      } catch {
        if (!cancelled) setHtml(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, lang])

  if (!html) {
    return (
      <pre className="lr-prose__code">
        <code>{code}</code>
      </pre>
    )
  }
  return <div className="lr-prose__code-shiki" dangerouslySetInnerHTML={{ __html: html }} />
}
