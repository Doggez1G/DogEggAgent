import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Message } from '@dogegg/bridge'
import { defaultSessionsDir } from './store'

// 会话列表 + preview。preview 取 history（完整原文）最后一条非 tool 消息——
// 用 history 而非 context，因为 history 是用户可见的完整历史，preview 要反映用户真实对话。
export function listSessions(baseDir = defaultSessionsDir()): { id: string; updatedAt: string; preview: string }[] {
  if (!existsSync(baseDir)) return []
  return readdirSync(baseDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const raw = JSON.parse(readFileSync(join(baseDir, f), 'utf8'))
      const history: Message[] = raw.history ?? raw.messages ?? []
      const last: Message | undefined = history[history.length - 1]
      const preview = last && last.role !== 'tool' && typeof last.content === 'string' ? last.content.slice(0, 40) : ''
      return { id: raw.id, updatedAt: raw.updatedAt, preview }
    })
}
