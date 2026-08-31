import { useEffect, useRef, useState } from 'react'
import { Cpu, Gauge, Activity, Wrench, ChevronRight, ChevronLeft, ChevronDown, Terminal, ScrollText, FileEdit, FilePlus, ShieldCheck, X } from 'lucide-react'
import type { Config, UiPort } from '@dogegg/bridge'
import { Badge } from '../primitives'
import styles from './info-panel.module.css'

// 右侧信息面板：卡片式可折叠 section + 状态 pill + 渐变进度条。
interface InfoPanelProps {
  sessionId: string
  provider: string | undefined
  model: string | undefined
  status: string
  tokens: number | undefined
  windowTokens: number | undefined
  toolCalls: { id: string; name: string; status: 'running' | 'done' | 'error' | 'rejected'; output?: string; decision?: 'allow_once' | 'allow_always' | 'reject'; configPerm: string; seq: number }[]
  toolsList: { name: string; description: string }[]
  contextState: { estimatedTokens: number; windowTokens: number; percent: number } | null
  systemState: { path: string; content: string } | null
  logState: { path: string; tail: string } | null
  filesTouched: { path: string; action: 'edit' | 'write'; toolName: string; time: number }[]
  permissionsList: string[]
  config: Config | null
  highlightSection: string | null
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

// 获取工具的权限标签——从 config.permission 的 allow/reject/ask 桶判断。
// 不受 session allow_always 影响——只有设置中的配置才显示。
function getToolPermission(toolName: string, config: Config | null): string {
  if (!config) return 'ask'
  if (config.permission.reject.includes(toolName)) return 'reject'
  if (config.permission.allow.includes(toolName)) return 'allow'
  return 'ask'
}

export function InfoPanel(props: InfoPanelProps) {
  const { collapsed, port, status, sessionId } = props
  const requested = useRef<Set<string>>(new Set())

  // 会话切换时清除请求缓存——新会话需要重新请求 tools/system/log/context。
  useEffect(() => {
    requested.current.clear()
  }, [sessionId])

  // 面板展开时请求数据（首次展开或会话切换后展开）。
  useEffect(() => {
    if (collapsed) return
    const req = requested.current
    if (!req.has('tools')) { req.add('tools'); port.post({ type: 'tools_request' }) }
    if (!req.has('system')) { req.add('system'); port.post({ type: 'system_request' }) }
    if (!req.has('log')) { req.add('log'); port.post({ type: 'log_request' }) }
    if (!req.has('context')) { req.add('context'); port.post({ type: 'context_request' }) }
  }, [collapsed, sessionId, port])

  // 运行中 context 每 3s 刷新。
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
  // 用实时 tokens 重新计算 percent，确保进度条跟随 token 变化（不依赖 contextState 的快照）。
  const tokens = props.contextState?.estimatedTokens ?? props.tokens
  const windowTokens = props.contextState?.windowTokens ?? props.windowTokens
  const percent = tokens && windowTokens ? Math.round((tokens / windowTokens) * 100) : (props.contextState?.percent ?? 0)
  const overload = percent > 80
  const files = [...props.filesTouched].sort((a, b) => b.time - a.time)
  const cfg = props.config

  return (
    <aside className={styles.infoPanel}>
      <header className={styles.header}>
        <span className={styles.headerTitle}>Info</span>
        <button className={styles.collapseBtn} onClick={props.onToggleCollapse} aria-label="Hide info panel">
          <ChevronRight size={14} strokeWidth={1.5} />
        </button>
      </header>

      <div className={styles.scrollArea}>
        <InfoCard title="Status & Model" icon={Activity} highlight={props.highlightSection === 'status'}>
          <div className={styles.statusRow}>
            <div className={styles.statusPill} data-status={status}>
              <span className={styles.statusIndicatorDot} data-status={status} />
              <span className={styles.statusLabel}>{statusLabel}</span>
            </div>
          </div>
          <div className={styles.modelRow}>
            <span className={styles.modelProvider}>{props.provider ?? '—'}</span>
            <span className={styles.modelName}>{props.model ?? '—'}</span>
          </div>
        </InfoCard>

        <InfoCard title="Context" icon={Gauge} highlight={props.highlightSection === 'context'}>
          {tokens !== undefined && windowTokens !== undefined ? (
            <>
              <div className={styles.contextBar}>
                <div className={styles.contextFill} style={{ width: `${Math.min(100, percent)}%` }} data-overload={overload} />
              </div>
              <div className={styles.contextNumbers}>
                <span className={styles.contextUsed}>{tokens.toLocaleString()}</span>
                <span className={styles.contextSep}>/</span>
                <span className={styles.contextWindow}>{windowTokens.toLocaleString()}</span>
                <span className={styles.contextPercent} data-overload={overload}>{percent}%</span>
              </div>
            </>
          ) : <p className={styles.emptyText}>Not available</p>}
        </InfoCard>

        <InfoCard title="Tool Calls" icon={Wrench} highlight={props.highlightSection === 'toolcalls'}>
          {props.toolCalls.length === 0 ? (
            <p className={styles.emptyText}>No tool calls yet</p>
          ) : (
            <div className={styles.toolList}>
              {[...props.toolCalls].reverse().map((tc) => {
                // 使用执行时记录的 configPerm 快照 + decision——不随后续设置变化。
                const actualPerm = tc.configPerm === 'allow' ? 'allow' : tc.configPerm === 'reject' ? 'reject' : (tc.decision === 'allow_once' ? 'once' : tc.decision === 'allow_always' ? 'always' : tc.decision === 'reject' ? 'rejected' : 'ask')
                return (
                  <div key={tc.id} className={styles.toolCallItem}>
                    <span className={styles.toolCallSeq}>{tc.seq}</span>
                    <span className={`${styles.toolCallIcon} ${styles[`toolCall_${tc.status}`]}`}>
                      {tc.status === 'running' && <span className="spin" style={{ display: 'inline-block' }}>↻</span>}
                      {tc.status === 'done' && '✓'}
                      {tc.status === 'error' && '✕'}
                      {tc.status === 'rejected' && '⊘'}
                    </span>
                    <span className={styles.toolCallName}>{tc.name}</span>
                    <span className={styles.toolPerm} data-perm={actualPerm}>{actualPerm}</span>
                  </div>
                )
              })}
            </div>
          )}
        </InfoCard>

        <InfoCard title="Files Touched" icon={FileEdit} highlight={props.highlightSection === 'files'}>
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
                  <Badge variant={f.action === 'edit' ? 'warning' : 'success'}>{f.action}</Badge>
                </div>
              ))}
            </div>
          )}
        </InfoCard>

        <InfoCard title="Available Tools" icon={Wrench} highlight={props.highlightSection === 'tools'}>
          {props.toolsList.length === 0 ? (
            <p className={styles.emptyText}>Loading...</p>
          ) : (
            <div className={styles.miniList}>
              {props.toolsList.map((t) => {
                const perm = getToolPermission(t.name, cfg)
                return (
                  <div key={t.name} className={styles.miniItem}>
                    <code className={styles.miniName}>{t.name}</code>
                    <span className={styles.toolPerm} data-perm={perm}>{perm}</span>
                  </div>
                )
              })}
            </div>
          )}
        </InfoCard>

        {/* Session Permissions — allow_always 授权列表，可撤销 */}
        <InfoCard title="Session Permissions" icon={ShieldCheck} defaultOpen={false} highlight={props.highlightSection === 'permissions'}>
          {props.permissionsList.length === 0 ? (
            <p className={styles.emptyText}>No always-allowed tools this session</p>
          ) : (
            <div className={styles.toolList}>
              {props.permissionsList.map((tool) => (
                <div key={tool} className={styles.fileItem}>
                  <code className={styles.miniName}>{tool}</code>
                  <button
                    className={styles.permRevokeBtn}
                    onClick={() => props.port.post({ type: 'permission_revoke', tool })}
                    aria-label={`Revoke ${tool}`}
                  >
                    <X size={10} strokeWidth={2} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </InfoCard>

        <InfoCard title="System Prompt" icon={Terminal} defaultOpen={false} highlight={props.highlightSection === 'system'}>
          {props.systemState ? (
            <div className={styles.miniContent}>
              <span className={styles.miniPath}>{props.systemState.path}</span>
              <pre className={styles.miniPre}>{props.systemState.content.slice(0, 200)}</pre>
            </div>
          ) : <p className={styles.emptyText}>Loading...</p>}
        </InfoCard>

        <InfoCard title="Log Tail" icon={ScrollText} defaultOpen={false} highlight={props.highlightSection === 'log'}>
          {props.logState ? (
            <pre className={styles.miniPre}>{props.logState.tail.slice(0, 500)}</pre>
          ) : <p className={styles.emptyText}>Loading...</p>}
        </InfoCard>
      </div>
    </aside>
  )
}

// ── 卡片式可折叠 section ──
function InfoCard({ title, icon: Icon, defaultOpen = true, highlight = false, children }: {
  title: string; icon: typeof Activity; defaultOpen?: boolean; highlight?: boolean; children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  // 高亮时自动展开。
  useEffect(() => { if (highlight) setOpen(true) }, [highlight])
  return (
    <div className={`${styles.infoCard} ${open ? '' : styles.collapsedCard} ${highlight ? styles.infoCardHighlight : ''}`}>
      <button className={styles.infoCardHeader} onClick={() => setOpen(!open)}>
        <ChevronDown size={12} strokeWidth={2} className={styles.infoChevron} />
        <Icon size={13} strokeWidth={1.5} className={styles.infoCardIcon} />
        <span className={styles.infoCardTitle}>{title}</span>
      </button>
      {open && <div className={styles.infoCardBody}>{children}</div>}
    </div>
  )
}
