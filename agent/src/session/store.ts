import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

// R1 双持久化：session 文件存 { id, updatedAt, history, context }。
// history = 完整原文（永不压缩，给 UI 显示）；context = 发给模型的消息（会压缩）。
// 两者分离见需求 §3.1——resume 时 history 给 UI 显示、context 给模型用压缩版。
export function saveSession(id: string, history: Message[], context: Message[], baseDir = defaultSessionsDir()): void {
  mkdirSync(baseDir, { recursive: true })
  writeFileSync(file(baseDir, id), JSON.stringify({ id, updatedAt: new Date().toISOString(), history, context }))
}

export function loadSession(id: string, baseDir = defaultSessionsDir()): { id: string; history: Message[]; context: Message[] } {
  const raw = JSON.parse(readFileSync(file(baseDir, id), 'utf8'))
  // 兼容旧格式（只有 messages）：若无 history/context 字段，回退用 messages。
  const history: Message[] = raw.history ?? raw.messages ?? []
  const context: Message[] = raw.context ?? history
  return { id: raw.id, history, context }
}
