import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Message } from '@dogegg/bridge'

// JSON 会话持久化。baseDir 可注入（测试传临时目录），运行时默认 ~/.dogegg/sessions。
export function defaultSessionsDir(): string {
  return join(homedir(), '.dogegg', 'sessions')
}

function file(baseDir: string, id: string): string {
  return join(baseDir, `${id}.json`)
}

export function saveSession(id: string, messages: Message[], baseDir = defaultSessionsDir()): void {
  mkdirSync(baseDir, { recursive: true })
  writeFileSync(file(baseDir, id), JSON.stringify({ id, updatedAt: new Date().toISOString(), messages }))
}

export function loadSession(id: string, baseDir = defaultSessionsDir()): { id: string; messages: Message[] } {
  const raw = JSON.parse(readFileSync(file(baseDir, id), 'utf8'))
  return { id: raw.id, messages: raw.messages }
}

export function listSessions(baseDir = defaultSessionsDir()): { id: string; updatedAt: string; preview: string }[] {
  if (!existsSync(baseDir)) return []
  return readdirSync(baseDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const raw = JSON.parse(readFileSync(join(baseDir, f), 'utf8'))
      const last: Message | undefined = raw.messages[raw.messages.length - 1]
      const preview = last && last.role !== 'tool' && typeof last.content === 'string' ? last.content.slice(0, 40) : ''
      return { id: raw.id, updatedAt: raw.updatedAt, preview }
    })
}