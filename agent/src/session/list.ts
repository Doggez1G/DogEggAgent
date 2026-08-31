import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Message } from '@dogegg/bridge'
import { defaultSessionsDir } from './store'

// 会话列表 + preview + cwd，按 updatedAt 降序排序（最新在最前，方便查找）。
// preview 取 history（完整原文）最后一条非 tool 消息——
// 用 history 而非 context，因为 history 是用户可见的完整历史，preview 要反映用户真实对话。
// cwd 用于前端按项目（工作目录）分组会话。
export function listSessions(baseDir = defaultSessionsDir()): { id: string; updatedAt: string; preview: string; cwd: string }[] {
  if (!existsSync(baseDir)) return []
  return readdirSync(baseDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      // 单个文件损坏不阻断整个列表——跳过并返回占位项。
      try {
        const raw = JSON.parse(readFileSync(join(baseDir, f), 'utf8'))
        const history: Message[] = raw.history ?? raw.messages ?? []
        const last: Message | undefined = history[history.length - 1]
        const preview = last && last.role !== 'tool' && typeof last.content === 'string' ? last.content.slice(0, 40) : ''
        const cwd: string = raw.cwd ?? ''
        return { id: raw.id ?? f.replace('.json', ''), updatedAt: raw.updatedAt ?? '', preview, cwd }
      } catch {
        return { id: f.replace('.json', ''), updatedAt: '', preview: '（文件损坏）', cwd: '' }
      }
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) // 降序：最新在前
}
