import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { runLoop } from '../../src/loop'
import type { LoopDeps, LoopResult } from '../../src/loop'
import { PermissionManager } from '../../src/permission'
import { ReadFileTool } from '../../src/tools'
import type { LlmStreamEvent } from '../../src/llm/types'

const dir = mkdtempSync(join(tmpdir(), 'dogegg-loop-'))
writeFileSync(join(dir, 'a.txt'), 'hi')

// 伪 adapter：脚本返回事件序列，含 done（最终 message）；其余事件转发给 emit。
// 返回 ChatResult { message, reasoning? }（与真实 adapter 一致）。
function fakeAdapter(script: (messages: unknown[]) => LlmStreamEvent[]): unknown {
  return {
    async chat(_req: unknown, _signal: unknown, emit: (e: LlmStreamEvent) => void) {
      const events = script([])
      let message: unknown = null
      let reasoning: string | undefined
      for (const e of events) {
        if (e.type === 'done') { message = (e as { message: unknown }).message; reasoning = (e as { reasoning?: string }).reasoning }
        else emit(e)
      }
      return { message, reasoning }
    },
  }
}

// 最小 LoopDeps：填齐新签名（context 替代 history、新增 summarize）。
function baseDeps(overrides: Partial<LoopDeps>): LoopDeps {
  return {
    client: fakeAdapter(() => [{ type: 'done', message: { role: 'assistant', content: 'ok' } }]) as LoopDeps['client'],
    model: 'm', maxOutput: 10, maxRetries: 0, reasoning: false,
    context: [], tools: [], systemPrompt: 's', windowTokens: 100000, maxIterations: 10,
    permission: new PermissionManager({ allow: [], reject: [], ask: [] }),
    cwd: dir, shellProgram: undefined, signal: new AbortController().signal,
    emit: () => {}, requestPermission: async () => 'allow_once', checkCancelled: () => false,
    trans: () => {},
    summarize: async () => '',
    ...overrides,
  }
}

describe('runLoop', () => {
  it('执行工具后返回最终答案', async () => {
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

    const events: unknown[] = []
    const result: LoopResult = await runLoop(baseDeps({
      client: adapter as LoopDeps['client'],
      tools: [new ReadFileTool()],
      permission: new PermissionManager({ allow: ['read_file'], reject: [], ask: [] }),
      emit: (e) => events.push(e),
    }))

    expect(events.some((e) => (e as { type: string }).type === 'tool_start')).toBe(true)
    expect(events.some((e) => (e as { type: string }).type === 'tool_end')).toBe(true)
    // R1：newMessages 含本轮产生的 assistant + tool 消息
    expect(result.newMessages.some((m) => m.role === 'tool')).toBe(true)
    expect(result.context.at(-1)).toMatchObject({ role: 'assistant', content: 'done' })
  })

  it('把初始 context（含 user 消息）传给模型', async () => {
    let received: { role: string; content: string | null }[] = []
    const adapter = { async chat(req: { messages: { role: string; content: string | null }[] }) { received = req.messages; return { message: { role: 'assistant', content: 'ok' } } } }

    const result = await runLoop(baseDeps({
      client: adapter as unknown as LoopDeps['client'],
      context: [{ role: 'user', content: '帮我修 bug' }],
    }))

    expect(received.some((m) => m.role === 'user' && m.content === '帮我修 bug')).toBe(true)
    // context 保留 user 消息 + 新增 assistant
    expect(result.context[0]).toMatchObject({ role: 'user', content: '帮我修 bug' })
  })
})
