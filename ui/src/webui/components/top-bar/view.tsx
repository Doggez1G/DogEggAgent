import React from 'react'
import styles from './top-bar.module.css'

// 顶栏：provider/model 信息 + cwd 显示 + 状态指示。
interface TopBarProps {
  provider: string | undefined
  model: string | undefined
  cwd: string
  isRunning: boolean
}

export function TopBar({ provider, model, cwd, isRunning }: TopBarProps) {
  const modelInfo = provider ? `${provider}/${model ?? '?'}` : 'Not configured'
  return (
    <header className={styles.topBar}>
      <div className={styles.modelInfo}>
        <span className={styles.label}>{modelInfo}</span>
      </div>
      <div className={styles.cwdInfo} title={cwd}>
        <span className={styles.cwdText}>{cwd}</span>
      </div>
      {isRunning && (
        <div className={styles.runningIndicator}>
          <span className={styles.pulseDot + ' pulse-dot'} />
          <span className={styles.pulseDot + ' pulse-dot'} />
          <span className={styles.pulseDot + ' pulse-dot'} />
        </div>
      )}
    </header>
  )
}
