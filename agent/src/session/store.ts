import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs'
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

// R1 双持久化：session 文件存 { id, updatedAt, history, context, allowedTools, cwd, thinking }。
// history = 完整原文（永不压缩，给 UI 显示）；context = 发给模型的消息（会压缩）。
// allowedTools = 会话级 allow_always 授权工具列表（resume 时恢复，实现跨会话切换保留授权）。
// cwd = 创建会话时的工作目录（resume 时恢复，实现项目→会话切换恢复目录）。
// thinking = 推理模型的思考内容数组（resume 时恢复思考块显示，不进 history/context）。
export function saveSession(id: string, history: Message[], context: Message[], allowedTools: string[] = [], baseDir = defaultSessionsDir(), cwd = '', thinking: { text: string }[] = []): void {
  mkdirSync(baseDir, { recursive: true })
  const target = file(baseDir, id)
  const tmp = target + '.tmp'
  writeFileSync(tmp, JSON.stringify({ id, updatedAt: new Date().toISOString(), history, context, allowedTools, cwd, thinking }))
  renameSync(tmp, target)
}

export function loadSession(id: string, baseDir = defaultSessionsDir()): { id: string; history: Message[]; context: Message[]; allowedTools: string[]; cwd: string; thinking: { text: string }[] } {
  const raw = JSON.parse(readFileSync(file(baseDir, id), 'utf8'))
  // 兼容旧格式（只有 messages）：若无 history/context 字段，回退用 messages。
  const history: Message[] = raw.history ?? raw.messages ?? []
  const context: Message[] = raw.context ?? [...history]
  const allowedTools: string[] = raw.allowedTools ?? []
  const cwd: string = raw.cwd ?? ''
  const thinking: { text: string }[] = raw.thinking ?? []
  return { id: raw.id ?? id, history, context, allowedTools, cwd, thinking }
}

// 删除会话文件。文件不存在时静默成功（幂等）。
export function deleteSession(id: string, baseDir = defaultSessionsDir()): void {
  const target = file(baseDir, id)
  if (existsSync(target)) unlinkSync(target)
}
