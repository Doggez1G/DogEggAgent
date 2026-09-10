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
    // tool_call_start 必须携带真实工具名——loop 据此发 tool_pending（空名字会让 UI 无法提示）。
    const start = events.find((e) => e.type === 'tool_call_start') as { name: string; id: string }
    expect(start.name).toBe('read_file')
    expect(start.id).toBe('call_1')
    const end = events.find((e) => e.type === 'tool_call_end') as { name: string; arguments: string }
    expect(end.name).toBe('read_file')
    expect(end.arguments).toBe('{"path":"a.ts"}')
  })

  it('carries tool name in tool_call_start when name arrives with first delta', () => {
    const p = createOpenAiStreamParser()
    // name 与 arguments 同分片到达（OpenAI 兼容端点的常见形状）——start 事件仍须带 name。
    const events = p.feed(sse({ tool_calls: [{ index: 0, id: 'call_9', function: { name: 'shell', arguments: '{"command"' } }] }))
    const start = events.find((e) => e.type === 'tool_call_start') as { name: string; id: string }
    expect(start.name).toBe('shell')
    expect(start.id).toBe('call_9')
    const delta = events.find((e) => e.type === 'tool_call_delta') as { argsJsonDelta: string }
    expect(delta.argsJsonDelta).toBe('{"command"')
  })

  it('emits thought deltas for reasoning', () => {
    const p = createOpenAiStreamParser()
    const events = [...p.feed(sse({ reasoning_content: '思考中' })), ...p.feed(done)]
    expect(events.some((e) => e.type === 'thought_delta')).toBe(true)
  })
})
describe('usage 捕获（stream_options.include_usage）', () => {
  it('末尾 chunk 的 usage 随 done 事件下发并归一为 camelCase', () => {
    const parser = createOpenAiStreamParser()
    const events = [
      ...parser.feed('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })),
      ...parser.feed('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } })),
      ...parser.feed('data: [DONE]'),
    ]
    const done = events.find((e) => e.type === 'done')
    expect(done && 'usage' in done ? done.usage : undefined).toEqual({ promptTokens: 120, completionTokens: 30, totalTokens: 150 })
  })

  it('无 usage chunk 时 done 不带 usage 字段', () => {
    const parser = createOpenAiStreamParser()
    const events = [
      ...parser.feed('data: ' + JSON.stringify({ choices: [{ delta: { content: 'x' } }] })),
      ...parser.feed('data: [DONE]'),
    ]
    const done = events.find((e) => e.type === 'done')
    expect(done && 'usage' in done).toBe(false)
  })
})
