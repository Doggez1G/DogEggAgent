import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { Agent } from '../src/agent'
import { ConfigStore } from '../src/config'
import { InMemoryChannel } from '@dogegg/bridge'
import type { AgentToUiMessage, Message, UiToAgentMessage } from '@dogegg/bridge'
import type { LlmStreamEvent, LlmClient } from '../src/llm'

// ─────────────────────────────────────────────────────────────────────────────
// 恢复链表征测试（黑盒走 Port 收发，不摸内部字段）：
// 1. 权限挂起中 cancel → 状态机必须迁移到 cancelled、下一轮 submit 正常（不冻结）；
// 2. permissions_request 重发挂起中的审批（同 id 幂等，UI 按 id 关联）；
// 3. resendSessionState 重发 session_ready 快照 + 挂起审批（SSE 重连/刷新的唯一恢复源）。
// ─────────────────────────────────────────────────────────────────────────────

function makeConfig() {
  return new ConfigStore().load({
    providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x/v1', apiKey: 'k', models: [{ name: 'm' }] }],
    // 三桶全空 → read_file 落 ask：构造「权限挂起」场景。
    permission: { allow: {}, reject: {}, ask: {} },
  })
}

// 伪 client：第 1 次调用返回 read_file 的 tool_calls（触发权限挂起），之后返回最终文本。
// 自动标题会消耗第 2 次调用（返回任意文本即可），不影响断言。
function toolThenTextAdapter(): LlmClient {
  let call = 0
  return {
    async chat(_req: unknown, _signal: AbortSignal, _emit: (e: LlmStreamEvent) => void) {
      call++
      if (call === 1) {
        return {
          message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
          reasoning: undefined,
        }
      }
      return { message: { role: 'assistant', content: 'ok' }, reasoning: undefined }
    },
  } as unknown as LlmClient
}

// 黑盒 harness：Agent 只经 port 收发；events 收集全部下行消息；agent 引用透出供 resendSessionState 直调。
// client 可注入——「轮中途 token 明细」用例需要延迟版的伪 client 制造观察窗口。
function makeAgent(cwd = mkdtempSync(join(tmpdir(), 'dogegg-recovery-')), client: LlmClient = toolThenTextAdapter()) {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'dogegg-recovery-sessions-'))
  writeFileSync(join(cwd, 'a.txt'), 'hi')
  const { agentPort, uiPort } = new InMemoryChannel()
  const events: AgentToUiMessage[] = []
  const agent = new Agent(agentPort, makeConfig(), cwd, { client, sessionsDir })
  uiPort.onMessage((m) => events.push(m))
  const post = (m: UiToAgentMessage) => { uiPort.post(m) }
  return { agent, events, post, cwd }
}

// 轮询等待条件满足（2s 超时，超时输出已收到的事件类型辅助定位）。
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

describe('恢复链：权限挂起中取消 / 重发挂起审批 / resendSessionState', () => {
  it('权限挂起中 cancel：状态机迁移到 cancelled，下一次 submit 正常（不冻结）', async () => {
    const { events, post } = makeAgent()

    post({ type: 'submit', text: '读' })
    await waitFor(events, (e) => e.type === 'permission_request', 'permission_request')
    post({ type: 'cancel' })

    // 关键断言：从 waiting_permission 到 cancelled 的迁移必须出现——
    // 旧实现 catch 不补迁移，状态机永久卡死在 waiting_permission（reset 的 VALID_FROM 不含它）。
    const cancelState = await waitFor(events, (e) => e.type === 'state' && e.to === 'cancelled', 'cancelled 迁移')
    expect(cancelState).toMatchObject({ from: 'waiting_permission', to: 'cancelled' })

    // 下一次 submit 能收到正常 state 事件序列：idle → responding → finished（不再冻结）。
    post({ type: 'submit', text: '继续' })
    await waitFor(events, (e) => e.type === 'state' && e.from === 'idle' && e.to === 'responding', '第二次 submit 进入 responding')
    await waitFor(events, (e) => e.type === 'finished', '第二次 submit finished')
  })

  it('permissions_request 重发挂起中的审批：同 id 幂等，决议仍可达', async () => {
    const { events, post } = makeAgent()

    post({ type: 'submit', text: '读' })
    const first = await waitFor(events, (e) => e.type === 'permission_request', 'permission_request')
    const id = (first as { id: string }).id

    post({ type: 'permissions_request' })
    await waitFor(events, (e) => e.type === 'permissions_list', 'permissions_list')
    // 挂起项应按原 id 重发——过滤出同 id 的请求，计数 ≥ 2（原发 + 重发）。
    const resend = await waitFor(
      events,
      (e) => e.type === 'permission_request' && (e as { id: string }).id === id && events.indexOf(e) > events.indexOf(first),
      '重发的 permission_request',
    )
    expect(resend).toMatchObject({ id, tool: 'read_file' })

    // 重发后决议照常送达：allow_once → 执行 → finished（恢复链闭环）。
    post({ type: 'permission_decision', id, decision: 'allow_once' })
    await waitFor(events, (e) => e.type === 'finished', 'finished')
    const toolEnd = events.find((e) => e.type === 'tool_end') as { error?: string }
    expect(toolEnd).toBeDefined()
    expect(toolEnd.error).toBeUndefined()
  })

  it('resendSessionState：重发 session_ready 快照 + 挂起中的审批', async () => {
    const { agent, events, post } = makeAgent()

    // 取当前会话 id（status_state 携带）。
    post({ type: 'status_request' })
    const status = await waitFor(events, (e) => e.type === 'status_state', 'status_state')
    const sid = (status as { sessionId: string }).sessionId

    // 制造挂起：submit → permission_request 在飞。
    post({ type: 'submit', text: '恢复测试' })
    const first = await waitFor(events, (e) => e.type === 'permission_request', 'permission_request')
    const id = (first as { id: string }).id

    // 直接调用恢复入口（server 在 SSE 新连接建立时调用）。
    agent.resendSessionState()

    // session_ready 快照：同会话 id + 完整消息历史（含刚提交的 user 消息）。
    const ready = await waitFor(events, (e) => e.type === 'session_ready', 'session_ready')
    expect(ready).toMatchObject({ id: sid })
    const messages = (ready as { messages: Message[] }).messages
    expect(messages.some((m) => m.role === 'user' && m.content === '恢复测试')).toBe(true)

    // 挂起审批一并重发：同 id 幂等，UI 按 id 关联。
    const resend = await waitFor(
      events,
      (e) => e.type === 'permission_request' && (e as { id: string }).id === id && events.indexOf(e) > events.indexOf(first),
      '重发的 permission_request',
    )
    expect(resend).toMatchObject({ id, tool: 'read_file' })
  })

  it('长任务轮中途拉取 context：breakdown 分段为实时帧（总量与明细同源，不再撕裂）', async () => {
    // call1 返回 tool_calls（读 a.txt，立即完成回填），call2 延迟 400ms 再出正文——
    // 制造「工具已完成、正文未出」的观察窗口：此刻 conversation.getContext() 还是轮前旧数组，
    // 只有 liveTurn 快照里有本轮的 assistant/tool 消息。
    let call = 0
    const client: LlmClient = {
      async chat() {
        call++
        if (call === 1) {
          return {
            message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
            reasoning: undefined,
          }
        }
        await new Promise((r) => setTimeout(r, 400))
        return { message: { role: 'assistant', content: 'final' }, reasoning: undefined }
      },
    } as unknown as LlmClient
    const { events, post } = makeAgent(undefined, client)

    // 基线（轮前）：context 只有 system+schemas，tool/assistant 段为 0。
    post({ type: 'context_request' })
    const baseline = await waitFor(events, (e) => e.type === 'context_state', '基线 context_state') as Extract<AgentToUiMessage, { type: 'context_state' }>
    expect(baseline.breakdown!.tool).toBe(0)

    post({ type: 'submit', text: '读 a.txt' })
    // 该 harness 的配置三桶全空：read_file 落 ask——先放行，工具才会真实执行并回填。
    const perm = await waitFor(events, (e) => e.type === 'permission_request', 'permission_request')
    post({ type: 'permission_decision', id: (perm as { id: string }).id, decision: 'allow_once' })
    await waitFor(events, (e) => e.type === 'tool_end', 'tool_end')
    post({ type: 'context_request' })
    // 轮中帧：等第二条 context_state（第一条是基线）。
    const deadline = Date.now() + 2000
    let mid: Extract<AgentToUiMessage, { type: 'context_state' }> | undefined
    for (;;) {
      const states = events.filter((e): e is Extract<AgentToUiMessage, { type: 'context_state' }> => e.type === 'context_state')
      if (states.length >= 2) { mid = states[1]; break }
      if (Date.now() > deadline) throw new Error(`等待轮中 context_state 超时；已收到：${events.map((e) => e.type).join(',')}`)
      await new Promise((r) => setTimeout(r, 5))
    }
    // 决定性断言：轮中的 breakdown 来自 liveTurn 快照——assistant/tool 段已计入，总量同步变大。
    expect(mid!.breakdown!.assistant).toBeGreaterThan(0)
    expect(mid!.breakdown!.tool).toBeGreaterThan(0)
    expect(mid!.estimatedTokens).toBeGreaterThan(baseline.estimatedTokens)

    // 轮末收口后：内存真相与轮中一致（tool/assistant 段保留），无撕裂回落。
    await waitFor(events, (e) => e.type === 'finished', 'finished')
    post({ type: 'context_request' })
    const final = await waitFor(events, (e) => e.type === 'context_state' && events.indexOf(e) > events.indexOf(mid!), '轮末 context_state') as Extract<AgentToUiMessage, { type: 'context_state' }>
    expect(final.breakdown!.tool).toBeGreaterThan(0)
    expect(final.estimatedTokens).toBeGreaterThan(baseline.estimatedTokens)
  })
})
