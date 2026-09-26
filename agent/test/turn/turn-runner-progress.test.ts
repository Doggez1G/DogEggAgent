import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { z } from 'zod'
import { TurnRunner, AgentLoop, Compactor, StateMachine } from '../../src/turn'
import type { AgentContext } from '../../src/ctx'
import { Conversation, SessionStore } from '../../src/session'
import { ConfigStore } from '../../src/config'
import { ContextAssembler } from '../../src/context'
import { PermissionManager } from '../../src/permission'
import { ReadFileTool, ToolRegistry } from '../../src/tools'
import type { Tool } from '../../src/tools'
import { BusyGate } from '../../src/shared'
import type { AgentToUiMessage, Message } from '@dogegg/bridge'
import type { LlmClient, LlmStreamEvent } from '../../src/llm'

// ─────────────────────────────────────────────────────────────────────────────
// 轮次进行中进度（onProgress → 检查点 / 中途标题 / live context）集成测试（白盒构造 TurnRunner）。
// 场景对应「用户实测」：长工具任务期间崩溃/断电，轮末才落盘会丢掉全部已完成进度——
// 检查点让 sessionsDir 下的会话文件在轮中途就含已完成的 tool 消息。
// 另覆盖批次3：P1-6 检查点配对毒化修补 / Conversation.load 兜底修补 / P2-2 finally 覆盖 /
// P2-23 live 现场（partial + runningTool）/ P2-1 轮中标题不落盘。
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

// 测试用慢工具：execute 挂起直到 release()——制造「工具执行中」的稳定观察窗口
//（检查点毒化窗口 / runningTool 现场 / 轮中标题竞态都靠它钉住时刻）。
function makeSlowTool(name = 'slow_probe'): { tool: Tool; release: () => void } {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const tool: Tool = {
    name,
    description: '测试用慢工具（手动放行）',
    schema: z.object({}),
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      await gate
      return { content: 'slow-done' }
    },
  }
  return { tool, release: () => release() }
}

function makeRunner(opts: { checkpointMs?: number; client: LlmClient; emit?: (m: AgentToUiMessage) => void; registry?: ToolRegistry }) {
  const cwd = tmp()
  writeFileSync(join(cwd, 'a.txt'), 'hi')
  const sessionsDir = tmp()
  const registry = opts.registry ?? new ToolRegistry([new ReadFileTool()])
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
    // emit 可注入（P2-2 测试用：模拟 emit 链路抛错，如磁盘满）。
    emit: opts.emit ?? ((m) => events.push(m)),
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

// 伪 client（标题竞态专用）：call 1 → tool_calls；call 2 是 generateTitle 的离线调用（独立延迟）；
// call 3 起是主轮次的最终回答（独立延迟）。两段延迟分开控制才能把「标题已生成、轮次仍在飞行」
// 的窗口稳定钉住（标题早于轮末完成 → setTitle 发生在 busy 期）。
function titleRaceClient(titleText: string, titleDelayMs: number, finalDelayMs: number): LlmClient {
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
      if (call === 2) {
        await new Promise((r) => setTimeout(r, titleDelayMs))
        return { message: { role: 'assistant', content: titleText } }
      }
      await new Promise((r) => setTimeout(r, finalDelayMs))
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

// ─────────────────────────────────────────────────────────────────────────────
// P1-6 检查点配对毒化：assistant push 后立即 onProgress，检查点可能以「带 tool_calls 且无
// tool 结果」的 assistant 结尾——崩溃恢复后下一轮请求被严格 API 拒 400。落盘前必须修补配对。
// ─────────────────────────────────────────────────────────────────────────────
describe('P1-6 检查点配对毒化', () => {
  it('工具执行中触发检查点：落盘文件的 history 尾部配对完整（assistant+tool），context 同步修补', async () => {
    const { tool, release } = makeSlowTool()
    // client：call 1 返回带 tool_calls 的 assistant（此刻慢工具尚未执行完——检查点正落在
    // 「assistant 已 push、tool 结果未回填」的毒化窗口内）。
    let call = 0
    const client: LlmClient = {
      async chat() {
        call++
        if (call === 1) {
          return {
            message: {
              role: 'assistant', content: null,
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'slow_probe', arguments: '{}' } }],
            } as unknown as Message,
          }
        }
        return { message: { role: 'assistant', content: 'final-2' } }
      },
    } as unknown as LlmClient
    const { runner, sessionsDir, params } = makeRunner({ checkpointMs: 0, client, registry: new ToolRegistry([tool]) })

    const done = runner.submit('跑慢工具', params)
    // 等首个检查点落盘（assistant push 后立即触发）。慢工具未放行 → 文件稳定停留在这个毒化窗口的落盘态。
    await waitFor(() => {
      try {
        const raw = readSessionFile(sessionsDir)
        const history = (raw.history as { role: string; tool_calls?: unknown[] }[]) ?? []
        return history.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0)
      } catch { return false }
    }, '检查点文件含带 tool_calls 的 assistant')

    // 决定性断言：带 tool_calls 的 assistant 之后紧跟同 id 的配对 tool 消息（修补追加的
    // 「会话在工具执行中被中断」回执）——恢复后下一轮请求不会被严格 API 拒 400。
    const raw = readSessionFile(sessionsDir)
    const history = raw.history as { role: string; tool_calls?: { id: string }[]; tool_call_id?: string; content?: unknown }[]
    const assistantIdx = history.findIndex((m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0)
    expect(assistantIdx).toBeGreaterThanOrEqual(0)
    for (const tc of history[assistantIdx]!.tool_calls ?? []) {
      const pair = history.slice(assistantIdx + 1).find((m) => m.role === 'tool' && m.tool_call_id === tc.id)
      expect(pair).toBeDefined()
    }
    // context 与 history 尾部同构（R1）：同样补齐了配对消息。
    const ctx = raw.context as { role: string; tool_call_id?: string }[]
    expect(ctx.some((m) => m.role === 'tool' && m.tool_call_id === 'c1')).toBe(true)

    // 放行工具 → 轮次正常收口：轮末以内存真相覆盖同一文件——真实 tool 结果在案，
    // 且 c1 只有一条 tool 消息（修补只存在于落盘视图，未污染内存真相产生重复）。
    release()
    await done
    const final = readSessionFile(sessionsDir)
    const finalHistory = final.history as { role: string; tool_call_id?: string; content?: unknown }[]
    expect(finalHistory.filter((m) => m.role === 'tool' && m.tool_call_id === 'c1')).toHaveLength(1)
    expect(finalHistory.some((m) => m.role === 'tool' && m.content === 'slow-done')).toBe(true)
  })

  it('Conversation.load 载入含未配对尾部的历史：内存中被修补（旧版本毒化文件兜底）', () => {
    const unpaired: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c9', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] } as unknown as Message,
    ]
    const conversation = new Conversation('/tmp')
    conversation.load({
      id: 's-load',
      history: unpaired,
      context: unpaired,
      sessionPermissions: [],
      usage: { promptTokens: 1, completionTokens: 1, turns: 1 },
      compactions: 0,
      cwd: '/tmp',
      thinking: [],
    })
    // history 与 context 尾部都被补上同 id 的 tool 消息（「会话在工具执行中被中断」归因）。
    expect(conversation.getHistory().at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c9' })
    expect(conversation.getContext().at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c9' })
    // 入参快照数组未被改动（纯函数语义）。
    expect(unpaired).toHaveLength(2)

    // 已配对的历史原样保留（修补只作用于未配对尾部，不多不少）。
    const okHistory: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] } as unknown as Message,
      { role: 'tool', tool_call_id: 'c1', content: 'x' },
    ]
    const paired = new Conversation('/tmp')
    paired.load({
      id: 's-paired', history: okHistory, context: okHistory, sessionPermissions: [],
      usage: { promptTokens: 0, completionTokens: 0, turns: 0 }, compactions: 0, cwd: '/tmp', thinking: [],
    })
    expect(paired.getHistory()).toHaveLength(3)
    expect(paired.getHistory().at(-1)).toMatchObject({ role: 'tool', content: 'x' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// P2-2 finally 覆盖：gate.enter() 之后的全部段（pushUserMessage / emit(user) / loop.run）
// 必须在 try 覆盖内——emit 链路一抛（磁盘满等）finally 照常执行，gate 回到空闲，进程不锁死。
// ─────────────────────────────────────────────────────────────────────────────
describe('P2-2 finally 覆盖', () => {
  it('emit 在 try 覆盖段抛错：finally 照常清理，gate 回到空闲，下一轮可正常提交', async () => {
    let userEmits = 0
    const { runner, conversation, gate, params } = makeRunner({
      client: scriptedClient(),
      // 模拟 emit 链路故障：仅【第一次】user 消息事件（try 内第一段）抛错——模拟瞬时磁盘满。
      // 之后的 emit 恢复正常，让第二轮能完整走通（验证 gate 未被锁死）。
      emit: (m) => {
        if (m.type === 'message' && m.role === 'user') {
          userEmits++
          if (userEmits === 1) throw new Error('磁盘已满（模拟 appendFileSync 失败）')
        }
      },
    })
    // 旧实现这两段裸奔在 try 之外：emit 一抛 submit 直接 reject、finally 不执行 → gate 永久 busy。
    await runner.submit('第一问', params)
    expect(gate.busy).toBe(false)
    // user 消息已在抛错前 push 进工作集（R1 双写先于 emit）。
    expect(conversation.getHistory().some((m) => m.role === 'user' && m.content === '第一问')).toBe(true)

    // gate 已释放：下一轮提交正常走完（不冻结），结束后同样归还占用。
    await runner.submit('第二问', params)
    expect(gate.busy).toBe(false)
    expect(conversation.getHistory().some((m) => m.role === 'assistant')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// P2-23 live 现场：运行中（busy）快照重发要能恢复流式 partial 与进行中工具块。
// getLiveTurn 的 partial/runningTool 以 loop 实时现场为准（长工具执行中 / 流式生成中 onProgress
// 不触发，只有 loop 直读才拿得到最新值）。
// ─────────────────────────────────────────────────────────────────────────────
describe('P2-23 live 现场', () => {
  it('运行中 getLiveTurn 暴露进行中工具与流式 partial；轮末清空', async () => {
    const { tool, release } = makeSlowTool()
    let call = 0
    const client: LlmClient = {
      async chat(_req: unknown, _signal: AbortSignal, emit: (e: LlmStreamEvent) => void) {
        call++
        if (call === 1) {
          // 流式文本随 tool_calls 一起产出 → assistant 定稿时 partial 应被清零。
          emit({ type: 'text_delta', text: '正在查' } as LlmStreamEvent)
          return {
            message: {
              role: 'assistant', content: null,
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'slow_probe', arguments: '{}' } }],
            } as unknown as Message,
          }
        }
        // call 2：先吐正文 delta 再挂起——制造「流式生成中」的稳定观察窗口。
        emit({ type: 'text_delta', text: '轮中流式' } as LlmStreamEvent)
        await new Promise((r) => setTimeout(r, 300))
        return { message: { role: 'assistant', content: 'final-2' } }
      },
    } as unknown as LlmClient
    const { runner, conversation, params } = makeRunner({ checkpointMs: 60000, client, registry: new ToolRegistry([tool]) })
    conversation.setTitle('测试会话') // 排除轮中标题触发的干扰

    const done = runner.submit('跑', params)

    // 窗口 1：工具执行中（tool_start 已发、tool_end 未到）——runningTool 在案。
    await waitFor(() => runner.getLiveTurn()?.runningTool?.name === 'slow_probe', 'runningTool 现场')
    expect(runner.getLiveTurn()!.runningTool).toMatchObject({ id: 'c1', name: 'slow_probe', input: {} })
    // partial 已随 assistant 定稿清零（call 1 的「正在查」不残留）。
    expect(runner.getLiveTurn()!.partial).toBeFalsy()

    // 窗口 2：工具完成、第 2 次模型调用流式中——partial 累积、runningTool 已清。
    release()
    await waitFor(() => runner.getLiveTurn()?.partial === '轮中流式', 'partial 现场')
    expect(runner.getLiveTurn()!.runningTool).toBeUndefined()

    // 轮末收口：live 现场清空（空闲期无现场可补）。
    await done
    expect(runner.getLiveTurn()).toBeNull()
    expect(runner.getLiveContext()).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// P2-1 轮中标题写回：busy 期间 setTitle 只进内存、不落盘——否则 snapshotFull（轮前工作集）
// 会把检查点刚写的轮内进度回退成旧态。标题随检查点/轮末 saveOrNotice 一并持久化。
// ─────────────────────────────────────────────────────────────────────────────
describe('P2-1 轮中标题不落盘', () => {
  it('轮中标题生成完成：会话文件未被旧快照覆盖（轮内 tool 消息仍在），轮末带上标题', async () => {
    // 标题 100ms 生成完成（轮中），主轮次最终回答 600ms——标题到达时轮次必然仍在飞行。
    const { runner, sessionsDir, events, params, gate } = makeRunner({ checkpointMs: 0, client: titleRaceClient('轮中标题', 100, 600) })

    const done = runner.submit('读一下 a.txt', params)
    await waitFor(() => events.some((e) => e.type === 'notice' && e.text.includes('已自动生成会话标题')), '标题 notice')
    // 前置确认：标题到达时轮次确实还在飞行（否则用例失去「轮中」前提）。
    expect(gate.busy).toBe(true)

    // 决定性断言：落盘文件未被 snapshotFull 旧快照回退——轮内 tool 消息仍在。
    // （旧实现此刻立即 save：history 只有 user 消息，检查点的轮内进度被整段抹掉。）
    const raw = readSessionFile(sessionsDir)
    const history = raw.history as { role: string; content?: unknown }[]
    expect(history.some((m) => m.role === 'tool' && m.content === 'hi')).toBe(true)

    await done
    // 轮末 saveOrNotice 携带标题（轮中 setTitle 进内存，检查点与轮末保存都会带上）。
    const final = readSessionFile(sessionsDir)
    expect(final.title).toBe('轮中标题')
    expect((final.history as { role: string; content?: unknown }[]).some((m) => m.role === 'assistant' && m.content === 'final-3')).toBe(true)
  })
})
