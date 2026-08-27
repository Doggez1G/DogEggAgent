import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { currentLogDir } from './init'

// 给定 session 的日志文件路径；未初始化（currentLogDir 为 null）时返回 null。
export function sessionLogPath(sessionId: string): string | null {
  const dir = currentLogDir()
  return dir ? join(dir, `${sessionId}.log`) : null
}

// 追加写一行日志：时间戳 + scope + 消息。未初始化时静默跳过（不报错，便于测试中不初始化也能跑）。
export function log(sessionId: string, scope: string, msg: string): void {
  const dir = currentLogDir()
  if (!dir) return
  appendFileSync(join(dir, `${sessionId}.log`), `${new Date().toISOString()} [${scope}] ${msg}\n`)
}
