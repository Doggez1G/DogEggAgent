import { STATUS_LABELS } from '../../../shared'
import React from 'react'
import { Cpu, FolderClosed, Search } from 'lucide-react'
import styles from './top-bar.module.css'

// 顶栏：状态 pill + 模型/cwd + 连接状态 + Cmd+K 搜索框样式按钮。
interface TopBarProps {
  provider: string | undefined
  model: string | undefined
  cwd: string
  isRunning: boolean
  status: string
  connectionState?: 'connected' | 'reconnecting' | 'disconnected'
  onOpenCommandPalette: () => void
}


const CONN_LABELS: Record<string, string> = {
  connected: 'Connected',
  reconnecting: 'Reconnecting...',
  disconnected: 'Disconnected',
}

export function TopBar({ provider, model, cwd, isRunning, status, connectionState, onOpenCommandPalette }: TopBarProps) {
  const cwdLabel = cwd.split(/[/\\]/).pop() || cwd
  const statusLabel = STATUS_LABELS[status] ?? status
  const showConn = connectionState && connectionState !== 'connected'
  const connLabel = connectionState ? CONN_LABELS[connectionState] ?? '' : ''

  return (
    <header className={styles.topBar}>
      {/* 状态 pill */}
      <div className={styles.statusPill} data-status={status} data-running={isRunning}>
        <span className={styles.statusDot} data-status={status} />
        <span>{statusLabel}</span>
      </div>

      {showConn && (
        <>
          <div className={styles.sep} />
          <div className={styles.connPill} data-conn={connectionState}>
            <span className={styles.connDot} data-conn={connectionState} />
            <span>{connLabel}</span>
          </div>
        </>
      )}

      <div className={styles.sep} />

      {/* 模型 */}
      <div className={styles.modelChip}>
        <Cpu size={13} strokeWidth={1.5} className={styles.modelIcon} />
        <span className={styles.modelProvider}>{provider ?? '—'}</span>
        <span className={styles.modelSlash}>/</span>
        <span className={styles.modelName}>{model ?? '?'}</span>
      </div>

      <div className={styles.sep} />

      {/* 工作目录 */}
      <div className={styles.cwdChip} title={cwd}>
        <FolderClosed size={13} strokeWidth={1.5} className={styles.cwdIcon} />
        <span className={styles.cwdText}>{cwdLabel}</span>
      </div>

      {/* Cmd+K 搜索框样式按钮 */}
      <button className={styles.cmdkBtn} onClick={onOpenCommandPalette} aria-label="Command palette">
        <Search size={13} strokeWidth={1.5} />
        <span className={styles.cmdkLabel}>Search</span>
        <span className={styles.cmdkKey}>⌘K</span>
      </button>
    </header>
  )
}
