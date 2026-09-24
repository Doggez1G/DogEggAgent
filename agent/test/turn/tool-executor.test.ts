import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { ToolExecutor } from '../../src/turn'
import type { TransitionInput } from '../../src/turn'
import type { Tool } from '../../src/tools'
import { ToolRegistry } from '../../src/tools'
import { PermissionManager } from '../../src/permission'
import type { AgentToUiMessage } from '@dogegg/bridge'

// ─────────────────────────────────────────────────────────────────────────────
// ToolExecutor 回执治理测试：
// 1. error/异常路径的回执也必须过 truncate（错误文本长度不可控——MCP server 抛什么 agent 管不着）；
// 2. 参数校验失败回执拼 zod issues 摘要（前 2 条 path+message），让模型能自纠。
// ─────────────────────────────────────────────────────────────────────────────

// 假工具：schema 与 execute 由用例注入。
function makeTool(name: string, schema: z.ZodTypeAny, execute: Tool['execute']): Tool {
  return { name, description: '', schema, parameters: { type: 'object', properties: {} }, execute }
}

// 最小执行器 harness：工具配置为整工具 allow（绕开审批，聚焦回执本身）。
function makeExecutor(tool: Tool) {
  const events: AgentToUiMessage[] = []
  const transitions: TransitionInput[] = []
  const executor = new ToolExecutor({
    registry: new ToolRegistry([tool]),
    permission: new PermissionManager({ allow: { [tool.name]: { whole: true, patterns: [] } }, reject: {}, ask: {} }),
    emit: (e) => events.push(e),
    requestPermission: async () => ({ decision: 'allow_once' as const }),
  })
  const call = (argsJson: string) =>
    executor.execute(
      { id: 'c1', function: { name: tool.name, arguments: argsJson } },
      { cwd: '.', signal: new AbortController().signal },
      { isLast: true, reasoning: false },
      (input) => transitions.push(input),
    )
  return { events, transitions, call }
}

describe('ToolExecutor 回执治理', () => {
  it('工具抛异常：回执过 truncate（不再整段回填模型）', async () => {
    const huge = 'x'.repeat(9000)
    const { events, call } = makeExecutor(makeTool('boom', z.object({}), async () => { throw new Error(huge) }))
    const step = await call('{}')
    const toolEnd = events.find((e) => e.type === 'tool_end') as { output: string; error: string }
    expect(toolEnd.output).toContain('…（输出过长，已截断）')
    expect(toolEnd.output.length).toBeLessThan(huge.length)
    // 回填模型的 tool 消息与 UI 回执同源同长。
    expect(step.toolMessage.content).toBe(toolEnd.output)
  })

  it('{error} 结果路径：回执过 truncate；短错误原样保留', async () => {
    const { events, call } = makeExecutor(makeTool('errtool', z.object({}), async () => ({ error: 'y'.repeat(9000) })))
    await call('{}')
    const toolEnd = events.find((e) => e.type === 'tool_end') as { output: string }
    expect(toolEnd.output).toContain('ERROR: ')
    expect(toolEnd.output).toContain('…（输出过长，已截断）')
    expect(toolEnd.output.length).toBeLessThan(8100)

    // 短错误不受影响（truncate 对不超限文本恒等）。
    const short = makeExecutor(makeTool('errtool', z.object({}), async () => ({ error: 'boom' })))
    const step = await short.call('{}')
    expect(step.toolMessage.content).toBe('ERROR: boom')
  })

  it('参数校验失败：回执拼 zod issues 摘要（path+message）', async () => {
    const { events, transitions, call } = makeExecutor(
      makeTool('strict', z.object({ path: z.string().min(5) }), async () => ({ content: '不应执行' })),
    )
    const step = await call('{"path":"ab"}')
    const toolEnd = events.find((e) => e.type === 'tool_end') as { output: string }
    expect(toolEnd.output).toContain('参数校验失败')
    expect(toolEnd.output).toContain('path') // issue 的 path 进了回执——模型据此自纠
    expect(step.toolMessage.content).toBe(toolEnd.output)
    // 校验失败走 reject 迁移（isLast=true → reject 而非 tool_done）。
    expect(transitions).toEqual([])
    expect(step.transitionInput.kind).toBe('reject')
  })

  it('多条 zod issues：只取前 2 条', async () => {
    const { events, call } = makeExecutor(
      makeTool('strict3', z.object({ a: z.string().min(10), b: z.number(), c: z.boolean() }), async () => ({ content: 'x' })),
    )
    await call('{"a":"x","b":"not-num","c":1}')
    const toolEnd = events.find((e) => e.type === 'tool_end') as { output: string }
    expect(toolEnd.output).toContain('a:')
    expect(toolEnd.output).toContain('b:')
    expect(toolEnd.output).not.toContain('c:')
  })

  it('JSON 损坏（非 ZodError）：维持原文案', async () => {
    const { events, call } = makeExecutor(makeTool('strict', z.object({}), async () => ({ content: 'x' })))
    const step = await call('{oops')
    const toolEnd = events.find((e) => e.type === 'tool_end') as { output: string }
    expect(step.toolMessage.content).toBe('参数校验失败')
    expect(toolEnd.output).toBe('参数校验失败')
  })
})
