import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { Agent } from '../../src/agent'
import { ConfigStore } from '../../src/config'
import { InMemoryChannel } from '@dogegg/bridge'
import type { AgentToUiMessage, UiToAgentMessage } from '@dogegg/bridge'
import type { LlmClient } from '../../src/llm'

// set_cwd 的落盘与广播语义（黑盒走 Port）：切换成功后立即保存会话文件并重推 session_list——
// WebUI 侧栏按 cwd 分组项目树，不即时落盘的话新项目要等下一轮对话才出现。

function makeConfig() {
  return new ConfigStore().load({
    providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x/v1', apiKey: 'k', models: [{ name: 'm' }] }],
  })
}

function makeAgent() {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'dogegg-cwd-'))
  const cwd = mkdtempSync(join(tmpdir(), 'dogegg-proj-'))
  const otherDir = mkdtempSync(join(tmpdir(), 'dogegg-other-'))
  const { agentPort, uiPort } = new InMemoryChannel()
  const events: AgentToUiMessage[] = []
  // eslint-disable-next-line no-new
  new Agent(agentPort, makeConfig(), cwd, { client: { async chat() { return { message: { role: 'assistant', content: 'ok' } } } } as unknown as LlmClient, sessionsDir })
  uiPort.onMessage((m) => events.push(m))
  const post = (m: UiToAgentMessage) => { uiPort.post(m) }
  return { events, post, sessionsDir, cwd, otherDir }
}

async function waitFor(events: AgentToUiMessage[], pred: (e: AgentToUiMessage) => boolean, label: string): Promise<AgentToUiMessage> {
  const deadline = Date.now() + 2000
  for (;;) {
    const found = events.find(pred)
    if (found) return found
    if (Date.now() > deadline) throw new Error(`等待 ${label} 超时；已收到：${events.map((e) => e.type).join(',')}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('set_cwd 即时落盘与广播', () => {
  it('切换成功：会话文件立即携带新 cwd，session_list 同步重推', async () => {
    const { events, post, sessionsDir, otherDir } = makeAgent()
    post({ type: 'set_cwd', path: otherDir })
    const list = await waitFor(events, (e) => e.type === 'session_list', 'session_list') as Extract<AgentToUiMessage, { type: 'session_list' }>
    const expected = resolve(otherDir)
    expect(list.sessions[0]?.cwd).toBe(expected)
    // 会话文件已即时落盘且 cwd 为新目录（侧栏项目树的数据源）。
    const file = readdirSync(sessionsDir).find((f) => f.endsWith('.json'))!
    const raw = JSON.parse(readFileSync(join(sessionsDir, file), 'utf8')) as { cwd: string }
    expect(raw.cwd).toBe(expected)
  })

  it('切换到不存在的路径：报 notice，不落盘不广播', async () => {
    const { events, post, sessionsDir } = makeAgent()
    post({ type: 'set_cwd', path: join(tmpdir(), 'dogegg-nope-xyz') })
    await waitFor(events, (e) => e.type === 'notice', 'notice')
    await new Promise((r) => setTimeout(r, 50))
    expect(events.some((e) => e.type === 'session_list')).toBe(false)
    expect(readdirSync(sessionsDir).filter((f) => f.endsWith('.json'))).toHaveLength(0)
  })
})
