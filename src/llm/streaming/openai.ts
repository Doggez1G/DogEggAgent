import type { LlmStreamEvent } from '../types'
import type { Message } from '@dogegg/bridge'

interface PendingToolCall {
  id: string
  name: string
  args: string
}

// SSE 数据片段的最小类型形状（OpenAI chat.completions 流）。全部字段可选，逐字段窄化，避免无类型 any。
interface SseToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}
interface SseChoiceDelta {
  content?: string
  reasoning_content?: string
  reasoning?: string
  tool_calls?: SseToolCallDelta[]
}
interface SseChunk {
  choices?: { delta?: SseChoiceDelta }[]
}

// OpenAI 流式 SSE 解析器（行驱动，便于无网络单测）。
// - 文本 delta → text_delta；reasoning 字段 → thought_delta
// - tool_calls 按 index 累积，arguments 分片拼接
// - [DONE] 时逐 tool call 发 tool_call_end（组装完整 id/name/arguments），再发 done 组装成一条 assistant 消息
export function createOpenAiStreamParser() {
  let content = ''
  let reasoning = ''
  const calls = new Map<number, PendingToolCall>()

  function buildMessage(): Message {
    const tool_calls = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.args } }))
    return { role: 'assistant', content: content || null, ...(tool_calls.length ? { tool_calls } : {}) }
  }

  return {
    feed(line: string): LlmStreamEvent[] {
      const events: LlmStreamEvent[] = []
      if (!line.startsWith('data:')) return events
      const data = line.slice(5).trim()
      if (data === '[DONE]') {
        for (const [idx, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
          events.push({ type: 'tool_call_end', index: idx, id: c.id, name: c.name, arguments: c.args })
        }
        events.push({ type: 'done', message: buildMessage() })
        return events
      }
      let json: SseChunk
      try {
        json = JSON.parse(data) as SseChunk
      } catch {
        return events
      }
      const delta = json.choices?.[0]?.delta ?? {}

      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content
        events.push({ type: 'text_delta', text: delta.content })
      }
      const r = delta.reasoning_content ?? delta.reasoning
      if (typeof r === 'string' && r) {
        reasoning += r
        events.push({ type: 'thought_delta', text: r })
      }
      for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const idx = typeof tc.index === 'number' ? tc.index : 0
        if (!calls.has(idx)) {
          calls.set(idx, { id: tc.id ?? '', name: '', args: '' })
          events.push({ type: 'tool_call_start', index: idx, id: tc.id ?? '', name: '' })
        }
        const cur = calls.get(idx)!
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name = tc.function.name
        if (tc.function?.arguments) {
          cur.args += tc.function.arguments
          events.push({ type: 'tool_call_delta', index: idx, argsJsonDelta: tc.function.arguments })
        }
      }
      return events
    },
  }
}