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
function deferredTitleAdapter(finalText: string): { client: LlmClient; releaseTitle: () => void } {
  let call = 0
  let release!: () => void
  const gate = new Promise<void>((res) => { release = res })
  const client = {
    async chat(_req: unknown, _signal: AbortSignal, _emit: (e: never) => void) {
      call++
      if (call === 1) return { message: { role: 'assistant', content: finalText }, reasoning: undefined }
      await gate
      return { message: { role: 'assistant', content: '自动生成的标题' }, reasoning: undefined }
    },
  } as unknown as LlmClient
  return { client, releaseTitle: release }
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
    const { client, releaseTitle } = deferredTitleAdapter('写好了')
    const { events, post, sessionsDir } = makeAgent(client)
    post({ type: 'submit', text: '帮我写个快排' })
    await waitFor(events, (e) => e.type === 'finished', 'finished')
    // 标题请求已在飞（被 gate 挂起）——此刻手动命名。
    post({ type: 'rename_session', title: '手动命名' })
    await waitFor(events, (e) => e.type === 'session_list', 'rename broadcast')
    expect(events.find((e) => e.type === 'notice')).toMatchObject({ text: '会话已命名「手动命名」' })
    // 放行自动标题——写回前的守卫应发现标题已存在并丢弃结果。
    releaseTitle()
    await new Promise((r) => setTimeout(r, 100))
    expect(savedTitle(sessionsDir)).toBe('手动命名')
  })
})
