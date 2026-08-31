import React from 'react'
import { Cpu, Gauge, Activity, Wrench, ChevronRight, ChevronLeft } from 'lucide-react'
import styles from './info-panel.module.css'

// 右侧信息面板：token 使用 + 状态 + 工具调用列表 + provider/model。
// 可收起（收起后宽度为 0，聊天区扩大）。
interface InfoPanelProps {
  provider: string | undefined
  model: string | undefined
  status: string
  tokens: number | undefined
  windowTokens: number | undefined
  // 最近的工具调用（由 App 从 tool_start/tool_end 消息收集）。
  toolCalls: { id: string; name: string; status: 'running' | 'done' | 'error'; output?: string }[]
  collapsed: boolean
  onToggleCollapse: () => void
}

const STATUS_LABELS: Record<string, string> = {
  idle: 'Ready',
  thinking: 'Thinking',
  responding: 'Responding',
  tool_calling: 'Calling Tool',
  waiting_permission: 'Awaiting Permission',
  executing: 'Executing',
  finished: 'Finished',
  cancelled: 'Cancelled',
  error: 'Error',
  compacting: 'Compacting',
}

export function InfoPanel({ provider, model, status, tokens, windowTokens, toolCalls, collapsed, onToggleCollapse }: InfoPanelProps) {
  if (collapsed) {
    return (
      <button className={styles.expandBtn} onClick={onToggleCollapse} aria-label="Show info panel">
        <ChevronLeft size={16} strokeWidth={1.5} />
      </button>
    )
  }

  const percent = tokens && windowTokens ? Math.round((tokens / windowTokens) * 100) : 0
  const statusLabel = STATUS_LABELS[status] ?? status

  return (
    <aside className={styles.infoPanel}>
      <header className={styles.header}>
        <span className={styles.headerTitle}>Info</span>
        <button className={styles.collapseBtn} onClick={onToggleCollapse} aria-label="Hide info panel">
          <ChevronRight size={14} strokeWidth={1.5} />
        </button>
      </header>

      {/* 状态 */}
      <section className={styles.section}>
        <div className={styles.sectionTitle}><Activity size={13} strokeWidth={1.5} /><span>Status</span></div>
        <div className={styles.statusRow}>
          <span className={styles.statusDot} data-status={status} />
          <span className={styles.statusText}>{statusLabel}</span>
        </div>
      </section>

      {/* 模型 */}
      <section className={styles.section}>
        <div className={styles.sectionTitle}><Cpu size={13} strokeWidth={1.5} /><span>Model</span></div>
        <div className={styles.modelRow}>
          <span className={styles.modelProvider}>{provider ?? '—'}</span>
          <span className={styles.modelName}>{model ?? '—'}</span>
        </div>
      </section>

      {/* Token 使用 */}
      <section className={styles.section}>
        <div className={styles.sectionTitle}><Gauge size={13} strokeWidth={1.5} /><span>Context</span></div>
        {tokens !== undefined && windowTokens !== undefined ? (
          <>
            <div className={styles.tokenBar}>
              <div className={styles.tokenFill} style={{ width: `${Math.min(100, percent)}%` }} data-overload={percent > 80} />
            </div>
            <div className={styles.tokenNumbers}>
              <span className={styles.tokenUsed}>{tokens.toLocaleString()}</span>
              <span className={styles.tokenSep}>/</span>
              <span className={styles.tokenWindow}>{windowTokens.toLocaleString()}</span>
              <span className={styles.tokenPercent} data-overload={percent > 80}>{percent}%</span>
            </div>
          </>
        ) : (
          <p className={styles.emptyText}>Not available</p>
        )}
      </section>

      {/* 工具调用 */}
      <section className={styles.section + ' ' + styles.toolSection}>
        <div className={styles.sectionTitle}><Wrench size={13} strokeWidth={1.5} /><span>Tools</span></div>
        {toolCalls.length === 0 ? (
          <p className={styles.emptyText}>No tool calls yet</p>
        ) : (
          <div className={styles.toolList}>
            {toolCalls.slice(-10).reverse().map((tc) => (
              <div key={tc.id} className={styles.toolItem} data-status={tc.status}>
                <span className={styles.toolIcon}>
                  {tc.status === 'running' && <span className={styles.spinner} />}
                  {tc.status === 'done' && '✓'}
                  {tc.status === 'error' && '✕'}
                </span>
                <div className={styles.toolInfo}>
                  <code className={styles.toolName}>{tc.name}</code>
                  {tc.output && <span className={styles.toolOutput}>{tc.output.slice(0, 60)}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </aside>
  )
}
