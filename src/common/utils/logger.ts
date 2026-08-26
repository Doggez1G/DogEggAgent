import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// 调试日志：追加写文本行到 ~/.dogegg/logs/<session-id>.log，记录消息流/工具调用/状态迁移。
let logPath: string | null = null

export function initLogger(path: string): void {
  logPath = path
  mkdirSync(dirname(path), { recursive: true })
}

export function log(scope: string, msg: string): void {
  if (!logPath) return
  appendFileSync(logPath, `${new Date().toISOString()} [${scope}] ${msg}\n`)
}