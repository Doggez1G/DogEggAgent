import type { LlmStreamEvent } from '../types'
import type { Message } from '../../events/types'

interface PendingToolCall {
  id: string
  name: string
  args: string
}

// OpenAI 流式 SSE 解析器（行驱动，便于无网络单测）。
// - 文本 delta → text_delta；reasoning 字段 → thought_delta
// - tool_calls 按 index 累积，arguments 分片拼接，[DONE] 时组装成一条 assistant message
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
        events.push({ type: 'done', message: buildMessage() })
        return events
      }
      let json: any
      try {
        json = JSON.parse(data)
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
        const idx = tc.index ?? 0
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