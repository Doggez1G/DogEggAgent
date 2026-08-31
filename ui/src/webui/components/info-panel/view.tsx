import { useEffect, useRef } from 'react'
import { Cpu, Gauge, Activity, Wrench, ChevronRight, ChevronLeft, Terminal, ScrollText, FileEdit, FilePlus } from 'lucide-react'
import type { UiPort } from '@dogegg/bridge'
import { Section, Badge } from '../primitives'
import styles from './info-panel.module.css'

// 右侧信息面板：实时显示运行时信息。
// 折叠分区由 primitives 的 Section 提供；面板自身只渲染内容。
// 数据请求按需触发：首次展开时只请求一次 tools/system/log/context，运行中 context 每 3s 刷新。
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
  filesTouched: { path: string; action: 'edit' | 'write'; toolName: string; time: number }[]
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

const basename = (p: string): string => p.split(/[/\\]/).pop() ?? p

export function InfoPanel(props: InfoPanelProps) {
  const { collapsed, port, status } = props
  const requested = useRef<Set<string>>(new Set())

  // 首次展开时请求 tools/system/log/context（各只请求一次）。
  useEffect(() => {
    if (collapsed) return
    const req = requested.current
    if (!req.has('tools')) { req.add('tools'); port.post({ type: 'tools_request' }) }
    if (!req.has('system')) { req.add('system'); port.post({ type: 'system_request' }) }
    if (!req.has('log')) { req.add('log'); port.post({ type: 'log_request' }) }
    if (!req.has('context')) { req.add('context'); port.post({ type: 'context_request' }) }
  }, [collapsed, port])

  // 运行中 context 每 3s 刷新一次。
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
  const overload = percent > 80
  const files = [...props.filesTouched].sort((a, b) => b.time - a.time)

  return (
    <aside className={styles.infoPanel}>
      <header className={styles.header}>
        <span className={styles.headerTitle}>Info</span>
        <button className={styles.collapseBtn} onClick={props.onToggleCollapse} aria-label="Hide info panel">
          <ChevronRight size={14} strokeWidth={1.5} />
        </button>
      </header>

      <div className={styles.scrollArea}>
        <Section title="Status" icon={Activity}>
          <div className={styles.statusRow}>
            <span className={styles.statusDot} data-status={status} />
            <span className={styles.statusText}>{statusLabel}</span>
          </div>
        </Section>

        <Section title="Model" icon={Cpu}>
          <div className={styles.modelRow}>
            <span className={styles.modelProvider}>{props.provider ?? '—'}</span>
            <span className={styles.modelName}>{props.model ?? '—'}</span>
          </div>
        </Section>

        <Section title="Context" icon={Gauge}>
          {tokens !== undefined && windowTokens !== undefined ? (
            <>
              <div className={styles.tokenBar}>
                <div className={styles.tokenFill} style={{ width: `${Math.min(100, percent)}%` }} data-overload={overload} />
              </div>
              <div className={styles.tokenNumbers}>
                <span className={styles.tokenUsed}>{tokens.toLocaleString()}</span>
                <span className={styles.tokenSep}>/</span>
                <span className={styles.tokenWindow}>{windowTokens.toLocaleString()}</span>
                <span className={styles.tokenPercent} data-overload={overload}>{percent}%</span>
              </div>
            </>
          ) : <p className={styles.emptyText}>Not available</p>}
        </Section>

        <Section title="Tool Calls" icon={Wrench} defaultOpen={false}>
          {props.toolCalls.length === 0 ? (
            <p className={styles.emptyText}>No tool calls yet</p>
          ) : (
            <div className={styles.toolList}>
              {props.toolCalls.slice(-8).reverse().map((tc) => (
                <div key={tc.id} className={styles.toolItem} data-status={tc.status}>
                  <span className={`${styles.toolIcon} ${tc.status === 'running' ? 'spin' : ''}`}>
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
        </Section>

        <Section title="Files Touched" icon={FileEdit} defaultOpen={false}>
          {files.length === 0 ? (
            <p className={styles.emptyText}>No files touched</p>
          ) : (
            <div className={styles.toolList}>
              {files.map((f) => (
                <div key={`${f.path}-${f.time}`} className={styles.fileItem}>
                  <span className={styles.fileIcon}>
                    {f.action === 'edit' ? <FileEdit size={12} strokeWidth={1.5} /> : <FilePlus size={12} strokeWidth={1.5} />}
                  </span>
                  <span className={styles.fileName}>{basename(f.path)}</span>
                  <span className={styles.fileBadge}>
                    <Badge variant={f.action === 'edit' ? 'warning' : 'success'}>{f.action}</Badge>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Available Tools" icon={Wrench} defaultOpen={false}>
          {props.toolsList.length === 0 ? (
            <p className={styles.emptyText}>Loading...</p>
          ) : (
            <div className={styles.miniList}>
              {props.toolsList.map((t) => (
                <div key={t.name} className={styles.miniItem}><code className={styles.miniName}>{t.name}</code></div>
              ))}
            </div>
          )}
        </Section>

        <Section title="System Prompt" icon={Terminal} defaultOpen={false}>
          {props.systemState ? (
            <div className={styles.miniContent}>
              <span className={styles.miniPath}>{props.systemState.path}</span>
              <pre className={styles.miniPre}>{props.systemState.content.slice(0, 200)}</pre>
            </div>
          ) : <p className={styles.emptyText}>Loading...</p>}
        </Section>

        <Section title="Log Tail" icon={ScrollText} defaultOpen={false}>
          {props.logState ? (
            <pre className={styles.miniPre}>{props.logState.tail.slice(0, 500)}</pre>
          ) : <p className={styles.emptyText}>Loading...</p>}
        </Section>
      </div>
    </aside>
  )
}
