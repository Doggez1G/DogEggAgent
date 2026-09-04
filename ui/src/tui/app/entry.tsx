import { render } from 'ink'
import React from 'react'
import type { UiPort } from '@dogegg/bridge'
import { App } from './app'

// renderTui：封装 Ink render。
// 不使用 alt-screen（\x1b[?1049h）——采用 Claude Code 式架构：
// 消息历史经 <Static> 直接打印进终端正常滚动缓冲区，用户用终端原生滚动
// （滚轮/滚动条）查看历史；Ink 只重绘底部动态区（流式块+输入框+状态栏）。
// 这彻底解决了"视口裁切估算行数永远不准"的问题——历史内容不受终端高度限制。
//
// Ctrl+C 处理：正常情况下 Ink 的 useInput 在 raw mode 下捕获 Ctrl+C，
// 由 App 的键盘路由决定发 cancel（运行中）还是弹退出确认（空闲）。
// 兜底：如果 Ctrl+C 没被 Ink 捕获到（程序卡在 Ink 之外，如网络请求卡死），
// 全局 SIGINT handler 走"两次 Ctrl+C 退出"——第一次记时间戳，第二次在 1.5 秒内直接退出。
// 全局 SIGINT 状态——useInput 处理了 Ctrl+C 后调 resetSigintTimer 清除兜底窗口。
let lastSigint = 0
export function resetSigintTimer(): void { lastSigint = 0 }

// 清屏并复位光标——会话切换/清空历史时用（Static 已输出的内容无法撤回，只能清屏重绘）。
export function clearScreen(): void {
  process.stdout.write('\x1b[2J\x1b[H')
}

export function renderTui(port: UiPort): void {
  // 启动清屏——新界面的仪式感（同 Claude Code）：历史缓冲区仍可用（非 alt-screen），
  // 用户滚动依然能看到本会话从启动开始的全部输出。
  clearScreen()
  process.on('exit', () => {
    try { process.stdin.setRawMode?.(false) } catch { /* stdin 已关闭 */ }
  })
  process.on('SIGINT', () => {
    const now = Date.now()
    if (now - lastSigint < 1500) {
      // 两次 Ctrl+C 快速连按——兜底强制退出（Ink 没捕获到时用）。
      process.exit(0)
    }
    lastSigint = now
    // 第一次：让 Ink 的 useInput 处理（发 cancel 或弹退出确认）。
    // 如果 Ink 没捕获到（卡死），用户再按一次会走上面的强制退出。
  })
  process.on('SIGTERM', () => { process.exit(0) })

  // exitOnCtrlC: false——让 Ctrl+C (\x03) 流到 useInput 由 App 处理（运行中打断/空闲弹退出确认），
  // 而非 Ink 直接退出程序。
  render(<App port={port} />, { exitOnCtrlC: false })
}
