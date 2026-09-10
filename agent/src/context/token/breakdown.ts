import type { ContextBreakdown, Message } from '@dogegg/bridge'
import { estimateTokens } from './estimate'

// context token 分段估算（/context 仪表盘）：按消息角色分桶 + system 提示词 + 工具 schema。
// 与 estimateContextTokens 同一估算口径（粗估），分段之和等于总估算——仪表盘的分段条与总数自洽。
export function breakdownContextTokens(system: string, messages: Message[], tools: object[]): ContextBreakdown {
  const breakdown: ContextBreakdown = { system: estimateTokens(system), user: 0, assistant: 0, tool: 0, tools: estimateTokens(JSON.stringify(tools)) }
  for (const m of messages) {
    // assistant 的 tool_calls 不在 content 里（与 estimateContextTokens 同款处理），需单独 stringify。
    const size = estimateTokens(m.role === 'assistant' ? (m.content ?? '') + (m.tool_calls ? JSON.stringify(m.tool_calls) : '') : m.content)
    breakdown[m.role] += size
  }
  return breakdown
}
