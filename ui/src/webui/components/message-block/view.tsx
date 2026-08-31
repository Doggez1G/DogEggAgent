import { useState } from 'react'
import { KIND_ICON, TOKEN_CSS_VAR, KIND_LABEL } from '../../theme/token-map'
import type { BlockKind, ColorToken } from '../../../shared/block'
import { isExpandable } from '../../../shared/block'
import styles from './message-block.module.css'

// 消息块：色条 + Lucide 图标 + 标签 + 正文。
// 可折叠块（thinking/tool）点击展开/折叠——折叠显示摘要，展开显示 full。
// 工具运行中：色条脉冲动画替代 spinner。
// assistant/thinking 块的 text/full 已由 ChatView 渲染为 HTML（markdown），通过 html/fullHtml prop 传入。
interface MessageBlockProps {
  kind: BlockKind
  color: ColorToken
  text: string
  full?: string
  html?: string
  fullHtml?: string
  isRunning?: boolean
}

export function MessageBlock({ kind, color, text, full, html, fullHtml, isRunning }: MessageBlockProps) {
  const [expanded, setExpanded] = useState(false)
  const Icon = KIND_ICON[kind]!
  const label = KIND_LABEL[kind]!
  const colorVar = TOKEN_CSS_VAR[color]!
  const expandable = isExpandable({ kind, color, text, full })

  // 展开时优先用 fullHtml，否则 fallback 到 full 纯文本。
  // 折叠时优先用 html，否则 fallback 到 text 纯文本。
  const showHtml = expandable && expanded ? fullHtml : html
  const showText = expandable && expanded ? (full ?? text) : text

  return (
    <div className={styles.block + ' block-enter'}>
      <div
        className={`${styles.bar}${isRunning ? ' ' + styles.pulseBar + ' pulse-bar' : ''}`}
        style={{ background: colorVar }}
      />
      <div className={styles.content}>
        <div className={styles.header}>
          <Icon size={14} strokeWidth={1.5} />
          <span className={styles.label} style={{ color: colorVar }}>{label}</span>
          {expandable && (
            <button
              className={styles.toggleBtn}
              onClick={() => setExpanded(!expanded)}
              aria-label={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? '−' : '+'}
            </button>
          )}
        </div>
        <div className={styles.body}>
          {showHtml ? (
            <div className={styles.htmlContent} dangerouslySetInnerHTML={{ __html: showHtml }} />
          ) : (
            <pre className={styles.text}>{showText}</pre>
          )}
        </div>
      </div>
    </div>
  )
}
