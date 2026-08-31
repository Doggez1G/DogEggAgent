import React from 'react'
import { Cpu, FolderClosed } from 'lucide-react'
import styles from './top-bar.module.css'

// 顶栏：provider/model 信息 + cwd 显示 + 运行指示器。
// 优化：使用图标+文本组合，cwd 用 chip 样式显示，布局更清晰。
interface TopBarProps {
  provider: string | undefined
  model: string | undefined
  cwd: string
  isRunning: boolean
}

export function TopBar({ provider, model, cwd, isRunning }: TopBarProps) {
  const modelInfo = provider ? `${provider}/${model ?? '?'}` : 'Not configured'
  const cwdLabel = cwd.split(/[/\\]/).pop() || cwd
  return (
    <header className={styles.topBar}>
      {/* 运行状态指示 */}
      {isRunning && (
        <div className={styles.runningIndicator}>
          <span className={styles.pulseDot + ' pulse-dot'} />
          <span className={styles.pulseDot + ' pulse-dot'} />
          <span className={styles.pulseDot + ' pulse-dot'} />
        </div>
      )}

      {/* 模型信息 */}
      <div className={styles.modelChip}>
        <Cpu size={13} strokeWidth={1.5} className={styles.modelIcon} />
        <span className={styles.modelText}>{modelInfo}</span>
      </div>

      {/* 工作目录 */}
      <div className={styles.cwdChip} title={cwd}>
        <FolderClosed size={13} strokeWidth={1.5} className={styles.cwdIcon} />
        <span className={styles.cwdText}>{cwdLabel}</span>
      </div>
    </header>
  )
}
