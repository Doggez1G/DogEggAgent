import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { Agent } from '../src/agent'
import { ConfigStore } from '../src/config'
import { InMemoryChannel } from '@dogegg/bridge'
import type { AgentToUiMessage, UiToAgentMessage } from '@dogegg/bridge'
import type { LlmClient } from '../src/llm'

// ─────────────────────────────────────────────────────────────────────────────
// 系统提示词主动推送表征测试（黑盒走 Port 收发）：
// prompt 是每次请求现算的——skills 增删启停会改变下一轮实际下发的内容；右侧面板
// 展示的是最近一次拉取的快照。变更后 agent 必须主动推送 system_state 新快照，
// 否则面板一直展示旧 prompt（禁用了 skill 面板里却还有），误导「设置没生效」。
// 用项目级技能（temp cwd）——不触碰真实 ~/.dogegg。
// ─────────────────────────────────────────────────────────────────────────────

function makeAgentWithSkill() {
  const cwd = mkdtempSync(join(tmpdir(), 'dogegg-sysprompt-'))
  mkdirSync(join(cwd, '.dogegg', 'skills', 'alpha'), { recursive: true })
  writeFileSync(join(cwd, '.dogegg', 'skills', 'alpha', 'SKILL.md'), '---\ndescription: ALPHA-SKILL-MARKER-7Q\n---\n\n# alpha\n\n正文\n')
  const sessionsDir = mkdtempSync(join(tmpdir(), 'dogegg-sysprompt-sessions-'))
  const { agentPort, uiPort } = new InMemoryChannel()
  const events: AgentToUiMessage[] = []
  const agent = new Agent(agentPort, new ConfigStore().load({
    providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x/v1', apiKey: 'k', models: [{ name: 'm' }] }],
  }), cwd, { client: {} as LlmClient, sessionsDir })
  void agent
  uiPort.onMessage((m) => events.push(m))
  const post = (m: UiToAgentMessage) => { uiPort.post(m) }
  return { events, post }
}

// 轮询等待第 n 条 system_state 到达（2s 超时，超时输出已收到的事件类型辅助定位）。
async function waitSystemState(events: AgentToUiMessage[], n: number): Promise<Extract<AgentToUiMessage, { type: 'system_state' }>> {
  const deadline = Date.now() + 2000
  for (;;) {
    const states = events.filter((e): e is Extract<AgentToUiMessage, { type: 'system_state' }> => e.type === 'system_state')
    if (states.length >= n) return states[n - 1]!
    if (Date.now() > deadline) throw new Error(`等待第 ${n} 条 system_state 超时；已收到: ${events.map((e) => e.type).join(',')}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

// 轮询等待第 n 条 context_state 到达（skills 增删启停会联动推送 token 显示刷新）。
async function waitContextState(events: AgentToUiMessage[], n: number): Promise<Extract<AgentToUiMessage, { type: 'context_state' }>> {
  const deadline = Date.now() + 2000
  for (;;) {
    const states = events.filter((e): e is Extract<AgentToUiMessage, { type: 'context_state' }> => e.type === 'context_state')
    if (states.length >= n) return states[n - 1]!
    if (Date.now() > deadline) throw new Error(`等待第 ${n} 条 context_state 超时；已收到: ${events.map((e) => e.type).join(',')}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('系统提示词变更主动推送', () => {
  it('禁用 skill 后推送的 system_state 不再包含该技能段；恢复启用后重新包含', async () => {
    const { events, post } = makeAgentWithSkill()
    // 初始拉取：prompt 含项目级技能段（description 独有标记）。
    post({ type: 'system_request' })
    const first = await waitSystemState(events, 1)
    expect(first.content).toContain('ALPHA-SKILL-MARKER-7Q')
    // 禁用 → 主动推送的快照不再包含该技能（面板与实际下发一致）。
    post({ type: 'skills_manage', action: 'toggle', scope: 'project', name: 'alpha', enabled: false })
    const second = await waitSystemState(events, 2)
    expect(second.content).not.toContain('ALPHA-SKILL-MARKER-7Q')
    // 重新启用 → 快照重新包含。
    post({ type: 'skills_manage', action: 'toggle', scope: 'project', name: 'alpha', enabled: true })
    const third = await waitSystemState(events, 3)
    expect(third.content).toContain('ALPHA-SKILL-MARKER-7Q')
  })

  it('禁用 skill 后推送的 context_state 中 system 段与总估算同步下降，恢复后回升', async () => {
    const { events, post } = makeAgentWithSkill()
    // 基线拉取：估算含技能清单段的 system prompt。
    post({ type: 'context_request' })
    const first = await waitContextState(events, 1)
    // 禁用 → 联动推送的刷新快照：system 段变短、总估算变小（估算器是确定性的纯字数折算）。
    post({ type: 'skills_manage', action: 'toggle', scope: 'project', name: 'alpha', enabled: false })
    const second = await waitContextState(events, 2)
    expect(second.breakdown!.system).toBeLessThan(first.breakdown!.system)
    expect(second.estimatedTokens).toBeLessThan(first.estimatedTokens)
    // 恢复启用 → 回到基线值。
    post({ type: 'skills_manage', action: 'toggle', scope: 'project', name: 'alpha', enabled: true })
    const third = await waitContextState(events, 3)
    expect(third.breakdown!.system).toBe(first.breakdown!.system)
    expect(third.estimatedTokens).toBe(first.estimatedTokens)
  })
})
