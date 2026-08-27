import { readFileSync, existsSync } from 'node:fs'
import { sessionLogPath } from './write'

// 读取日志尾部若干行，用于 /log 面板展示。文件不存在时返回空串（会话尚未产生日志）。
export function readLogTail(sessionId: string, lines = 50): string {
  const path = sessionLogPath(sessionId)
  if (!path || !existsSync(path)) return ''
  const all = readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0)
  return all.slice(-lines).join('\n')
}
