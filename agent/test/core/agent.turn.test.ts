import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { Agent } from '../../src/core'
import { loadConfig } from '../../src/config'
import { createChannelPair } from '@dogegg/bridge'
import type { AgentToUiMessage, Message, UiToAgentMessage } from '@dogegg/bridge'
import type { LlmStreamEvent, ProviderAdapter } from '../../src/llm'

// ─────────────────────────────────────────────────────────────────────────────
// Agent 轮次表征测试：重构前的行为基线。全部走 Port 黑盒收发（不摸内部字段），
// 重构（OOP 类化、Agent 拆分）期间本文件必须原样通过——过了即行为未变。
// ─────────────────────────────────────────────────────────────────────────────

function makeConfig(permission = { allow: [] as string[], reject: [] as string[], ask: [] as string[] }) {
  return loadConfig({
    providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x/v1', apiKey: 'k', models: [{ name: 'm' }] }],
    permission,
  })
}

// 伪 adapter：按调用次数返回事件脚本；done 之外的流事件转发给 emit（与真实 adapter 行为一致）。
function fakeAdapter(script: (call: number) => LlmStreamEvent[]): ProviderAdapter {
  let call = 0
  return {
    async chat(_req: unknown, _signal: AbortSignal, emit: (e: LlmStreamEvent) => void) {
      call++
      let message: Message | null = null
      let reasoning: string | undefined
      for (const e of script(call)) {
        if (e.type === 'done') { message = e.message; reasoning = e.reasoning }
        else emit(e)
      }
      return { message: message!, reasoning }
    },
  } as unknown as ProviderAdapter
}

// 挂起直到 abort 的伪 adapter——表征「轮次取消」路径（fetch 被 abort 打断 → AbortError）。
function hangingAdapter(): ProviderAdapter {
  return {
    async chat(_req: unknown, signal: AbortSignal, _emit: (e: LlmStreamEvent) => void) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    },
  } as unknown as ProviderAdapter
}

// 黑盒 harness：Agent 只经 port 收发；events 收集全部下行消息。
function makeAgent(opts: {
  adapter?: ProviderAdapter
  permission?: { allow: string[]; reject: string[]; ask: string[] }
  cwd?: string
  sessionsDir?: string
} = {}) {
  const sessionsDir = opts.sessionsDir ?? mkdtempSync(join(tmpdir(), 'dogegg-turn-'))
  const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), 'dogegg-cwd-'))
  const { agentPort, uiPort } = createChannelPair()
  const events: AgentToUiMessage[] = []
  // eslint-disable-next-line no-new
  new Agent(agentPort, makeConfig(opts.permission), cwd, { adapter: opts.adapter, sessionsDir })
  uiPort.onMessage((m) => events.push(m))
  const post = (m: UiToAgentMessage) => { uiPort.post(m) }
  return { events, post, sessionsDir, cwd }
}

// 轮次是长时间异步过程——轮询等待目标事件（2s 超时，超时输出已收到的事件类型辅助定位）。
async function waitFor(events: AgentToUiMessage[], pred: (e: AgentToUiMessage) => boolean, label: string): Promise<AgentToUiMessage> {
  const deadline = Date.now() + 2000
  for (;;) {
    const found = events.find(pred)
    if (found) return found
    if (Date.now() > deadline) {
      throw new Error(`等待 ${label} 超时；已收到：${events.map((e) => e.type).join(',')}`)
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

// 「读 a.txt」脚本：第 1 次调用返回 tool_calls，第 2 次返回最终文本。
function readToolScript(finalText: string) {
  return (call: number): LlmStreamEvent[] => {
    if (call === 1) {
      return [
        { type: 'tool_call_start', index: 0, id: 'c1', name: 'read_file' },
        { type: 'tool_call_delta', index: 0, argsJsonDelta: '{"path":"a.txt"}' },
        { type: 'done', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] } },
      ]
    }
    return [{ type: 'done', message: { role: 'assistant', content: finalText } }]
  }
}

describe('Agent 轮次表征（重构行为基线）', () => {
  it('完整轮次：user 消息 → 工具执行 → 最终回答 → finished', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dogegg-cwd-'))
    writeFileSync(join(cwd, 'a.txt'), 'hi')
    const { events, post } = makeAgent({
      adapter: fakeAdapter(readToolScript('读完了')),
      permission: { allow: ['read_file'], reject: [], ask: [] },
      cwd,
    })

    post({ type: 'submit', text: '读一下 a.txt' })
    await waitFor(events, (e) => e.type === 'finished', 'finished')

    // 事件序列：message(user) 最先；tool_start 在 tool_end 之前且无错误；finished 收尾。
    expect(events[0]).toMatchObject({ type: 'message', role: 'user' })
    const types = events.map((e) => e.type)
    expect(types.indexOf('tool_start')).toBeGreaterThan(-1)
    expect(types.indexOf('tool_start')).toBeLessThan(types.indexOf('tool_end'))
    expect(types.indexOf('tool_end')).toBeLessThan(types.indexOf('finished'))
    expect(events.find((e) => e.type === 'tool_start')).toMatchObject({ name: 'read_file' })
    const toolEnd = events.find((e) => e.type === 'tool_end') as { output: string; error?: string }
    expect(toolEnd.output).toBe('hi')
    expect(toolEnd.error).toBeUndefined()
    const userMsg = events.find((e) => e.type === 'message' && e.role === 'assistant')
    expect(userMsg).toBeDefined()
  })

  it('ask 权限流：permission_request → allow_once 决议 → 执行 → finished', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dogegg-cwd-'))
    writeFileSync(join(cwd, 'a.txt'), 'hi')
    // permission 三桶全空 → read_file 分类为 ask，必须经用户决议。
    const { events, post } = makeAgent({ adapter: fakeAdapter(readToolScript('ok')), cwd })

    post({ type: 'submit', text: '读' })
    const request = await waitFor(events, (e) => e.type === 'permission_request', 'permission_request')
    expect(request).toMatchObject({ tool: 'read_file' })
    post({ type: 'permission_decision', id: (request as { id: string }).id, decision: 'allow_once' })
    await waitFor(events, (e) => e.type === 'finished', 'finished')

    const toolEnd = events.find((e) => e.type === 'tool_end') as { error?: string }
    expect(toolEnd).toBeDefined()
    expect(toolEnd.error).toBeUndefined()
  })

  it('轮次取消：abort → notice「已打断当前操作」', async () => {
    const { events, post } = makeAgent({ adapter: hangingAdapter() })

    post({ type: 'submit', text: '长任务' })
    await waitFor(events, (e) => e.type === 'state' && e.to === 'responding', 'responding 态')
    post({ type: 'cancel' })
    const notice = await waitFor(events, (e) => e.type === 'notice', 'notice')
    expect(notice).toMatchObject({ text: '已打断当前操作' })
  })

  it('手动压缩：/compact → compaction(source=manual)', async () => {
    const { events, post } = makeAgent({ adapter: fakeAdapter(() => [{ type: 'done', message: { role: 'assistant', content: 'ok' } }]) })

    post({ type: 'submit', text: '第一轮' })
    await waitFor(events, (e) => e.type === 'finished', 'finished')
    post({ type: 'compact_request' })
    const compaction = await waitFor(events, (e) => e.type === 'compaction', 'compaction')
    expect(compaction).toMatchObject({ source: 'manual' })
    expect((compaction as { before_tokens: number }).before_tokens).toBeGreaterThan(0)
    expect((compaction as { after_tokens: number }).after_tokens).toBeGreaterThan(0)
  })

  it('会话持久化 + resume：恢复消息历史与 allow_always 授权', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dogegg-cwd-'))
    writeFileSync(join(cwd, 'a.txt'), 'hi')
    const first = makeAgent({ adapter: fakeAdapter(readToolScript('ok')), cwd })

    // 第一轮：read_file 走 ask，用户选 allow_always（应随会话持久化）。
    first.post({ type: 'submit', text: '读' })
    const request = await waitFor(first.events, (e) => e.type === 'permission_request', 'permission_request')
    first.post({ type: 'permission_decision', id: (request as { id: string }).id, decision: 'allow_always' })
    await waitFor(first.events, (e) => e.type === 'finished', 'finished')

    // 取 sessionId（status_state 携带）。
    first.post({ type: 'status_request' })
    const status = await waitFor(first.events, (e) => e.type === 'status_state', 'status_state')
    const sid = (status as { sessionId: string }).sessionId

    // 第二个 Agent 实例 resume 同一会话：消息历史 + 授权都应恢复。
    const second = makeAgent({
      adapter: fakeAdapter(() => [{ type: 'done', message: { role: 'assistant', content: 'ok' } }]),
      cwd,
      sessionsDir: first.sessionsDir,
    })
    second.post({ type: 'resume_session', id: sid })
    const ready = await waitFor(second.events, (e) => e.type === 'session_ready', 'session_ready')
    const messages = (ready as { messages: Message[] }).messages
    expect(messages.some((m) => m.role === 'user' && m.content === '读')).toBe(true)
    expect(messages.some((m) => m.role === 'assistant' && m.content === 'ok')).toBe(true)
    second.post({ type: 'permissions_request' })
    const perms = await waitFor(second.events, (e) => e.type === 'permissions_list', 'permissions_list')
    expect((perms as { tools: string[] }).tools).toContain('read_file')
  })
})
