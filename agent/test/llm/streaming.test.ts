import { describe, it, expect } from 'vitest'
import { createOpenAiStreamParser } from '../../src/llm'

// 用 JSON.stringify 构造 SSE 行，避免手写转义出错。
const sse = (delta: any) => `data: ${JSON.stringify({ choices: [{ delta }] })}`
const done = 'data: [DONE]'

describe('openai stream parser', () => {
  it('emits text deltas and assembles content', () => {
    const p = createOpenAiStreamParser()
    const events = [
      ...p.feed(sse({ role: 'assistant' })),
      ...p.feed(sse({ content: 'Hello' })),
      ...p.feed(sse({ content: ' world' })),
      ...p.feed(done),
    ]
    const last = events.find((e) => e.type === 'done')!
    expect(last.type).toBe('done')
    const msg = (last as { message: any }).message
    expect(msg.content).toBe('Hello world')
  })

  it('assembles tool call arguments across deltas', () => {
    const p = createOpenAiStreamParser()
    const events = [
      ...p.feed(sse({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } }] })),
      ...p.feed(sse({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] })),
      ...p.feed(sse({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] })),
      ...p.feed(done),
    ]
    const last = events.find((e) => e.type === 'done') as { message: any }
    expect(last.message.tool_calls[0].function.arguments).toBe('{"path":"a.ts"}')
    expect(events.some((e) => e.type === 'tool_call_start')).toBe(true)
    const end = events.find((e) => e.type === 'tool_call_end') as { name: string; arguments: string }
    expect(end.name).toBe('read_file')
    expect(end.arguments).toBe('{"path":"a.ts"}')
  })

  it('emits thought deltas for reasoning', () => {
    const p = createOpenAiStreamParser()
    const events = [...p.feed(sse({ reasoning_content: '思考中' })), ...p.feed(done)]
    expect(events.some((e) => e.type === 'thought_delta')).toBe(true)
  })
})