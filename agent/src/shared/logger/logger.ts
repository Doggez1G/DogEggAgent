import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 日志实例：每个 session 一个日志文件（<dir>/<session-id>.log），按时间戳 + scope 追加写。
// dir 为 null 表示日志未启用——log/tail 全部静默（测试中不传目录也能跑）。
export class Logger {
  constructor(private readonly dir: string | null) {
    if (dir) mkdirSync(dir, { recursive: true })
  }

  // 给定 session 的日志文件路径；未启用时返回 null。
  path(sessionId: string): string | null {
    return this.dir ? join(this.dir, `${sessionId}.log`) : null
  }

  // 追加写一行日志：时间戳 + scope + 消息。未启用时静默跳过。
  log(sessionId: string, scope: string, msg: string): void {
    if (!this.dir) return
    appendFileSync(join(this.dir, `${sessionId}.log`), `${new Date().toISOString()} [${scope}] ${msg}\n`)
  }

  // 读取日志尾部若干行，用于 /log 面板展示。文件不存在时返回空串（会话尚未产生日志）。
  tail(sessionId: string, lines = 50): string {
    const path = this.path(sessionId)
    if (!path || !existsSync(path)) return ''
    const all = readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0)
    return all.slice(-lines).join('\n')
  }
}
