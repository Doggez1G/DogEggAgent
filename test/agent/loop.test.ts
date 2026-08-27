import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { runLoop } from '../../src/agent/loop'
import { PermissionManager } from '../../src/agent/permission'
import { readFileTool } from '../../src/tools/read_file'
import type { LlmStreamEvent } from '../../src/llm/types'

const dir = mkdtempSync(join(tmpdir(), 'dogegg-loop-'))
writeFileSync(join(dir, 'a.txt'), 'hi')

// 伪 adapter：脚本返回事件序列，含 done（最终 message）；其余事件转发给 emit。
function fakeAdapter(script: (messages: unknown[]) => LlmStreamEvent[]): unknown {
  return {
    async chat(_req: unknown, _signal: unknown, emit: (e: LlmStreamEvent) => void) {
      const events = script([])
      let message: unknown = null
      for (const e of events) {
        if (e.type === 'done') message = (e as { message: unknown }).message
        else emit(e)
      }
      return message
    },
  }
}

describe('runLoop', () => {
  it('executes a tool then returns the final answer', async () => {
    let call = 0
    const adapter = fakeAdapter(() => {
      call++
      if (call === 1) {
        return [
          { type: 'tool_call_start', index: 0, id: 'c1', name: 'read_file' },
          { type: 'tool_call_delta', index: 0, argsJsonDelta: '{"path":"a.txt"}' },
          { type: 'done', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] } },
        ]
      }
      return [
        { type: 'text_delta', text: 'done' },
        { type: 'done', message: { role: 'assistant', content: 'done' } },
      ]
    })

    const events: any[] = []
    const result = await runLoop({
      adapter: adapter as any,
      providerBaseURL: 'http://x', apiKey: 'k', model: 'm', maxOutput: 10, maxRetries: 0, reasoning: false,
      history: [], tools: [readFileTool], systemPrompt: 's', windowTokens: 100000, maxIterations: 10,
      permission: new PermissionManager({ allow: ['read_file'], reject: [], ask: [] }),
      cwd: dir,
      shellProgram: undefined,
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
      requestPermission: async () => 'allow_once',
      checkCancelled: () => false,
    })

    expect(events.some((e) => e.type === 'tool_start')).toBe(true)
    expect(events.some((e) => e.type === 'tool_end')).toBe(true)
    expect(result.some((m) => m.role === 'tool')).toBe(true)
    expect(result[result.length - 1]).toMatchObject({ role: 'assistant', content: 'done' })
  })

  it('passes the initial history (incl. user message) to the model', async () => {
    let received: { role: string; content: string | null }[] = []
    const adapter = { async chat(req: { messages: { role: string; content: string | null }[] }) { received = req.messages; return { role: 'assistant', content: 'ok' } } }

    const result = await runLoop({
      adapter: adapter as any,
      providerBaseURL: 'http://x', apiKey: 'k', model: 'm', maxOutput: 10, maxRetries: 0, reasoning: false,
      history: [{ role: 'user', content: '帮我修 bug' }], tools: [], systemPrompt: 's', windowTokens: 100000, maxIterations: 10,
      permission: new PermissionManager({ allow: [], reject: [], ask: [] }),
      cwd: dir,
      shellProgram: undefined,
      signal: new AbortController().signal,
      emit: () => {},
      requestPermission: async () => 'allow_once',
      checkCancelled: () => false,
    })

    expect(received.some((m) => m.role === 'user' && m.content === '帮我修 bug')).toBe(true)
    expect(result[0]).toMatchObject({ role: 'user', content: '帮我修 bug' })
  })
})