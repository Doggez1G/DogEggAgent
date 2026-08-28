import { render } from 'ink'
import React from 'react'
import type { UiPort } from '@dogegg/bridge'
import { App } from './app'

// renderTui：封装 Ink render + 备用屏幕（alt-screen）进出。
// alt-screen 让 TUI 运行在独立屏幕，不污染终端滚动历史；退出时恢复原屏幕。
// 终端表现层事务归 UI 管（不进 agent）。
export function renderTui(port: UiPort): void {
  // 进入备用屏幕
  process.stdout.write('\x1b[?1049h')
  // 退出时恢复：alt-screen 退出码 + raw mode 复位（Ink 的 unmount 可能来不及执行）。
  const leave = () => {
    process.stdout.write('\x1b[?1049l')
    try { process.stdin.setRawMode?.(false) } catch { /* stdin 已关闭 */ }
  }
  process.on('exit', leave)
  process.on('SIGINT', () => { leave(); process.exit(0) })
  process.on('SIGTERM', () => { leave(); process.exit(0) })

  render(<App port={port} />)
}
