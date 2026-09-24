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
      permission: new PermissionManager({ allow: { read_file: { whole: true, patterns: [] } }, reject: {}, ask: {} }),
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
      permission: new PermissionManager({ allow: { read_file: { whole: true, patterns: [] } }, reject: {}, ask: {} }),
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
      permission: new PermissionManager({ allow: { read_file: { whole: true, patterns: [] } }, reject: {}, ask: {} }),
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

  it('thinking 与 assistant 严格对齐：正常轮每 assistant 一条；非 assistant 返回不产生 thinking 条目', async () => {
    // 正常路径：reasoning 开启 → 每条 assistant 对应一条 thinking。
    const okClient = fakeClient(() => [{ type: 'done', message: { role: 'assistant', content: 'ok' }, reasoning: '我想一下' }])
    const okLoop = new AgentLoop(baseServices({}))
    const ok = await okLoop.run(baseTurn({ client: okClient, reasoning: true }))
    expect(ok.error).toBeUndefined()
    expect(ok.thinking).toEqual([{ text: '我想一下' }])

    // 对齐缺口回归：模型返回非 assistant 消息 → 角色断言抛错。thinking.push 在断言【之后】，
    // 不会先多 push 一条造成「thinking 有而 history 无对应 assistant」的错位（resume 恢复链按序消费会张冠李戴）。
    const badClient = fakeClient(() => [{ type: 'done', message: { role: 'user', content: '异常返回' }, reasoning: '思考了' }])
    const badLoop = new AgentLoop(baseServices({}))
    const bad = await badLoop.run(baseTurn({ client: badClient, reasoning: true }))
    expect(bad.error).toContain('assistant')
    expect(bad.thinking).toHaveLength(0)
  })

  it('自动压缩中取消：AbortError 归一为 cancel（不误报 error、不卡死 compacting）', async () => {
    // 压缩器挂起直到 signal abort——模拟「压缩期间用户取消」（AbortError 从 compactor 直抛到 loop 顶层 catch）。
    const compactor = new Compactor((_messages, signal) => {
      return new Promise<string>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    })
    const machine = new StateMachine('idle')
    const events: unknown[] = []
    const loop = new AgentLoop(baseServices({ machine, compactor, emit: (e) => events.push(e) }))
    // windowTokens=1 + 非空 context：必达压缩阈值。⚠️ context 不能为空——Compactor 对空 context
    // 短路返回（不走 summarize），压缩器挂不起来，abort 就打不中压缩在飞窗口。
    const controller = new AbortController()
    const running = loop.run(baseTurn({
      context: [{ role: 'user', content: '这是一段足够长的上下文内容用于触发自动压缩' }],
      windowTokens: 1,
      signal: controller.signal,
    }))
    const deadline = Date.now() + 2000
    while (machine.state !== 'compacting' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
    expect(machine.state).toBe('compacting') // 前置确认：确实卡在压缩态
    controller.abort()

    const result = await running
    // catch 补迁移：compacting → cancelled（旧实现无迁移，机卡死在 compacting）。
    expect(result.cancelled).toBe(true)
    expect(result.error).toBeUndefined() // 取消不被误报为 error
    expect(machine.state).toBe('cancelled')
    expect(events.some((e) => (e as { type: string }).type === 'state'
      && (e as { from: string }).from === 'compacting' && (e as { to: string }).to === 'cancelled')).toBe(true)
  })
})
