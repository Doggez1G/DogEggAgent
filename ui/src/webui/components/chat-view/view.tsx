import React, { useEffect, useRef } from 'react'
import { MessageBlock } from '../message-block'
import { KIND_ICON, KIND_LABEL, TOKEN_CSS_VAR } from '../../theme/token-map'
import type { Block } from '../../../shared/block'
import type { BlockKind, ColorToken } from '../../../shared/block'
import type { ChatState } from '../../../shared/reducer'
import styles from './chat-view.module.css'

// 聊天视口：消息列表 + 流式 partial 块。自动滚动到底部。
interface ChatViewProps {
  chat: ChatState
  isRunning: boolean
}

export function ChatView({ chat, isRunning }: ChatViewProps) {
  const endRef = useRef<HTMLDivElement>(null)

  // 新消息到达时自动滚动到底部。
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
          {chat.blocks.map((b: Block, i: number) => (
            <MessageBlock key={i} kind={b.kind} color={b.color} text={b.text} full={b.full} />
          ))}
          {chat.partial && (
            <StreamingBlock kind={chat.partial.kind === 'thinking' ? 'thinking' : 'assistant'} text={chat.partial.text} />
          )}
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
function StreamingBlock({ kind, text }: { kind: BlockKind; text: string }) {
  const Icon = KIND_ICON[kind]!
  const label = KIND_LABEL[kind]!
  const color = (kind === 'thinking' ? 'yellow' : 'text') as ColorToken
  const colorVar = TOKEN_CSS_VAR[color]
  return (
    <div className={styles.block + ' block-enter'}>
      <div className={styles.bar} style={{ background: colorVar }} />
      <div className={styles.content}>
        <div className={styles.header}>
          <Icon size={14} strokeWidth={1.5} />
          <span className={styles.label} style={{ color: colorVar }}>{label}</span>
        </div>
        <div className={styles.body}>
          <pre className={styles.text + ' token-stream'}>{text}</pre>
        </div>
      </div>
    </div>
  )
}
