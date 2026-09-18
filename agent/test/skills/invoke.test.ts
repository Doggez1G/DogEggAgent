import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { Agent } from '../../src/agent'
import { ConfigStore } from '../../src/config'
import { PermissionManager } from '../../src/permission'
import { InMemoryChannel } from '@dogegg/bridge'
import type { AgentToUiMessage, Message, UiToAgentMessage } from '@dogegg/bridge'
import type { LlmClient, LlmStreamEvent } from '../../src/llm'

// Skills 门面集成：invoke_skill 的正文替换链路 + 管理 CRUD（含 channel 错误定位）+
// 清单强制重扫（缓存失效语义）+ 用户级 skills 目录的 read_file 权限豁免。

function makeConfig() {
  return new ConfigStore().load({
    providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x/v1', apiKey: 'k', models: [{ name: 'm' }] }],
  })
}

// 捕获 LLM 请求的伪 client——断言「发给模型的最后一条用户消息」即替换后的 skill 正文。
function capturingAdapter(captured: { lastUser?: string }): LlmClient {
  return {
    async chat(req: unknown, _signal: AbortSignal, _emit: (e: LlmStreamEvent) => void) {
      const messages = (req as { messages?: Message[] }).messages ?? []
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      captured.lastUser = typeof lastUser?.content === 'string' ? lastUser.content : undefined
      return { message: { role: 'assistant', content: '完成' }, reasoning: undefined }
    },
  } as unknown as LlmClient
}

function makeAgent(client: LlmClient, skillsUserDir: string) {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'dogegg-skill-'))
  const cwd = mkdtempSync(join(tmpdir(), 'dogegg-cwd-'))
  const { agentPort, uiPort } = new InMemoryChannel()
  const events: AgentToUiMessage[] = []
  // eslint-disable-next-line no-new
  new Agent(agentPort, makeConfig(), cwd, { client, sessionsDir, skillsUserDir })
  uiPort.onMessage((m) => events.push(m))
  const post = (m: UiToAgentMessage) => { uiPort.post(m) }
  return { events, post, cwd }
}

// 返回第一个命中的事件（调用方自行断言字段）。
async function waitFor(events: AgentToUiMessage[], pred: (e: AgentToUiMessage) => boolean, label: string): Promise<AgentToUiMessage> {
  const deadline = Date.now() + 2000
  for (;;) {
    const found = events.find(pred)
    if (found) return found
    if (Date.now() > deadline) throw new Error(`等待 ${label} 超时`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('invoke_skill 门面集成', () => {
  it('正文 $ARGUMENTS 替换后作为用户消息进轮次', async () => {
    const skillsUserDir = mkdtempSync(join(tmpdir(), 'dogegg-skilldir-'))
    mkdirSync(join(skillsUserDir, 'review'), { recursive: true })
    writeFileSync(join(skillsUserDir, 'review', 'SKILL.md'), '---\ndescription: 评审\n---\n请评审以下目标：$ARGUMENTS')
    const captured: { lastUser?: string } = {}
    const { events, post } = makeAgent(capturingAdapter(captured), skillsUserDir)

    post({ type: 'invoke_skill', name: 'review', args: 'foo.ts 的改动' })
    await waitFor(events, (e) => e.type === 'finished', 'finished')
    expect(captured.lastUser).toContain('请评审以下目标：foo.ts 的改动')
  })

  it('未命中的 skill → notice 且不进轮次', async () => {
    const captured: { lastUser?: string } = {}
    const skillsUserDir = mkdtempSync(join(tmpdir(), 'dogegg-skilldir-'))
    const { events, post } = makeAgent(capturingAdapter(captured), skillsUserDir)

    post({ type: 'invoke_skill', name: 'nope', args: '' })
    await waitFor(events, (e) => e.type === 'notice', 'notice')
    expect(captured.lastUser).toBeUndefined()
  })
})

describe('skills_manage 面板链路', () => {
  it('管理失败 notice 带 channel=skills（面板内联错误定位）', async () => {
    const skillsUserDir = mkdtempSync(join(tmpdir(), 'dogegg-skilldir-'))
    mkdirSync(join(skillsUserDir, 'dup'), { recursive: true })
    writeFileSync(join(skillsUserDir, 'dup', 'SKILL.md'), 'x')
    const { events, post } = makeAgent(capturingAdapter({}), skillsUserDir)

    post({ type: 'skills_manage', action: 'create', scope: 'user', name: 'dup', description: 'x' })
    const notice = await waitFor(events, (e) => e.type === 'notice', 'notice') as Extract<AgentToUiMessage, { type: 'notice' }>
    expect(notice.channel).toBe('skills')
    expect(notice.text).toContain('已存在')
  })

  it('skills_request 强制重扫：外部手改文件在清单可见（缓存失效语义）', async () => {
    const skillsUserDir = mkdtempSync(join(tmpdir(), 'dogegg-skilldir-'))
    const { events, post } = makeAgent(capturingAdapter({}), skillsUserDir)
    // 第一次拉取：空清单（门面已建立缓存）。
    post({ type: 'skills_request' })
    await waitFor(events, (e) => e.type === 'skills_list', '第一次 skills_list')
    // 模拟外部手改：绕过 CRUD 直接往目录里放一个新 skill。
    mkdirSync(join(skillsUserDir, 'external'), { recursive: true })
    writeFileSync(join(skillsUserDir, 'external', 'SKILL.md'), '---\ndescription: 外部新增\n---\nX')
    // 再拉取：门面 emitSkillsList 先 invalidate——外部文件可见。
    post({ type: 'skills_request' })
    await waitFor(events, (e) => e.type === 'skills_list' && JSON.stringify(e).includes('外部新增'), '重扫后的 skills_list')
  })
})

describe('用户级 skills 目录的 read_file 权限豁免', () => {
  it('目录内 read → allow；目录外 read → ask；write_file 不豁免', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'dogegg-skilldir-'))
    const skillFile = join(userDir, 'review', 'SKILL.md')
    mkdirSync(join(userDir, 'review'), { recursive: true })
    writeFileSync(skillFile, 'x')
    const elsewhere = mkdtempSync(join(tmpdir(), 'dogegg-elsewhere-'))
    // 空三桶：一切默认 ask。
    const pm = new PermissionManager({ allow: {}, reject: {}, ask: {} }, [userDir])
    expect(pm.classify('read_file', { path: skillFile }, elsewhere)).toBe('allow')
    expect(pm.classify('read_file', { path: join(elsewhere, 'a.txt') }, elsewhere)).toBe('ask')
    expect(pm.classify('write_file', { path: skillFile }, elsewhere)).toBe('ask')
    // 无豁免目录的实例不豁免。
    const pm2 = new PermissionManager({ allow: {}, reject: {}, ask: {} })
    expect(pm2.classify('read_file', { path: skillFile }, elsewhere)).toBe('ask')
  })
})
