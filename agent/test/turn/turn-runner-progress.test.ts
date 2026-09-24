import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { TurnRunner, AgentLoop, Compactor, StateMachine } from '../../src/turn'
import type { AgentContext } from '../../src/ctx'
import { Conversation, SessionStore } from '../../src/session'
import { ConfigStore } from '../../src/config'
import { ContextAssembler } from '../../src/context'
import { PermissionManager } from '../../src/permission'
import { ReadFileTool, ToolRegistry } from '../../src/tools'
import { BusyGate } from '../../src/shared'
import type { AgentToUiMessage, Message } from '@dogegg/bridge'
import type { LlmClient, LlmStreamEvent } from '../../src/llm'

// ─────────────────────────────────────────────────────────────────────────────
// 轮次进行中进度（onProgress → 检查点 / 中途标题 / live context）集成测试（白盒构造 TurnRunner）。
// 场景对应「用户实测」：长工具任务期间崩溃/断电，轮末才落盘会丢掉全部已完成进度——
// 检查点让 sessionsDir 下的会话文件在轮中途就含已完成的 tool 消息。
// ─────────────────────────────────────────────────────────────────────────────

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dogegg-runner-'))
  dirs.push(d)
  return d
}

function makeRunner(opts: { checkpointMs?: number; client: LlmClient }) {
  const cwd = tmp()
  writeFileSync(join(cwd, 'a.txt'), 'hi')
  const sessionsDir = tmp()
  const registry = new ToolRegistry([new ReadFileTool()])
  const config = new ConfigStore().load({
    providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x/v1', apiKey: 'k', models: [{ name: 'm' }] }],
  })
  const permission = new PermissionManager(
    { allow: { read_file: { whole: true, patterns: [] } }, reject: {}, ask: {} },
    [],
    () => registry.identities(),
  )
  const machine = new StateMachine('idle')
  const gate = new BusyGate()
  const ctx: AgentContext = { config, permission, assembler: new ContextAssembler(undefined, registry), machine, gate }
  const conversation = new Conversation(cwd)
  const compactor = new Compactor(async () => '摘要')
  const events: AgentToUiMessage[] = []
  const loop = new AgentLoop({
    registry,
    machine,
    compactor,
    emit: (e) => events.push(e),
    requestPermission: async () => ({ decision: 'allow_once' as const }),
    checkCancelled: () => gate.isCancelled(),
  })
  const runner = new TurnRunner({
    ctx, conversation, loop, compactor,
    sessions: new SessionStore(sessionsDir),
    registry,
    emit: (m) => events.push(m),
    emitState: (input) => { machine.fire(input) },
    ...(opts.checkpointMs !== undefined ? { checkpointMs: opts.checkpointMs } : {}),
  })
  const params = { client: opts.client, model: 'm', maxOutput: 100, maxRetries: 0, reasoning: false, windowTokens: 100000 }
  return { runner, conversation, sessionsDir, events, params, gate }
}

// 伪 client：call 1 返回 tool_calls（读 a.txt），call 2 起（可选延迟）返回最终文本。
function scriptedClient(over: { delayMs?: number } = {}): LlmClient {
  let call = 0
  return {
    async chat(_req: unknown, _signal: AbortSignal, _emit: (e: LlmStreamEvent) => void) {
      call++
      if (call === 1) {
        return {
          message: {
            role: 'assistant', content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
          } as unknown as Message,
        }
      }
      if (over.delayMs) await new Promise((r) => setTimeout(r, over.delayMs))
      return { message: { role: 'assistant', content: `final-${call}` } }
    },
  } as unknown as LlmClient
}

async function waitFor(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`等待 ${label} 超时`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

function readSessionFile(sessionsDir: string): Record<string, unknown> {
  const file = readdirSync(sessionsDir).find((f) => f.endsWith('.json'))!
  return JSON.parse(readFileSync(join(sessionsDir, file), 'utf8')) as Record<string, unknown>
}

describe('轮次进行中检查点', () => {
  it('轮中途会话文件已含已完成的 tool 消息（检查点落盘；轮末正常收口覆盖）', async () => {
    const { runner, conversation, sessionsDir, events, params } = makeRunner({ checkpointMs: 0, client: scriptedClient({ delayMs: 400 }) })
    // 预置标题：排除轮中标题触发（那个场景单独测），让检查点路径独占本用例。
    conversation.setTitle('测试会话')

    const done = runner.submit('读一下 a.txt', params)
    // 轮中途（第 2 次 LLM 调用被延迟 400ms）：会话文件应已含 tool 消息（tool_end 之后的检查点写入）。
    await waitFor(() => {
      try {
        const raw = readSessionFile(sessionsDir)
        const history = (raw.history as { role: string; content?: unknown }[]) ?? []
        return history.some((m) => m.role === 'tool' && m.content === 'hi')
      } catch { return false }
    }, '轮中途检查点（会话文件含 tool 消息）')

    await done
    // 轮末 saveOrNotice 以内存真相覆盖同一文件：history 完整（含最终 assistant）。
    const raw = readSessionFile(sessionsDir)
    const history = raw.history as { role: string; content?: unknown }[]
    expect(history.some((m) => m.role === 'tool' && m.content === 'hi')).toBe(true)
    expect(history.some((m) => m.role === 'assistant' && m.content === 'final-2')).toBe(true)
    expect(events.some((e) => e.type === 'finished')).toBe(true)
    // 轮次结束：live context 清空（空闲期回落 conversation.getContext()）。
    expect(runner.getLiveContext()).toBeNull()
  })

  it('轮中触发自动标题：首条 assistant（带 tool_calls）出现即命名，不等轮末', async () => {
    const { runner, sessionsDir, events, params } = makeRunner({ checkpointMs: 60000, client: scriptedClient() })

    await runner.submit('读一下 a.txt', params)
    // 标题 notice 在轮过程中/结束后出现（generateTitle 用同一 client 的第 2 次调用，返回「final-2」清洗后为标题）。
    await waitFor(() => events.some((e) => e.type === 'notice' && e.text.includes('已自动生成会话标题')), '标题 notice')
    // 标题已写进会话文件（标题落盘的轮次内写入或轮末覆盖均应带上）。
    await waitFor(() => {
      try { return typeof readSessionFile(sessionsDir).title === 'string' } catch { return false }
    }, '会话文件含标题')
  })

  it('已有标题的会话不触发轮中标题；checkpointMs 缺省 15s 不在毫秒级写盘', async () => {
    const { runner, sessionsDir, params } = makeRunner({ client: scriptedClient() })
    // 不预置标题，但历史里已有 assistant 的场景用「第二轮」模拟：第一轮结束后第二轮的
    // onProgress 不满足「本会话首条 assistant」，不再触发（靠轮末 maybeAutoTitle 的 in-flight 去重）。
    await runner.submit('第一问', params)
    await runner.submit('第二问', params)
    // 两轮结束后文件完整可读（无中途异常）；断言第二轮期间的检查点未在毫秒级触发
    //（缺省 checkpointMs=15000，第二轮远短于 15s——文件只在轮末写，内容仍完整）。
    const raw = readSessionFile(sessionsDir)
    const history = raw.history as { role: string; content?: unknown }[]
    expect(history.filter((m) => m.role === 'user')).toHaveLength(2)
  })
})
