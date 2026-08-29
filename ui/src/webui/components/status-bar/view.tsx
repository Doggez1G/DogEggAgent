import React from 'react'
import styles from './status-bar.module.css'

// 状态栏：token 占用 + 当前状态文本。简洁，不喧宾夺主。
interface StatusBarProps {
  status: string
  tokens: number | undefined
  windowTokens: number | undefined
}

const STATUS_LABELS: Record<string, string> = {
  idle: 'Ready',
  thinking: 'Thinking',
  responding: 'Responding',
  tool_calling: 'Calling tool',
  waiting_permission: 'Waiting for permission',
  executing: 'Executing',
  finished: 'Finished',
  cancelled: 'Cancelled',
  error: 'Error',
  compacting: 'Compacting',
}

export function StatusBar({ status, tokens, windowTokens }: StatusBarProps) {
  const label = STATUS_LABELS[status] ?? status
  const percent = tokens && windowTokens ? Math.round((tokens / windowTokens) * 100) : 0
  return (
    <div className={styles.statusBar}>
      <span className={styles.statusLabel}>{label}</span>
      {tokens !== undefined && windowTokens !== undefined && (
        <div className={styles.tokenInfo}>
          <div className={styles.tokenBar}>
            <div
              className={styles.tokenFill}
              style={{ width: `${Math.min(100, percent)}%` }}
              data-overload={percent > 80 ? 'true' : 'false'}
            />
          </div>
          <span className={styles.tokenText}>{tokens.toLocaleString()} / {windowTokens.toLocaleString()}</span>
        </div>
      )}
    </div>
  )
}
