import React, { useEffect } from 'react'
import { Cpu, Gauge, Activity, Wrench, ChevronRight, ChevronLeft, Terminal, ScrollText, ShieldCheck } from 'lucide-react'
import type { UiPort } from '@dogegg/bridge'
import styles from './info-panel.module.css'

// 右侧信息面板：实时显示运行时信息。
// 状态 + 模型 + Token + 工具调用 + 可用工具 + System Prompt + 日志。
// 挂载时请求数据，运行中定时刷新 token。
interface InfoPanelProps {
  provider: string | undefined
  model: string | undefined
  status: string
  tokens: number | undefined
  windowTokens: number | undefined
  toolCalls: { id: string; name: string; status: 'running' | 'done' | 'error'; output?: string }[]
  toolsList: { name: string; description: string }[]
  contextState: { estimatedTokens: number; windowTokens: number; percent: number } | null
  systemState: { path: string; content: string } | null
  logState: { path: string; tail: string } | null
  collapsed: boolean
  onToggleCollapse: () => void
  port: UiPort
}

const STATUS_LABELS: Record<string, string> = {
  idle: 'Ready', thinking: 'Thinking', responding: 'Responding',
  tool_calling: 'Calling Tool', waiting_permission: 'Awaiting Permission',
  executing: 'Executing', finished: 'Finished', cancelled: 'Cancelled',
  error: 'Error', compacting: 'Compacting',
}

export function InfoPanel(props: InfoPanelProps) {
  const { collapsed, port, status } = props

  // 挂载时请求工具/system/log/context。
  useEffect(() => {
    if (!collapsed) {
      port.post({ type: 'tools_request' })
      port.post({ type: 'system_request' })
      port.post({ type: 'log_request' })
      port.post({ type: 'context_request' })
    }
  }, [collapsed, port])

  // 运行中定时刷新 context（token 实时更新）。
  useEffect(() => {
    if (collapsed) return
    const isRunning = status !== 'idle' && status !== 'finished' && status !== 'cancelled' && status !== 'error'
    if (!isRunning) return
    const timer = setInterval(() => port.post({ type: 'context_request' }), 3000)
    return () => clearInterval(timer)
  }, [collapsed, port, status])

  if (collapsed) {
    return (
      <button className={styles.expandBtn} onClick={props.onToggleCollapse} aria-label="Show info panel">
        <ChevronLeft size={16} strokeWidth={1.5} />
      </button>
    )
  }

  const statusLabel = STATUS_LABELS[status] ?? status
  // 用 contextState 的 percent 优先（更准确），fallback 到 tokens/windowTokens。
  const tokens = props.contextState?.estimatedTokens ?? props.tokens
  const windowTokens = props.contextState?.windowTokens ?? props.windowTokens
  const percent = props.contextState?.percent ?? (tokens && windowTokens ? Math.round((tokens / windowTokens) * 100) : 0)

  return (
    <aside className={styles.infoPanel}>
      <header className={styles.header}>
        <span className={styles.headerTitle}>Info</span>
        <button className={styles.collapseBtn} onClick={props.onToggleCollapse} aria-label="Hide info panel">
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
          <span className={styles.modelProvider}>{props.provider ?? '—'}</span>
          <span className={styles.modelName}>{props.model ?? '—'}</span>
        </div>
      </section>

      {/* Token */}
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
        ) : <p className={styles.emptyText}>Not available</p>}
      </section>

      {/* 工具调用 */}
      <section className={styles.section + ' ' + styles.toolSection}>
        <div className={styles.sectionTitle}><Wrench size={13} strokeWidth={1.5} /><span>Tool Calls</span></div>
        {props.toolCalls.length === 0 ? (
          <p className={styles.emptyText}>No tool calls yet</p>
        ) : (
          <div className={styles.toolList}>
            {props.toolCalls.slice(-8).reverse().map((tc) => (
              <div key={tc.id} className={styles.toolItem} data-status={tc.status}>
                <span className={styles.toolIcon}>
                  {tc.status === 'running' && <span className={styles.spinner} />}
                  {tc.status === 'done' && '✓'}
                  {tc.status === 'error' && '✕'}
                </span>
                <div className={styles.toolInfo}>
                  <code className={styles.toolName}>{tc.name}</code>
                  {tc.output && <span className={styles.toolOutput}>{tc.output.slice(0, 50)}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 可用工具 */}
      <section className={styles.section}>
        <div className={styles.sectionTitle}><Wrench size={13} strokeWidth={1.5} /><span>Available Tools</span></div>
        {props.toolsList.length === 0 ? <p className={styles.emptyText}>Loading...</p> : (
          <div className={styles.miniList}>
            {props.toolsList.map(t => <div key={t.name} className={styles.miniItem}><code className={styles.miniName}>{t.name}</code></div>)}
          </div>
        )}
      </section>

      {/* System Prompt */}
      <section className={styles.section}>
        <div className={styles.sectionTitle}><Terminal size={13} strokeWidth={1.5} /><span>System Prompt</span></div>
        {props.systemState ? (
          <div className={styles.miniContent}>
            <span className={styles.miniPath}>{props.systemState.path}</span>
            <pre className={styles.miniPre}>{props.systemState.content.slice(0, 200)}</pre>
          </div>
        ) : <p className={styles.emptyText}>Loading...</p>}
      </section>

      {/* 日志 */}
      <section className={styles.section}>
        <div className={styles.sectionTitle}><ScrollText size={13} strokeWidth={1.5} /><span>Log Tail</span></div>
        {props.logState ? (
          <pre className={styles.miniPre}>{props.logState.tail.slice(0, 500)}</pre>
        ) : <p className={styles.emptyText}>Loading...</p>}
      </section>
    </aside>
  )
}
