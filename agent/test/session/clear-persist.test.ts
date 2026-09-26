import { mkdtempSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { Agent } from '../../src/agent'
import { ConfigStore } from '../../src/config'
import { InMemoryChannel } from '@dogegg/bridge'
import type { AgentToUiMessage, UiToAgentMessage } from '@dogegg/bridge'
import type { LlmClient } from '../../src/llm'

// ─────────────────────────────────────────────────────────────────────────────
// 会话生命周期原子性回归（黑盒走 Port）：
// 1) /clear 必须落盘——内存与磁盘是 R1 双持久化的两份，只清内存的话 resume 会把
//    「已清空」的旧对话原样复活；落盘要保留标题（清历史不清标题）。
// 2) resume / delete 的会话 id 白名单——id 直接拼进文件路径，含 `../` 的非法 id
//    必须在入口被拒（防路径穿越读/删会话目录外的任意 json）。
// ─────────────────────────────────────────────────────────────────────────────

function makeConfig() {
  return new ConfigStore().load({
    providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x/v1', apiKey: 'k', models: [{ name: 'm' }] }],
  })
}

function echoAdapter(): LlmClient {
  return {
    async chat() {
      return { message: { role: 'assistant', content: '回复' }, reasoning: undefined }
    },
  } as unknown as LlmClient
}

function makeAgent() {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'dogegg-clear-'))
  const cwd = mkdtempSync(join(tmpdir(), 'dogegg-clear-cwd-'))
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

// 非法 id 的拒绝信号是 notice 文案（非法 id）而非 load 失败文案——区分「白名单拦截」与「文件不存在」。
function noticeWithText(events: AgentToUiMessage[], part: string): AgentToUiMessage | undefined {
  return events.find((e) => e.type === 'notice' && e.text.includes(part))
}

describe('/clear 落盘（resume 不复活）', () => {
  it('clear 后磁盘文件为空 history，标题保留；resume 该会话不复活旧对话', async () => {
    const { events, post, sessionsDir } = makeAgent()
    // 1) 产生一轮对话并落盘。
    post({ type: 'submit', text: '第一轮对话内容' })
    await waitFor(events, (e) => e.type === 'finished', 'finished')
    // 2) /rename 设置标题——落盘文件应携带 title。
    post({ type: 'rename_session', title: '我的标题' })
    await waitFor(events, (e) => e.type === 'notice' && e.text.includes('会话已命名'), 'rename notice')
    const file = join(sessionsDir, readdirSync(sessionsDir).find((f) => f.endsWith('.json'))!)

    // 3) /clear：内存清空且必须同步落盘——磁盘上 history 为空数组、title 原样保留。
    post({ type: 'clear_history' })
    await waitFor(events, (e) => e.type === 'history_cleared', 'history_cleared')
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    expect(onDisk.history).toEqual([])
    expect(onDisk.context).toEqual([])
    expect(onDisk.title).toBe('我的标题')
    // 原子写不留 tmp 残留。
    expect(readdirSync(sessionsDir).filter((f) => f.includes('.tmp'))).toEqual([])

    // 4) resume 已清空的会话：从磁盘加载——messages 为空，旧对话不得复活。
    const id = (JSON.parse(readFileSync(file, 'utf8')) as { id: string }).id
    post({ type: 'resume_session', id })
    const ready = await waitFor(events, (e) => e.type === 'session_ready' && (e as { id: string }).id === id, 'session_ready(resume)') as Extract<AgentToUiMessage, { type: 'session_ready' }>
    expect(ready.messages).toEqual([])
  })
})

describe('会话 id 白名单（防路径穿越）', () => {
  it('resume 非法 id（含 ../）→ notice 拒绝，不发 session_ready、不读穿越路径', async () => {
    const { events, post, sessionsDir } = makeAgent()
    // 若白名单失效，load 会尝试读 sessionsDir/../../evil.json——不存在时走「加载失败」分支，
    // 所以拒绝信号必须是「非法会话 id」文案，区分白名单拦截与文件缺失。
    post({ type: 'resume_session', id: '../../evil' })
    await waitFor(events, (e) => e.type === 'notice' && e.text.includes('非法会话 id'), '非法 id notice')
    expect(noticeWithText(events, '加载失败')).toBeUndefined()
    expect(events.some((e) => e.type === 'session_ready')).toBe(false)
    // 会话目录内不产生任何文件。
    expect(readdirSync(sessionsDir).filter((f) => f.endsWith('.json'))).toEqual([])
  })

  it('delete 非法 id（含 ../）→ notice 拒绝，不发 session_deleted', async () => {
    const { events, post, sessionsDir } = makeAgent()
    // 若白名单失效，delete 对不存在的穿越路径是幂等静默成功——会错误地发 session_deleted。
    // 白名单在案时入口直接拒绝：只有 notice，没有 session_deleted。
    post({ type: 'delete_session', id: '../../evil' })
    await waitFor(events, (e) => e.type === 'notice' && e.text.includes('非法会话 id'), '非法 id notice')
    expect(events.some((e) => e.type === 'session_deleted')).toBe(false)
    // 穿越目标（sessionsDir/../..\evil.json 实际落点）不得被创建/删除（防御立法：入口拦截，不触达文件系统）。
    expect(existsSync(resolve(sessionsDir, '../../evil.json'))).toBe(false)
  })
})
