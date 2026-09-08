import type { LlmStreamEvent } from '../../types'
import type { Message } from '@dogegg/bridge'
import type { SseChunk } from './sse-types'

interface PendingToolCall {
  id: string
  name: string
  args: string
}

// OpenAI 流式 SSE 解析器（行驱动，便于无网络单测：直接喂 mock SSE 行）。
// - 文本 delta → text_delta；reasoning 字段 → thought_delta（推理模型思考内容）
// - tool_calls 按 index 累积，arguments 分片拼接（流式可能分多次送达同一 tool call 的参数）
// - [DONE] 时逐 tool call 发 tool_call_end（组装完整 id/name/arguments），再发 done 组装成一条 assistant 消息
export function createOpenAiStreamParser() {
  let content = ''
  let reasoning = ''
  const calls = new Map<number, PendingToolCall>()

  // [DONE] 时组装最终 assistant 消息：content（可能为 null）+ tool_calls（按 index 排序）。
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
        events.push({ type: 'done', message: buildMessage(), ...(reasoning ? { reasoning } : {}) })
        return events
      }
      let json: SseChunk
      try {
        json = JSON.parse(data) as SseChunk
      } catch {
        return events // 非 JSON 行（如注释/心跳）静默跳过
      }
      const delta = json.choices?.[0]?.delta ?? {}

      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content
        events.push({ type: 'text_delta', text: delta.content })
      }
      // reasoning 字段：reasoning_content（OpenAI 标准）优先，回退 reasoning（部分兼容端点）。
      // 累积 reasoning 文本——done 事件携带完整 reasoning 供持久化（resume 后恢复思考块）。
      const r = delta.reasoning_content ?? delta.reasoning
      if (typeof r === 'string' && r) {
        reasoning += r
        events.push({ type: 'thought_delta', text: r })
      }
      for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const idx = typeof tc.index === 'number' ? tc.index : 0
        const isNew = !calls.has(idx)
        if (isNew) calls.set(idx, { id: tc.id ?? '', name: '', args: '' })
        const cur = calls.get(idx)!
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name = tc.function.name
        // tool_call_start 必须在字段合并之后发出——OpenAI 协议里 name/id 往往随首个分片才到，
        // 先合并再广播，下游的 tool_pending 才能携带真实工具名（而非空串）。
        if (isNew) events.push({ type: 'tool_call_start', index: idx, id: cur.id, name: cur.name })
        if (tc.function?.arguments) {
          cur.args += tc.function.arguments
          events.push({ type: 'tool_call_delta', index: idx, argsJsonDelta: tc.function.arguments })
        }
      }
      return events
    },
  }
}
