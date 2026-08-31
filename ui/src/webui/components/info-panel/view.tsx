import React, { useEffect, useState } from 'react'
import { Cpu, Gauge, Activity, Wrench, ChevronRight, ChevronLeft, ChevronDown, Terminal, ScrollText } from 'lucide-react'
import type { UiPort } from '@dogegg/bridge'
import styles from './info-panel.module.css'

// 右侧信息面板：实时显示运行时信息。
// 每个 section 可折叠/展开。面板整体可滚动。
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

// 可折叠的 section 组件。
function CollapsibleSection({ title, icon: Icon, defaultOpen = true, children }: { title: string; icon: typeof Activity; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={styles.section}>
      <button className={styles.sectionToggle} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} strokeWidth={2} /> : <ChevronRight size={13} strokeWidth={2} />}
        <Icon size={13} strokeWidth={1.5} />
        <span>{title}</span>
      </button>
      {open && <div className={styles.sectionBody}>{children}</div>}
    </section>
  )
}

export function InfoPanel(props: InfoPanelProps) {
  const { collapsed, port, status } = props

  useEffect(() => {
    if (!collapsed) {
      port.post({ type: 'tools_request' })
      port.post({ type: 'system_request' })
      port.post({ type: 'log_request' })
      port.post({ type: 'context_request' })
    }
  }, [collapsed, port])

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

      <div className={styles.scrollArea}>
        {/* 状态 + 模型（始终展开） */}
        <CollapsibleSection title="Status" icon={Activity}>
          <div className={styles.statusRow}>
            <span className={styles.statusDot} data-status={status} />
            <span className={styles.statusText}>{statusLabel}</span>
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Model" icon={Cpu}>
          <div className={styles.modelRow}>
            <span className={styles.modelProvider}>{props.provider ?? '—'}</span>
            <span className={styles.modelName}>{props.model ?? '—'}</span>
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Context" icon={Gauge}>
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
        </CollapsibleSection>

        <CollapsibleSection title="Tool Calls" icon={Wrench} defaultOpen={false}>
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
        </CollapsibleSection>

        <CollapsibleSection title="Available Tools" icon={Wrench} defaultOpen={false}>
          {props.toolsList.length === 0 ? <p className={styles.emptyText}>Loading...</p> : (
            <div className={styles.miniList}>
              {props.toolsList.map(t => <div key={t.name} className={styles.miniItem}><code className={styles.miniName}>{t.name}</code></div>)}
            </div>
          )}
        </CollapsibleSection>

        <CollapsibleSection title="System Prompt" icon={Terminal} defaultOpen={false}>
          {props.systemState ? (
            <div className={styles.miniContent}>
              <span className={styles.miniPath}>{props.systemState.path}</span>
              <pre className={styles.miniPre}>{props.systemState.content.slice(0, 200)}</pre>
            </div>
          ) : <p className={styles.emptyText}>Loading...</p>}
        </CollapsibleSection>

        <CollapsibleSection title="Log Tail" icon={ScrollText} defaultOpen={false}>
          {props.logState ? (
            <pre className={styles.miniPre}>{props.logState.tail.slice(0, 500)}</pre>
          ) : <p className={styles.emptyText}>Loading...</p>}
        </CollapsibleSection>
      </div>
    </aside>
  )
}
