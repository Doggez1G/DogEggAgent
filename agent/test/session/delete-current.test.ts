import { mkdtempSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { Agent } from '../../src/agent'
import { ConfigStore } from '../../src/config'
import { InMemoryChannel } from '@dogegg/bridge'
import type { AgentToUiMessage, UiToAgentMessage } from '@dogegg/bridge'
import type { LlmClient } from '../../src/llm'

// 删除会话的生命周期测试（黑盒走 Port）：删除当前会话必须立即切换新会话——
// 否则内存里的旧工作集会在下一轮落盘时把刚删的会话原样写回（「复活」bug）。

function makeConfig() {
  return new ConfigStore().load({
    providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x/v1', apiKey: 'k', models: [{ name: 'm' }] }],
  })
}

function echoAdapter(): LlmClient {
  let call = 0
  return {
    async chat() {
      call++
      return { message: { role: 'assistant', content: `回复 ${call}` }, reasoning: undefined }
    },
  } as unknown as LlmClient
}

function makeAgent() {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'dogegg-del-'))
  const cwd = mkdtempSync(join(tmpdir(), 'dogegg-cwd-'))
  const { agentPort, uiPort } = new InMemoryChannel()
  const events: AgentToUiMessage[] = []
  // eslint-disable-next-line no-new
  new Agent(agentPort, makeConfig(), cwd, { client: echoAdapter(), sessionsDir })
  uiPort.onMessage((m) => events.push(m))
  const post = (m: UiToAgentMessage) => { uiPort.post(m) }
  return { events, post, sessionsDir }
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

describe('删除当前会话（切换新会话，不复活）', () => {
  it('删除当前会话 → 立即切换新会话；旧 id 文件不再出现', async () => {
    const { events, post, sessionsDir } = makeAgent()
    // 先产生一轮对话并落盘——落盘后目录里唯一的会话文件即当前会话。
    post({ type: 'submit', text: '第一轮' })
    await waitFor(events, (e) => e.type === 'finished', 'finished')
    const oldFile = readdirSync(sessionsDir).find((f) => f.endsWith('.json'))!
    const oldId = oldFile.replace('.json', '')

    // 删除当前会话：应广播 session_deleted 并立即换新会话（session_ready 携带新 id）；
    // 新会话不落盘（首次对话才持久化）——否则删空的项目又被空会话撑成非空。
    post({ type: 'delete_session', id: oldId })
    await waitFor(events, (e) => e.type === 'session_deleted', 'session_deleted')
    const ready = await waitFor(events, (e) => e.type === 'session_ready', 'session_ready') as Extract<AgentToUiMessage, { type: 'session_ready' }>
    expect(ready.id).not.toBe(oldId)
    expect(existsSync(join(sessionsDir, oldFile))).toBe(false)
    expect(readdirSync(sessionsDir).filter((f) => f.endsWith('.json'))).toHaveLength(0)

    // 再对话一轮：旧会话不得复活——目录里只有新会话的文件。
    //（不能 waitFor('finished')——events 里已有第一轮的 finished，会立即返回早于落盘；直接轮询文件。）
    post({ type: 'submit', text: '第二轮' })
    const deadline = Date.now() + 2000
    while (readdirSync(sessionsDir).filter((f) => f.endsWith('.json')).length === 0) {
      if (Date.now() > deadline) throw new Error('等待第二轮落盘超时')
      await new Promise((r) => setTimeout(r, 5))
    }
    const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.json'))
    expect(files).toHaveLength(1)
    expect(files[0]).not.toBe(oldFile)
  })

  it('删除其他会话不影响当前会话', async () => {
    const { events, post, sessionsDir } = makeAgent()
    post({ type: 'submit', text: '第一轮' })
    await waitFor(events, (e) => e.type === 'finished', 'finished')
    const currentFile = readdirSync(sessionsDir).find((f) => f.endsWith('.json'))!

    // 直接 post 删除一个不存在的 id——当前会话不受影响、不切换。
    post({ type: 'delete_session', id: 'ghost-session' })
    await waitFor(events, (e) => e.type === 'session_deleted' && e.id === 'ghost-session', 'session_deleted')
    await new Promise((r) => setTimeout(r, 50))
    expect(events.some((e) => e.type === 'session_ready')).toBe(false)
    expect(existsSync(join(sessionsDir, currentFile))).toBe(true)
  })
})
