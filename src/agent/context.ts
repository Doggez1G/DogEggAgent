import { readFileSync } from 'node:fs'
import { estimateTokens } from '../common/utils/token-count'
import type { Message } from '../events/types'

const BUILTIN_PROMPT = '你是一个代码编辑 agent。用工具读写文件、运行命令，一步步完成任务。'

export function loadSystemPrompt(path: string | undefined): string {
  if (!path) return BUILTIN_PROMPT
  return readFileSync(path, 'utf8')
}

// 估算整个 context 的 token：system + 历史 + 工具 schema。
export function estimateContextTokens(system: string, messages: Message[], tools: object[]): number {
  const body = messages
    .map((m) => (m.role === 'assistant' ? (m.content ?? '') + (m.tool_calls ? JSON.stringify(m.tool_calls) : '') : m.content))
    .join('')
  return estimateTokens(system) + estimateTokens(body) + estimateTokens(JSON.stringify(tools))
}

export function shouldCompact(used: number, windowTokens: number): boolean {
  return used > windowTokens * 0.8
}

// v1 简化：仅返回保留最近 keep 条的历史；真正的 LLM 总结在 Task 12 之外作为扩展。
export function splitForCompaction(messages: Message[], keep = 4): { fresh: Message[] } {
  return { fresh: messages.slice(-keep) }
}