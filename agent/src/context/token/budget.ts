import type { Message } from '@dogegg/bridge'
import { estimateTokens } from './estimate'

// 估算整个 context 的 token 数（system + 消息 + 工具 schema）。
// assistant 消息的 content 可能为 null（纯 tool_calls 响应），且 tool_calls 不在 content 里，需单独 stringify。
export function estimateContextTokens(system: string, messages: Message[], tools: object[]): number {
  const body = messages
    .map((m) => (m.role === 'assistant' ? (m.content ?? '') + (m.tool_calls ? JSON.stringify(m.tool_calls) : '') : m.content))
    .join('')
  return estimateTokens(system) + estimateTokens(body) + estimateTokens(JSON.stringify(tools))
}
