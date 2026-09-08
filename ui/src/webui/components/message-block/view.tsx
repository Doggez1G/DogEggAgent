import { useState } from 'react'
import { KIND_ICON, KIND_LABEL } from '../../theme/token-map'
import { Egg, User, ChevronDown, Wrench, Check, X, Loader2, Copy } from 'lucide-react'
import { MarkdownRenderer } from '../markdown'
import { formatToolArgs, formatToolResult } from '../../../shared'
import type { Block, ToolBodyLine } from '../../../shared'
import styles from './message-block.module.css'

// 消息块：按 kind 分化渲染——每种类型有完全不同的视觉结构。
// user → 右对齐气泡；assistant → avatar + 正文；thinking → warning 卡片；tool → 状态卡片。
// markdown 渲染统一用 MarkdownRenderer（react-markdown 组件式，不走 dangerouslySetInnerHTML）。
// tool 块的信息全部来自结构化字段（shared/tool-display 负责文案），此处只做布局与着色。
interface MessageBlockProps {
  block: Block
  isRunning?: boolean
}

export function MessageBlock({ block, isRunning }: MessageBlockProps) {
  switch (block.kind) {
    case 'user':
      return <UserBlock text={block.text} />
    case 'assistant':
      return <AssistantBlock text={block.text} />
    case 'thinking':
      return <ThinkingBlock text={block.text} full={block.full} />
    case 'tool':
      return <ToolBlock block={block} isRunning={isRunning} />
    case 'error':
      return <ErrorBlock text={block.text} />
    default:
      return <NoticeBlock text={block.text} color={block.color} kind={block.kind} />
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

// ── 工具调用卡片：状态图标 + 工具名 + 人类可读参数 + 结果标签 + 可折叠详情 ──
// 详情 = tool-display 生成的逐行正文（add/del 着色）+ 行数提示 + 复制。
function ToolBlock({ block, isRunning }: { block: Block; isRunning?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const name = block.toolName ?? '工具'
  const args = formatToolArgs(name, block.toolInput)
  const running = block.toolStatus === undefined || block.toolStatus === 'running'
  const result = running ? null : formatToolResult(name, block.toolOutput, block.toolError)
  const expandable = block.toolBody !== undefined
  const body = block.toolBody ?? []
  // ✕ 前缀是 formatter 的失败标记（含 shell exit≠0 提升的情况）——驱动红色结果标签。
  const failed = block.toolStatus === 'error' || block.toolStatus === 'rejected' || result?.startsWith('✕') === true

  // 复制 = 展开正文 text 原样拼接——自动得到正确语义：shell 是去掉 exit 行的纯输出，
  // read/write 是不带行号的纯内容，edit 是自描述的 diff。一个规则覆盖所有工具。
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body.map((l) => l.text).join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // 剪贴板不可用（非安全上下文等）——静默失败，不影响主流程。
    }
  }

  const lineClass = (kind: ToolBodyLine['kind']) =>
    kind === 'add' ? styles.lineAdd : kind === 'del' ? styles.lineDel : kind === 'cmd' ? styles.lineCmd : styles.linePlain

  return (
    <div className={`${styles.toolCard} ${expanded ? '' : styles.collapsedCard}`}>
      <button className={styles.toolHeader} onClick={() => expandable && setExpanded(!expanded)}>
        <div className={`${styles.toolIcon} ${failed ? styles.toolIconError : block.toolStatus === 'done' ? styles.toolIconDone : styles.toolIconRunning}`}>
          {running
            ? (isRunning ? <Loader2 size={12} strokeWidth={2} className="spin" /> : <Wrench size={12} strokeWidth={1.5} />)
            : block.toolStatus === 'done' && !failed ? <Check size={12} strokeWidth={2} /> : <X size={12} strokeWidth={2} />}
        </div>
        <span className={styles.toolName}>{name}</span>
        <span className={styles.toolArgs}>{args}</span>
        {result && <span className={`${styles.toolResultTag} ${failed ? styles.toolResultBad : ''}`}>{result}</span>}
        {expandable && <ChevronDown size={12} strokeWidth={2} className={styles.chevron} />}
      </button>
      {expanded && expandable && (
        <div className={styles.toolBody}>
          <div className={styles.toolBodyBar}>
            <span className={styles.toolBodyHint}>{body.length} 行</span>
            <button className={styles.toolCopyBtn} onClick={copy}>
              <Copy size={10} strokeWidth={1.5} />
              {copied ? '已复制' : '复制'}
            </button>
          </div>
          <pre className={`${styles.monoText} ${styles.toolBodyScroll}`}>
            {body.map((l, i) => (
              <span key={i} className={lineClass(l.kind)}>
                {l.no !== undefined && <span className={styles.lineNo}>{l.no}{'  '}</span>}
                {l.text + '\n'}
              </span>
            ))}
          </pre>
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
function NoticeBlock({ text, color, kind }: { text: string; color: Block['color']; kind: Block['kind'] }) {
  const Icon = KIND_ICON[kind]!
  const label = KIND_LABEL[kind]!
  return (
    <div className={styles.noticeCard}>
      <Icon size={12} strokeWidth={1.5} className={styles.noticeIcon} />
      <span className={styles.noticeText}>{text}</span>
    </div>
  )
}
