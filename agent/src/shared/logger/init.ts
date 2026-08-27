import { mkdirSync } from 'node:fs'

// 日志目录初始化。模块级 logDir 是隐式全局状态——agent 启动时 init 一次，后续 log 按 sessionId 落文件。
// 这是有意的：避免每次 log 调用都传 dir 参数，保持调用点简洁。
let logDir: string | null = null

export function initLogger(dir: string): void {
  logDir = dir
  mkdirSync(dir, { recursive: true })
}

// 供 write/tail 模块读取当前日志目录；未初始化时返回 null（表示日志未启用）。
export function currentLogDir(): string | null {
  return logDir
}
