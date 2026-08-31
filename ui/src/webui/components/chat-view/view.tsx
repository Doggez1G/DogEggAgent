import { useEffect, useMemo, useRef } from 'react'
import { marked } from 'marked'
import { MessageBlock } from '../message-block'
import { KIND_ICON, KIND_LABEL, TOKEN_CSS_VAR } from '../../theme/token-map'
import type { ChatState } from '../../../shared/reducer'
import type { Block } from '../../../shared/block'
import type { BlockKind, ColorToken } from '../../../shared/block'
// StreamingBlock 复用 message-block 的视觉结构（色条/头部/正文），避免样式重复。
import blockStyles from '../message-block/message-block.module.css'
import styles from './chat-view.module.css'

// 聊天视口：消息列表 + 流式 partial 块。自动滚动到底部。
// assistant/thinking 块的 text/full 在此组件用 marked 渲染为 HTML（useMemo 缓存，避免每次重渲染都重解析）。
interface ChatViewProps {
  chat: ChatState
  isRunning: boolean
}

// 渲染后的块：在原 Block 基础上附加 html/fullHtml（markdown → HTML）。
type RenderedBlock = Block & { html?: string; fullHtml?: string }

export function ChatView({ chat, isRunning }: ChatViewProps) {
  const endRef = useRef<HTMLDivElement>(null)

  // 把 text/full 预渲染为 HTML 并缓存——只在 chat.blocks 引用变化时重算。
  // thinking/assistant 才需要 markdown 渲染；其余 kind（user/tool/error...）直接走纯文本。
  const renderedBlocks = useMemo<RenderedBlock[]>(
    () =>
      chat.blocks.map((b) => ({
        ...b,
        html: b.kind === 'assistant' || b.kind === 'thinking' ? (marked.parse(b.text) as string) : undefined,
        fullHtml:
          b.full !== undefined && (b.kind === 'assistant' || b.kind === 'thinking')
            ? (marked.parse(b.full) as string)
            : undefined,
      })),
    [chat.blocks],
  )

  // 新消息或 partial 变化时自动滚动到底部。
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat.blocks, chat.partial])

  const empty = chat.blocks.length === 0 && !chat.partial

  return (
    <main className={styles.chatView}>
      {empty ? (
        <div className={styles.welcome}>
          <p className={styles.welcomeTitle}>DogEggAgent</p>
          <p className={styles.welcomeHint}>Type a message to start, or type / for commands.</p>
        </div>
      ) : (
        <div className={styles.messages}>
          {renderedBlocks.map((b, i) => (
            <MessageBlock
              key={i}
              kind={b.kind}
              color={b.color}
              text={b.text}
              full={b.full}
              html={b.html}
              fullHtml={b.fullHtml}
            />
          ))}

          {chat.partial && (
            <StreamingBlock
              kind={chat.partial.kind}
              text={chat.partial.text}
              html={marked.parse(chat.partial.text) as string}
            />
          )}

          {/* 运行中但尚无流式文本：显示思考脉冲点。 */}
          {isRunning && !chat.partial && (
            <div className={styles.thinkingDots}>
              <span className={styles.dot + ' pulse-dot'} />
              <span className={styles.dot + ' pulse-dot'} />
              <span className={styles.dot + ' pulse-dot'} />
            </div>
          )}

          <div ref={endRef} />
        </div>
      )}
    </main>
  )
}

// 流式 partial 块：实时显示正在生成的文本。
// 复用 message-block 的 CSS（色条 + 头部 + 正文），仅在此处决定 kind/color 映射并附加 token-stream 动画。
function StreamingBlock({ kind, text, html }: { kind: BlockKind; text: string; html?: string }) {
  const Icon = KIND_ICON[kind]!
  const label = KIND_LABEL[kind]!
  const color: ColorToken = kind === 'thinking' ? 'yellow' : 'text'
  const colorVar = TOKEN_CSS_VAR[color]!
  return (
    <div className={blockStyles.block + ' block-enter'}>
      <div className={blockStyles.bar} style={{ background: colorVar }} />
      <div className={blockStyles.content}>
        <div className={blockStyles.header}>
          <Icon size={14} strokeWidth={1.5} />
          <span className={blockStyles.label} style={{ color: colorVar }}>{label}</span>
        </div>
        <div className={blockStyles.body}>
          {html ? (
            <div
              className={blockStyles.htmlContent + ' token-stream'}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <pre className={blockStyles.text + ' token-stream'}>{text}</pre>
          )}
        </div>
      </div>
    </div>
  )
}
