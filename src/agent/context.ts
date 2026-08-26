import { readFileSync } from 'node:fs'
import { estimateTokens } from '../common/utils/token-count'
import type { Message } from '../events/types'

// 内置 system prompt：config.systemPrompt 未指定路径时使用。
const BUILTIN_PROMPT = '你是一个代码编辑 agent。用工具读写文件、运行命令，一步步完成任务，并简要说明每一步做了什么。'

// 加载 system prompt 文本。配置只存路径，避免把大段 prompt 塞进 config、改起来也无需动配置 schema。
export function loadSystemPrompt(path: string | undefined): string {
  if (!path) return BUILTIN_PROMPT
  return readFileSync(path, 'utf8')
}

// 估算整个 context 的 token 数（system + 历史 + 工具 schema）。CJK 按 1 token/字，其余按 4 字符 ≈ 1 token。
// 用于窗口预算与 compaction 触发判断，精度需求不高。
export function estimateContextTokens(system: string, messages: Message[], tools: object[]): number {
  const body = messages
    .map((m) => (m.role === 'assistant' ? (m.content ?? '') + (m.tool_calls ? JSON.stringify(m.tool_calls) : '') : m.content))
    .join('')
  return estimateTokens(system) + estimateTokens(body) + estimateTokens(JSON.stringify(tools))
}

// 是否触发压缩：超过窗口 80% 时压缩最旧历史。
export function shouldCompact(used: number, windowTokens: number): boolean {
  return used > windowTokens * 0.8
}

// 压缩切分：保留最近 keep 条原文，更早的交给 LLM 总结（总结动作在 loop 里调用）。
export function splitForCompaction(messages: Message[], keep = 4): { old: Message[]; fresh: Message[] } {
  if (messages.length <= keep) return { old: [], fresh: [...messages] }
  return { old: messages.slice(0, messages.length - keep), fresh: messages.slice(messages.length - keep) }
}