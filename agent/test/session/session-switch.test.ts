import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { Agent } from '../../src/agent'
import { ConfigStore } from '../../src/config'
import { InMemoryChannel } from '@dogegg/bridge'
import type { AgentToUiMessage, UiToAgentMessage } from '@dogegg/bridge'
import type { LlmClient } from '../../src/llm'

// ─────────────────────────────────────────────────────────────────────────────
// 会话切换联动重挂（黑盒走 Port）：newSession / resume 换的不只是 cwd——项目级 skills
// 锚定在会话目录上。跨项目 resume 后若不重挂，skills_list 仍显示旧项目的技能，且 toggle
// 会写错项目的 .skills.json。本文件验证：resume 到项目 B 的会话后，skills_list 反映 B 的技能。
// ─────────────────────────────────────────────────────────────────────────────

let root: string | null = null
afterEach(() => {
  if (root) { rmSync(root, { recursive: true, force: true }); root = null }
})

const fakeClient = { async chat() { return { message: { role: 'assistant', content: 'ok' } } } } as unknown as LlmClient

function makeSkill(rootDir: string, proj: string, name: string): void {
  mkdirSync(join(rootDir, proj, '.dogegg', 'skills', name), { recursive: true })
  writeFileSync(join(rootDir, proj, '.dogegg', 'skills', name, 'SKILL.md'), `---\ndescription: ${proj} 的 ${name}\n---\n正文`)
}

function makeAgent(cwd: string, sessionsDir: string) {
  const config = new ConfigStore().load({
    providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x/v1', apiKey: 'k', models: [{ name: 'm' }] }],
  })
  const { agentPort, uiPort } = new InMemoryChannel()
  const events: AgentToUiMessage[] = []
  // eslint-disable-next-line no-new
  new Agent(agentPort, config, cwd, { client: fakeClient, sessionsDir })
  uiPort.onMessage((m) => events.push(m))
  const post = (m: UiToAgentMessage) => { uiPort.post(m) }
  return { events, post }
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

// 最后一个命中的 skills_list（联动重挂可能多次广播，断言要针对最新状态）。
function lastSkillsList(events: AgentToUiMessage[]): Extract<AgentToUiMessage, { type: 'skills_list' }> {
  const all = events.filter((e): e is Extract<AgentToUiMessage, { type: 'skills_list' }> => e.type === 'skills_list')
  if (all.length === 0) throw new Error('没有任何 skills_list 事件')
  return all[all.length - 1]!
}

describe('会话切换联动重挂项目级 skills', () => {
  it('resume 跨项目会话：skills_list 反映目标项目的技能（不再停留旧项目）', async () => {
    root = mkdtempSync(join(tmpdir(), 'dogegg-switch-'))
    const projA = join(root, 'proj-a')
    const projB = join(root, 'proj-b')
    makeSkill(root, 'proj-a', 'alpha')
    makeSkill(root, 'proj-b', 'beta')
    const sessionsDir = mkdtempSync(join(tmpdir(), 'dogegg-switch-sessions-'))
    const { events, post } = makeAgent(projA, sessionsDir)

    // 1) 在项目 B 创建会话（立即落盘，cwd=projB）——切换钩子生效，skills_list 此刻应为 beta。
    post({ type: 'new_session', cwd: projB })
    await waitFor(events, (e) => e.type === 'session_ready', 'session_ready(B)')
    await waitFor(events, (e) => e.type === 'skills_list', 'skills_list(B)')
    expect(lastSkillsList(events).skills.map((s) => s.name)).toContain('beta')

    // 2) 切回项目 A 的新会话（显式指定 cwd——new_session 不带 cwd 时沿用当前目录，此刻仍是 B）——
    // skills_list 应回到 alpha（B 的 beta 消失）。
    post({ type: 'new_session', cwd: projA })
    await waitFor(events, (e) => e.type === 'skills_list' && lastSkillsList(events).skills.some((s) => s.name === 'alpha'), 'skills_list(A)')
    expect(lastSkillsList(events).skills.map((s) => s.name)).not.toContain('beta')

    // 3) resume 项目 B 的会话（cwd 来自存档）——核心回归点：skills_list 反映 B。
    post({ type: 'list_sessions' })
    const list = await waitFor(events, (e) => e.type === 'session_list', 'session_list') as Extract<AgentToUiMessage, { type: 'session_list' }>
    const bSession = list.sessions.find((s) => s.cwd === resolve(projB))
    expect(bSession).toBeDefined()
    post({ type: 'resume_session', id: bSession!.id })
    await waitFor(events, (e) => e.type === 'session_ready' && (e as { id: string }).id === bSession!.id, 'session_ready(resume B)')
    await waitFor(events, (e) => e.type === 'skills_list' && lastSkillsList(events).skills.some((s) => s.name === 'beta'), 'skills_list(resume B)')
    expect(lastSkillsList(events).skills.map((s) => s.name)).toContain('beta')
    expect(lastSkillsList(events).skills.map((s) => s.name)).not.toContain('alpha')
  })
})
