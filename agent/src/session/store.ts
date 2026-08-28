import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
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

// R1 双持久化：session 文件存 { id, updatedAt, history, context, allowedTools }。
// history = 完整原文（永不压缩，给 UI 显示）；context = 发给模型的消息（会压缩）。
// allowedTools = 会话级 allow_always 授权工具列表（resume 时恢复，实现跨会话切换保留授权）。
// 两者分离见需求 §3.1——resume 时 history 给 UI 显示、context 给模型用压缩版。
export function saveSession(id: string, history: Message[], context: Message[], allowedTools: string[] = [], baseDir = defaultSessionsDir()): void {
  mkdirSync(baseDir, { recursive: true })
  const target = file(baseDir, id)
  const tmp = target + '.tmp'
  writeFileSync(tmp, JSON.stringify({ id, updatedAt: new Date().toISOString(), history, context, allowedTools }))
  renameSync(tmp, target)
}

export function loadSession(id: string, baseDir = defaultSessionsDir()): { id: string; history: Message[]; context: Message[]; allowedTools: string[] } {
  const raw = JSON.parse(readFileSync(file(baseDir, id), 'utf8'))
  // 兼容旧格式（只有 messages）：若无 history/context 字段，回退用 messages。
  // 必须拷贝（[...history]）——否则旧格式时 context 和 history 引用同一数组，push 时双写变三写。
  const history: Message[] = raw.history ?? raw.messages ?? []
  const context: Message[] = raw.context ?? [...history]
  const allowedTools: string[] = raw.allowedTools ?? []
  return { id: raw.id ?? id, history, context, allowedTools }
}
