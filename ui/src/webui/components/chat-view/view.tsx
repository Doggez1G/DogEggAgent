import { useEffect, useRef } from 'react'
import { Egg, Loader2, Wrench } from 'lucide-react'
import { MessageBlock } from '../message-block'
import { MarkdownRenderer } from '../markdown'
import { type Block, type ChatState, pendingToolLabel, STATUS_LABELS } from '../../../shared'
import styles from './chat-view.module.css'

// 聊天视口：消息列表 + 流式 partial 块 + 工具参数生成提示。自动滚动到底部。
interface ChatViewProps {
  chat: ChatState
  isRunning: boolean
}

export function ChatView({ chat, isRunning }: ChatViewProps) {
  // 滚动容器（.chatView 的 overflow-y:auto）+ 贴底标记：onScroll 时记录用户是否贴底
  //（距底 < 80px 视为贴底）。上滚阅读历史 → 暂停自动滚动；滚回底部 → 自动恢复。
  const viewRef = useRef<HTMLElement>(null)
  const stickToBottomRef = useRef(true)
  const endRef = useRef<HTMLDivElement>(null)

  const handleScroll = () => {
    const el = viewRef.current
    if (!el) return
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  useEffect(() => {
    // 仅贴底时才自动滚动——无条件 scrollIntoView 会持续抢走阅读位置，导致无法上滚看历史。
    if (stickToBottomRef.current) endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat.blocks, chat.partial, chat.pendingTool])

  const empty = chat.blocks.length === 0 && !chat.partial && chat.pendingTool == null

  return (
    <main ref={viewRef} onScroll={handleScroll} className={styles.chatView}>
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
          {/* P2-31 立法：key 用 Block.id（reducer 注入的稳定序号，ui/src/shared/block.ts）而非下标——
              session_ready 恢复/切换会话时 blocks 被整体替换，下标 key 会让 React 复用同位置的
              组件实例，把旧块（旧会话）的本地展开态（thinking/tool 卡折叠）错位到新块上。
              保留 `?? i` 兜底：Block.id 是可选字段，reducer 生产端并行实现中——未注入 id 的
              旧状态（历史广播/本地 local_user 块）仍需可渲染，此时退化为原下标行为。 */}
          {chat.blocks.map((b, i) => (
            <MessageBlock key={b.id ?? i} block={b} isRunning={isRunning} />
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

          {/* 运行中兜底指示行：partial 已冻结落盘、无 pendingTool、非压缩时的空窗期。
              文案必须按真实状态显示（思考中/回复中/正在执行工具/等待审批…）——
              此前无脑写「DogEgg is thinking...」，工具执行期间也显示思考中，
              用户无法区分真思考与工具调用（2026-09-24 运行中状态显示正确性立法）。
              pendingTool 与 compacting 各有专属指示行，不在本行职责内。 */}
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
              <span className={styles.streamingText}>{STATUS_LABELS[chat.status] ?? '处理中'}…</span>
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
