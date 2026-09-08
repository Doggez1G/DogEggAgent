import { useEffect, useRef } from 'react'
import { Egg, Loader2, Wrench } from 'lucide-react'
import { MessageBlock } from '../message-block'
import { MarkdownRenderer } from '../markdown'
import { type Block, type ChatState, pendingToolLabel } from '../../../shared'
import styles from './chat-view.module.css'

// 聊天视口：消息列表 + 流式 partial 块 + 工具参数生成提示。自动滚动到底部。
interface ChatViewProps {
  chat: ChatState
  isRunning: boolean
}

export function ChatView({ chat, isRunning }: ChatViewProps) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat.blocks, chat.partial, chat.pendingTool])

  const empty = chat.blocks.length === 0 && !chat.partial && chat.pendingTool == null

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
          {chat.blocks.map((b, i) => (
            <MessageBlock key={i} block={b} isRunning={isRunning} />
          ))}

          {chat.partial && (
            <StreamingBlock
              kind={chat.partial.kind}
              text={chat.partial.text}
            />
          )}

          {/* 模型正在生成工具调用参数——流式文本冻结、工具块未出现的空窗期提示 */}
          {chat.pendingTool != null && (
            <div className={styles.streaming}>
              <div className={styles.assistantAvatar}>
                <Wrench size={16} strokeWidth={1.5} />
              </div>
              <div className={styles.streamingDots}>
                <span className={styles.streamingDot} />
                <span className={styles.streamingDot} />
                <span className={styles.streamingDot} />
              </div>
              <span className={styles.streamingText}>{pendingToolLabel(chat.pendingTool)}</span>
            </div>
          )}

          {chat.status === 'compacting' && (
            <div className={styles.compacting}>
              <div className={styles.assistantAvatar}>
                <Egg size={16} strokeWidth={1.5} />
              </div>
              <div className={styles.streamingDots}>
                <span className={styles.streamingDot} />
                <span className={styles.streamingDot} />
                <span className={styles.streamingDot} />
              </div>
              <span className={styles.streamingText}>Compacting context...</span>
            </div>
          )}

          {isRunning && !chat.partial && chat.status !== 'compacting' && chat.pendingTool == null && (
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
function StreamingBlock({ kind, text }: { kind: 'assistant' | 'thinking'; text: string }) {
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
          {text ? (
            <MarkdownRenderer content={text} className="token-stream" />
          ) : (
            <pre className={styles.monoText + ' token-stream'}></pre>
          )}
        </div>
      </div>
    </div>
  )
}
