import React from 'react'
import { Cpu, FolderClosed, Search } from 'lucide-react'
import styles from './top-bar.module.css'

// 顶栏：运行状态 + provider/model + cwd + Cmd+K 命令面板入口。
interface TopBarProps {
  provider: string | undefined
  model: string | undefined
  cwd: string
  isRunning: boolean
  status: string
  onOpenCommandPalette: () => void
}

export function TopBar({ provider, model, cwd, isRunning, status, onOpenCommandPalette }: TopBarProps) {
  const modelInfo = provider ? `${provider}/${model ?? '?'}` : 'Not configured'
  const cwdLabel = cwd.split(/[/\\]/).pop() || cwd
  const statusLabel = status ? status.charAt(0).toUpperCase() + status.slice(1) : ''

  return (
    <header className={styles.topBar}>
      {/* 左：运行指示器（脉冲点）或状态文本 */}
      {isRunning ? (
        <div className={styles.runningIndicator}>
          <span className={`${styles.pulseDot} pulse-dot`} />
          <span className={`${styles.pulseDot} pulse-dot`} />
          <span className={`${styles.pulseDot} pulse-dot`} />
        </div>
      ) : (
        <span className={styles.statusText}>{statusLabel}</span>
      )}

      {/* 中：模型信息 */}
      <div className={styles.modelChip}>
        <Cpu size={13} strokeWidth={1.5} className={styles.modelIcon} />
        <span className={styles.modelText}>{modelInfo}</span>
      </div>

      {/* 中：工作目录 */}
      <div className={styles.cwdChip} title={cwd}>
        <FolderClosed size={13} strokeWidth={1.5} className={styles.cwdIcon} />
        <span className={styles.cwdText}>{cwdLabel}</span>
      </div>

      {/* 右：Cmd+K 命令面板 */}
      <button
        className={styles.cmdkBtn}
        onClick={onOpenCommandPalette}
        aria-label="Command palette"
        title="Command palette (⌘K)"
      >
        <Search size={13} strokeWidth={1.5} />
        <span>⌘K</span>
      </button>
    </header>
  )
}
