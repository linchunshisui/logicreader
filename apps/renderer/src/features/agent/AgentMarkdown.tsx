import { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { CodeBlock } from '../../views/reader/markdown/CodeBlock'
import { api } from '../../lib/api'

interface HastNode {
  properties?: { className?: string[] }
  children?: { value?: string; children?: { value?: string }[]; properties?: { className?: string[] } }[]
}

/**
 * Agent 输出的 **markdown 渲染**（对话正文与计划卡片共用）。
 *
 * 为什么必须渲染：模型回的就是 markdown —— 原样显示时用户看到的是 `**加粗**`、`### 标题`、
 * `| 表头 |`、`---` 这些**源码**（截图里那张"计划待批准"就是这样：表格与层级全读不出来）。
 *
 * 与阅读器同一套插件（remark-gfm + rehype-katex，公式与表格都认），
 * 代码块同样懒加载 Shiki。两条纪律：
 *  1. **不启用任何 HTML 直通**（react-markdown 默认如此）：内容来自模型，绝不当作 HTML 执行；
 *  2. 链接一律交给系统浏览器打开，不在应用窗口里导航。
 */
export function AgentMarkdown({ text }: { text: string }): JSX.Element {
  const components = useMemo(
    () => ({
      /** 代码块：把 hast 里的 `code` 取出来交给 Shiki（与 MarkdownReaderView 同一套做法） */
      pre: ({ node }: { node?: HastNode }) => {
        const codeNode = node?.children?.[0]
        const code = (codeNode?.children ?? []).map((child) => child.value ?? '').join('')
        const classes = (codeNode?.properties?.className ?? []) as string[]
        const lang = classes.find((value) => value.startsWith('language-'))?.replace('language-', '')
        return <CodeBlock code={code} lang={lang} />
      },
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
        <a
          href={href}
          title={href}
          onClick={(event) => {
            event.preventDefault()
            if (href && /^https?:|^mailto:/.test(href)) void api.app.openExternal(href)
          }}
        >
          {children}
        </a>
      )
    }),
    []
  )

  return (
    <div className="lr-md lr-prose--markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeKatex]} components={components as never}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
