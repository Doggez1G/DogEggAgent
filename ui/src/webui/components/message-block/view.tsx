import { useState } from 'react'
import { KIND_ICON, KIND_LABEL } from '../../theme/token-map'
import { Egg, User, ChevronDown, Wrench, Check, X, Loader2 } from 'lucide-react'
import { MarkdownRenderer } from '../markdown'
import type { BlockKind, ColorToken } from '../../../shared'
import { isExpandable } from '../../../shared'
import styles from './message-block.module.css'

// 消息块：按 kind 分化渲染——每种类型有完全不同的视觉结构。
// user → 右对齐气泡；assistant → avatar + 正文；thinking → warning 卡片；tool → 状态卡片。
// markdown 渲染统一用 MarkdownRenderer（react-markdown 组件式，不走 dangerouslySetInnerHTML）。
interface MessageBlockProps {
  kind: BlockKind
  color: ColorToken
  text: string
  full?: string
  isRunning?: boolean
}

export function MessageBlock({ kind, color, text, full, isRunning }: MessageBlockProps) {
  switch (kind) {
    case 'user':
      return <UserBlock text={text} />
    case 'assistant':
      return <AssistantBlock text={text} />
    case 'thinking':
      return <ThinkingBlock text={text} full={full} />
    case 'tool':
      return <ToolBlock text={text} full={full} isRunning={isRunning} />
    case 'error':
      return <ErrorBlock text={text} />
    default:
      return <NoticeBlock text={text} color={color} kind={kind} />
  }
}

// ── 用户消息：右对齐圆角气泡 ──
function UserBlock({ text }: { text: string }) {
  return (
    <div className={styles.userRow}>
      <div className={styles.userBubble}>{text}</div>
      <div className={styles.userAvatar}>
        <User size={14} strokeWidth={1.5} />
      </div>
    </div>
  )
}

// ── 助手消息：avatar + 角色标签 + markdown 正文 ──
function AssistantBlock({ text }: { text: string }) {
  return (
    <div className={styles.assistantRow}>
      <div className={styles.assistantAvatar}>
        <Egg size={16} strokeWidth={1.5} />
      </div>
      <div className={styles.assistantContent}>
        <span className={styles.roleLabel}>DogEgg</span>
        <div className={styles.assistantBody}>
          <MarkdownRenderer content={text} />
        </div>
      </div>
    </div>
  )
}

// ── 思考块：warning 色调卡片，可折叠 ──
function ThinkingBlock({ text, full }: { text: string; full?: string }) {
  const [expanded, setExpanded] = useState(false)
  const expandable = full !== undefined
  const showContent = expandable && expanded ? (full ?? text) : text
  return (
    <div className={`${styles.thinkingCard} ${expanded ? '' : styles.collapsedCard}`}>
      <button className={styles.thinkingHeader} onClick={() => expandable && setExpanded(!expanded)}>
        <ChevronDown size={12} strokeWidth={2} className={styles.chevron} />
        <span className={styles.thinkingLabel}>Thinking</span>
      </button>
      {expanded && (
        <div className={styles.thinkingBody}>
          <MarkdownRenderer content={showContent} />
        </div>
      )}
    </div>
  )
}

// ── 工具调用卡片：状态图标 + 工具名 + 参数 + 可折叠详情 ──
function ToolBlock({ text, full, isRunning }: { text: string; full?: string; isRunning?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const expandable = full !== undefined
  // 从 text 中提取工具名和参数（格式: "toolName {json}"）
  const firstSpace = text.indexOf(' ')
  const toolName = firstSpace > 0 ? text.slice(0, firstSpace) : text
  const toolArgs = firstSpace > 0 ? text.slice(firstSpace + 1) : ''
  const isDone = text.includes('✓')
  const isError = text.includes('✕')

  return (
    <div className={`${styles.toolCard} ${expanded ? '' : styles.collapsedCard}`}>
      <button className={styles.toolHeader} onClick={() => expandable && setExpanded(!expanded)}>
        <div className={`${styles.toolIcon} ${isError ? styles.toolIconError : isDone ? styles.toolIconDone : styles.toolIconRunning}`}>
          {isError ? <X size={12} strokeWidth={2} /> : isDone ? <Check size={12} strokeWidth={2} /> : isRunning ? <Loader2 size={12} strokeWidth={2} className="spin" /> : <Wrench size={12} strokeWidth={1.5} />}
        </div>
        <span className={styles.toolName}>{toolName}</span>
        <span className={styles.toolArgs}>{toolArgs.slice(0, 60)}</span>
        {expandable && <ChevronDown size={12} strokeWidth={2} className={styles.chevron} />}
      </button>
      {expanded && full && (
        <div className={styles.toolBody}>
          <pre className={styles.monoText}>{full}</pre>
        </div>
      )}
    </div>
  )
}

// ── 错误块 ──
function ErrorBlock({ text }: { text: string }) {
  return (
    <div className={styles.errorCard}>
      <div className={styles.errorIcon}><X size={14} strokeWidth={2} /></div>
      <span className={styles.errorText}>{text}</span>
    </div>
  )
}

// ── 通知/自动压缩等 ──
function NoticeBlock({ text, color, kind }: { text: string; color: ColorToken; kind: BlockKind }) {
  const Icon = KIND_ICON[kind]!
  const label = KIND_LABEL[kind]!
  return (
    <div className={styles.noticeCard}>
      <Icon size={12} strokeWidth={1.5} className={styles.noticeIcon} />
      <span className={styles.noticeText}>{text}</span>
    </div>
  )
}
