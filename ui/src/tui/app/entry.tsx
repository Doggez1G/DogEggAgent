import { render } from 'ink'
import React from 'react'
import type { UiPort } from '@dogegg/bridge'
import { App } from './app'

// renderTui：封装 Ink render + 备用屏幕（alt-screen）进出。
// alt-screen 让 TUI 运行在独立屏幕，不污染终端滚动历史；退出时恢复原屏幕。
// 终端表现层事务归 UI 管（不进 agent）。
//
// Ctrl+C 处理：正常情况下 Ink 的 useInput 在 raw mode 下捕获 Ctrl+C，
// 由 App 的键盘路由决定发 cancel（运行中）还是弹退出确认（空闲）。
// 兜底：如果 Ctrl+C 没被 Ink 捕获到（程序卡在 Ink 之外，如网络请求卡死），
// 全局 SIGINT handler 走"两次 Ctrl+C 退出"——第一次记时间戳，第二次在 1.5 秒内直接退出。
let lastSigint = 0
export function renderTui(port: UiPort): void {
  process.stdout.write('\x1b[?1049h')
  const leave = () => {
    process.stdout.write('\x1b[?1049l')
    try { process.stdin.setRawMode?.(false) } catch { /* stdin 已关闭 */ }
  }
  process.on('exit', leave)
  process.on('SIGINT', () => {
    const now = Date.now()
    if (now - lastSigint < 1500) {
      // 两次 Ctrl+C 快速连按——兜底强制退出（Ink 没捕获到时用）。
      leave()
      process.exit(0)
    }
    lastSigint = now
    // 第一次：让 Ink 的 useInput 处理（发 cancel 或弹退出确认）。
    // 如果 Ink 没捕获到（卡死），用户再按一次会走上面的强制退出。
  })
  process.on('SIGTERM', () => { leave(); process.exit(0) })

  render(<App port={port} />)
}
