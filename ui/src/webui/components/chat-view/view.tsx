import { useEffect, useMemo, useRef } from 'react'
import { marked } from 'marked'
import { Egg, Loader2 } from 'lucide-react'
import { MessageBlock } from '../message-block'
import type { ChatState } from '../../../shared/reducer'
import type { Block } from '../../../shared/block'
import styles from './chat-view.module.css'

// 聊天视口：消息列表 + 流式 partial 块。自动滚动到底部。
interface ChatViewProps {
  chat: ChatState
  isRunning: boolean
}

type RenderedBlock = Block & { html?: string; fullHtml?: string }

export function ChatView({ chat, isRunning }: ChatViewProps) {
  const endRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat.blocks, chat.partial])

  const empty = chat.blocks.length === 0 && !chat.partial

  return (
    <main className={styles.chatView}>
      {empty ? (
        <div className={styles.welcome}>
          <div className={styles.welcomeMark}>
            <Egg size={32} strokeWidth={1.5} />
          </div>
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

          {isRunning && !chat.partial && (
            <div className={styles.streaming}>
              <div className={styles.assistantAvatar}>
                <Egg size={16} strokeWidth={1.5} />
              </div>
              <div className={styles.streamingDots}>
                <span className={styles.streamingDot} />
                <span className={styles.streamingDot} />
                <span className={styles.streamingDot} />
              </div>
              <span className={styles.streamingText}>DogEgg is thinking...</span>
            </div>
          )}

          <div ref={endRef} />
        </div>
      )}
    </main>
  )
}

// 流式 partial 块：avatar + 实时显示正在生成的文本。
function StreamingBlock({ kind, text, html }: { kind: 'assistant' | 'thinking'; text: string; html?: string }) {
  if (kind === 'thinking') {
    return (
      <div className={styles.streamingThinking}>
        <div className={styles.thinkingHeader}>
          <Loader2 size={12} strokeWidth={2} className="spin" />
          <span className={styles.thinkingLabel}>Thinking</span>
        </div>
        <div className={styles.thinkingBody}>
          <pre className={styles.monoText}>{text}</pre>
        </div>
      </div>
    )
  }
  return (
    <div className={styles.assistantRow}>
      <div className={styles.assistantAvatar}>
        <Egg size={16} strokeWidth={1.5} />
      </div>
      <div className={styles.assistantContent}>
        <span className={styles.roleLabel}>DogEgg</span>
        <div className={styles.assistantBody}>
          {html ? (
            <div className={styles.htmlContent + ' token-stream'} dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <pre className={styles.monoText + ' token-stream'}>{text}</pre>
          )}
        </div>
      </div>
    </div>
  )
}
