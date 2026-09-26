import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { Agent } from '../../src/agent'
import { ConfigStore } from '../../src/config'
import { InMemoryChannel } from '@dogegg/bridge'
import type { AgentToUiMessage, UiToAgentMessage } from '@dogegg/bridge'
import type { LlmClient } from '../../src/llm'

// ─────────────────────────────────────────────────────────────────────────────
// 会话标题测试：自动标题成功路径 + 竞态守卫（自动标题在飞期间 /rename 手动命名 → 手动优先）。
// 黑盒走 Port 收发；标题断言读会话 JSON 落盘（title 字段的最终事实）。
// ─────────────────────────────────────────────────────────────────────────────

function makeConfig() {
  return new ConfigStore().load({
    providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x/v1', apiKey: 'k', models: [{ name: 'm' }] }],
  })
}

// 首次调用返回轮次最终文本；第二次调用（自动标题）挂起直到测试手动放行——构造「标题在飞」的竞态窗口。
// titleReturned：放行后标题 LLM 调用已真正返回的正观测——负向断言以它为起点。没有它，
// 「守卫生效丢弃了结果」与「守卫未生效但还没执行到」无法区分，断言要么假红要么假绿。
function deferredTitleAdapter(finalText: string): { client: LlmClient; releaseTitle: () => void; titleReturned: () => boolean } {
  let call = 0
  let release!: () => void
  let returned = false
  const gate = new Promise<void>((res) => { release = res })
  const client = {
    async chat(_req: unknown, _signal: AbortSignal, _emit: (e: never) => void) {
      call++
      if (call === 1) return { message: { role: 'assistant', content: finalText }, reasoning: undefined }
      await gate
      const result = { message: { role: 'assistant', content: '自动生成的标题' }, reasoning: undefined }
      returned = true
      return result
    },
  } as unknown as LlmClient
  return { client, releaseTitle: release, titleReturned: () => returned }
}

// 即发式 client：首调用轮次文本，第二次（自动标题）直接返回标题文本。
function autoTitleAdapter(finalText: string, title: string): LlmClient {
  let call = 0
  return {
    async chat(_req: unknown, _signal: AbortSignal, _emit: (e: never) => void) {
      call++
      if (call === 1) return { message: { role: 'assistant', content: finalText }, reasoning: undefined }
      return { message: { role: 'assistant', content: title }, reasoning: undefined }
    },
  } as unknown as LlmClient
}

function makeAgent(client: LlmClient) {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'dogegg-title-'))
  const cwd = mkdtempSync(join(tmpdir(), 'dogegg-cwd-'))
  const { agentPort, uiPort } = new InMemoryChannel()
  const events: AgentToUiMessage[] = []
  // eslint-disable-next-line no-new
  new Agent(agentPort, makeConfig(), cwd, { client, sessionsDir })
  uiPort.onMessage((m) => events.push(m))
  const post = (m: UiToAgentMessage) => { uiPort.post(m) }
  return { events, post, sessionsDir }
}

// 轮询等待目标事件（2s 超时）。
async function waitFor(events: AgentToUiMessage[], pred: (e: AgentToUiMessage) => boolean, label: string): Promise<AgentToUiMessage> {
  const deadline = Date.now() + 2000
  for (;;) {
    const found = events.find(pred)
    if (found) return found
    if (Date.now() > deadline) throw new Error(`等待 ${label} 超时；已收到：${events.map((e) => e.type).join(',')}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

// 轮询等待任意条件成立（2s 超时）——事件流之外的状态（如 adapter 的「标题调用已返回」标记）。
async function waitForCond(cond: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待 ${label} 超时`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

// 负向断言的观察窗（去抖立法）：settle 窗口内每 10ms 复查一次不变量——一旦被破坏立即失败
//（fail-fast：守卫失效的写盘发生在标题 LLM 返回后的紧随微任务里，毫秒级即可抓到）；
// 窗口安静走完才判定「未写入」。取代固定 sleep 的原因：固定 sleep 只能证明「N ms 内没写」，
// 写盘慢于 N ms 时守卫失效会假绿——absence 断言依赖时序，守卫测试失去意义。
async function watchInvariant(check: () => void, settleMs = 300): Promise<void> {
  const deadline = Date.now() + settleMs
  for (;;) {
    check()
    if (Date.now() >= deadline) return
    await new Promise((r) => setTimeout(r, 10))
  }
}

function savedTitle(sessionsDir: string): string | undefined {
  // 单会话场景：目录里唯一的会话文件即当前会话（agent 启动不发 session_ready，文件名即 id）。
  const file = readdirSync(sessionsDir).find((n) => n.endsWith('.json'))!
  const raw = JSON.parse(readFileSync(join(sessionsDir, file), 'utf8')) as { title?: string }
  return raw.title
}

describe('会话标题（自动生成 + 手动命名竞态）', () => {
  it('自动标题：首轮结束后生成并落盘/广播', async () => {
    const { events, post, sessionsDir } = makeAgent(autoTitleAdapter('写好了', '快速排序实现'))
    post({ type: 'submit', text: '帮我写个快排' })
    await waitFor(events, (e) => e.type === 'finished', 'finished')
    // 自动标题完成会广播 notice 回执 + session_list（本流程中唯一一次），载荷携带 title。
    const notice = await waitFor(events, (e) => e.type === 'notice', 'notice') as Extract<AgentToUiMessage, { type: 'notice' }>
    expect(notice.text).toContain('已自动生成会话标题')
    const list = await waitFor(events, (e) => e.type === 'session_list', 'session_list') as Extract<AgentToUiMessage, { type: 'session_list' }>
    expect(list.sessions[0]?.title).toBe('快速排序实现')
    expect(savedTitle(sessionsDir)).toBe('快速排序实现')
  })

  it('竞态守卫：自动标题在飞期间 /rename → 手动命名保留，自动结果被丢弃', async () => {
    const { client, releaseTitle, titleReturned } = deferredTitleAdapter('写好了')
    const { events, post, sessionsDir } = makeAgent(client)
    post({ type: 'submit', text: '帮我写个快排' })
    await waitFor(events, (e) => e.type === 'finished', 'finished')
    // 标题请求已在飞（被 gate 挂起）——此刻手动命名。
    post({ type: 'rename_session', title: '手动命名' })
    await waitFor(events, (e) => e.type === 'session_list', 'rename broadcast')
    expect(events.find((e) => e.type === 'notice')).toMatchObject({ text: '会话已命名「手动命名」' })
    // 放行自动标题——写回前的守卫应发现标题已存在并丢弃结果。
    releaseTitle()
    // 去抖：先等标题 LLM 调用真正返回（守卫代码确实执行到了丢弃判定点），再在观察窗内
    // 反复检查磁盘标题仍为手动命名——守卫失效（写入自动标题）时 fail-fast 立即失败。
    await waitForCond(titleReturned, '自动标题 LLM 调用返回')
    await watchInvariant(() => expect(savedTitle(sessionsDir)).toBe('手动命名'))
    // 结构性旁证（不依赖时序）：结果被丢弃即无「已自动生成会话标题」回执。
    expect(events.some((e) => e.type === 'notice' && e.text.includes('已自动生成会话标题'))).toBe(false)
  })

  it('跨会话竞态守卫：标题生成期间 /new 切换会话 → 自动标题不写入新会话', async () => {
    const { client, releaseTitle, titleReturned } = deferredTitleAdapter('写好了')
    const { events, post, sessionsDir } = makeAgent(client)
    post({ type: 'submit', text: '帮我写个快排' })
    await waitFor(events, (e) => e.type === 'finished', 'finished')
    // 标题请求已在飞——此刻 /new 切到新会话（会话 id 已变）。
    post({ type: 'new_session' })
    await waitFor(events, (e) => e.type === 'session_ready', '新会话 session_ready')
    // 放行自动标题——写回前的跨会话守卫（生成前捕获的 id vs 当前 id）应丢弃结果：
    // 旧会话的标题绝不落进新会话（标题存在性守卫拦不住它——新会话标题恰为空）。
    releaseTitle()
    // 去抖：先等标题 LLM 调用真正返回，再在观察窗内反复检查所有会话文件的 title 仍为空——
    // 守卫一旦失效（任何文件被写入自动标题）立即失败，而非依赖「100ms 内没写」的固定 sleep。
    await waitForCond(titleReturned, '自动标题 LLM 调用返回')
    await watchInvariant(() => {
      for (const file of readdirSync(sessionsDir).filter((n) => n.endsWith('.json'))) {
        const raw = JSON.parse(readFileSync(join(sessionsDir, file), 'utf8')) as { title?: string }
        expect(raw.title, file).toBeUndefined()
      }
    })
    // 且不广播「已自动生成会话标题」回执（丢弃即无副作用）。
    expect(events.some((e) => e.type === 'notice' && e.text.includes('已自动生成会话标题'))).toBe(false)
  })
})
