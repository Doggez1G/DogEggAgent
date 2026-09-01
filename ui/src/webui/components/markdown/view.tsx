import { memo, useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy } from 'lucide-react'
import styles from './markdown.module.css'

// Markdown 渲染器：react-markdown + rehype-highlight，组件式渲染（不走 dangerouslySetInnerHTML）。
// 替代旧的 marked.parse + dangerouslySetInnerHTML 方案，消除 XSS 风险。
// 代码块自带 hover 复制按钮 + highlight.js 语法高亮。
interface MarkdownRendererProps {
  content: string
  className?: string
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <div className={`${styles.markdown} ${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={[]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre: CodeBlock,
          code: InlineCode,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})

// 代码块：包裹 pre，hover 时右上角显示复制按钮。
function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    const text = extractText(children)
    if (text) {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }).catch(() => {})
    }
  }, [children])

  return (
    <div className={styles.codeBlockWrap}>
      <button className={styles.copyBtn} onClick={handleCopy} aria-label="Copy code" title="Copy">
        {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.5} />}
      </button>
      <pre>{children}</pre>
    </div>
  )
}

// 行内 code：不包复制按钮。
function InlineCode({ children }: { children?: React.ReactNode }) {
  return <code>{children}</code>
}

// 从 React 渲染的 code 元素子节点中提取纯文本。
function extractText(node: React.ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return extractText((node as { props: { children?: React.ReactNode } }).props.children)
  }
  return ''
}
