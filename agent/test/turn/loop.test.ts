import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { AgentLoop, Compactor, StateMachine } from '../../src/turn'
import type { LoopServices, LoopResult, TurnInput } from '../../src/turn'
import { PermissionManager } from '../../src/permission'
import { ReadFileTool, ToolRegistry } from '../../src/tools'
import type { LlmClient, LlmStreamEvent } from '../../src/llm/types'

const dir = mkdtempSync(join(tmpdir(), 'dogegg-loop-'))
writeFileSync(join(dir, 'a.txt'), 'hi')

// 伪 client：脚本返回事件序列，含 done（最终 message）；其余事件转发给 emit。
// 返回 ChatResult { message, reasoning? }（与真实 client 一致）。
function fakeClient(script: () => LlmStreamEvent[]): LlmClient {
  return {
    async chat(_req: unknown, _signal: AbortSignal, emit: (e: LlmStreamEvent) => void) {
      let message: unknown = null
      let reasoning: string | undefined
      for (const e of script()) {
        if (e.type === 'done') { message = (e as { message: unknown }).message; reasoning = (e as { reasoning?: string }).reasoning }
        else emit(e)
      }
      return { message, reasoning }
    },
  } as unknown as LlmClient
}

// 最小 LoopServices：构造期稳定服务。
function baseServices(overrides: Partial<LoopServices>): LoopServices {
  return {
    registry: new ToolRegistry(),
    machine: new StateMachine('idle'),
    compactor: new Compactor(async () => '摘要'),
    emit: () => {},
    requestPermission: async () => ({ decision: 'allow_once' as const }),
    checkCancelled: () => false,
    ...overrides,
  }
}

// 最小 TurnInput：单轮参数。
function baseTurn(overrides: Partial<TurnInput>): TurnInput {
  return {
    client: fakeClient(() => [{ type: 'done', message: { role: 'assistant', content: 'ok' } }]),
    model: 'm', maxOutput: 10, maxRetries: 0, reasoning: false,
    context: [], systemPrompt: 's', windowTokens: 100000,
    permission: new PermissionManager({ allow: {}, reject: {}, ask: {} }),
    maxIterations: 10,
    cwd: dir, shellProgram: undefined, signal: new AbortController().signal,
    ...overrides,
  }
}

describe('AgentLoop', () => {
  it('执行工具后返回最终答案', async () => {
    let call = 0
    const client = fakeClient(() => {
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
    const loop = new AgentLoop(baseServices({
      registry: new ToolRegistry([new ReadFileTool()]),
      emit: (e) => events.push(e),
    }))
    const result: LoopResult = await loop.run(baseTurn({
      client,
      permission: new PermissionManager({ allow: { read_file: [] }, reject: {}, ask: {} }),
    }))

    expect(events.some((e) => (e as { type: string }).type === 'tool_start')).toBe(true)
    expect(events.some((e) => (e as { type: string }).type === 'tool_end')).toBe(true)
    // R1：newMessages 含本轮产生的 assistant + tool 消息
    expect(result.newMessages.some((m) => m.role === 'tool')).toBe(true)
    expect(result.context.at(-1)).toMatchObject({ role: 'assistant', content: 'done' })
  })

  it('maxIterations=-1（无限）：连续多轮工具调用不受上限影响', async () => {
    let call = 0
    const client = fakeClient(() => {
      call++
      if (call <= 5) {
        return [
          { type: 'tool_call_start', index: 0, id: `c${call}`, name: 'read_file' },
          { type: 'tool_call_delta', index: 0, argsJsonDelta: '{"path":"a.txt"}' },
          { type: 'done', message: { role: 'assistant', content: null, tool_calls: [{ id: `c${call}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] } },
        ]
      }
      return [{ type: 'done', message: { role: 'assistant', content: 'done' } }]
    })
    const loop = new AgentLoop(baseServices({
      registry: new ToolRegistry([new ReadFileTool()]),
    }))
    const result = await loop.run(baseTurn({
      client,
      permission: new PermissionManager({ allow: { read_file: [] }, reject: {}, ask: {} }),
      maxIterations: -1,
    }))
    expect(result.error).toBeUndefined()
    expect(result.context.filter((m) => m.role === 'tool')).toHaveLength(5)
  })

  it('maxIterations 有限时达到上限报错', async () => {
    const client = fakeClient(() => [
      { type: 'tool_call_start', index: 0, id: 'c1', name: 'read_file' },
      { type: 'tool_call_delta', index: 0, argsJsonDelta: '{"path":"a.txt"}' },
      { type: 'done', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] } },
    ])
    const loop = new AgentLoop(baseServices({
      registry: new ToolRegistry([new ReadFileTool()]),
    }))
    const result = await loop.run(baseTurn({
      client,
      permission: new PermissionManager({ allow: { read_file: [] }, reject: {}, ask: {} }),
      maxIterations: 2,
    }))
    expect(result.error).toContain('maxIterations')
  })

  it('把初始 context（含 user 消息）传给模型', async () => {
    let received: { role: string; content: string | null }[] = []
    const client = { async chat(req: { messages: { role: string; content: string | null }[] }) { received = req.messages; return { message: { role: 'assistant', content: 'ok' } } } }

    const loop = new AgentLoop(baseServices({}))
    const result = await loop.run(baseTurn({
      client: client as unknown as LlmClient,
      context: [{ role: 'user', content: '帮我修 bug' }],
    }))

    expect(received.some((m) => m.role === 'user' && m.content === '帮我修 bug')).toBe(true)
    // context 保留 user 消息 + 新增 assistant
    expect(result.context[0]).toMatchObject({ role: 'user', content: '帮我修 bug' })
  })
})
