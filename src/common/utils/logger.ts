import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

// 调试日志：追加写文本行到 ~/.dogegg/logs/<session-id>.log，记录消息流 / 工具调用 / 状态迁移。
// initLogger 只初始化日志目录（而非固定到某个文件），log 按 sessionId 决定落哪个文件。
let logDir: string | null = null

export function initLogger(dir: string): void {
  logDir = dir
  mkdirSync(dir, { recursive: true })
}

// 给定 session 的日志文件路径；未初始化时返回 null（表示日志未启用）。
export function sessionLogPath(sessionId: string): string | null {
  return logDir ? join(logDir, `${sessionId}.log`) : null
}

export function log(sessionId: string, scope: string, msg: string): void {
  if (!logDir) return
  appendFileSync(join(logDir, `${sessionId}.log`), `${new Date().toISOString()} [${scope}] ${msg}\n`)
}

// 读取日志尾部若干行，用于 /log 面板展示。按设计文档只回「尾部若干行」。
export function readLogTail(sessionId: string, lines = 50): string {
  const path = sessionLogPath(sessionId)
  if (!path || !existsSync(path)) return ''
  const all = readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0)
  return all.slice(-lines).join('\n')
}