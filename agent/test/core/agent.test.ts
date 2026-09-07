import { describe, it, expect } from 'vitest'
import { Agent } from '../../src/core'
import { loadConfig } from '../../src/config'
import { InMemoryChannel } from '@dogegg/bridge'
import type { AgentToUiMessage, UiToAgentMessage } from '@dogegg/bridge'

const cfg = loadConfig({ providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x/v1', apiKey: 'k', models: [{ name: 'm' }] }] })

// Agent 现在通过 Port 收发消息——不再有 on()/send() 公共方法。
// 测试用 InMemoryChannel 构造对偶 port，agent 订阅 agentPort，测试从 uiPort 发消息、收消息。
function makeAgent() {
  const { agentPort, uiPort } = new InMemoryChannel()
  const types: string[] = []
  // agent 构造时自订阅 port，所以 new 之后即开始监听
  // eslint-disable-next-line no-new
  new Agent(agentPort, cfg, process.cwd())
  uiPort.onMessage((m: AgentToUiMessage) => types.push(m.type))
  return { uiPort, types }
}

describe('Agent command routing', () => {
  it('纯查询命令始终响应', async () => {
    const { uiPort, types } = makeAgent()

    const send = (m: UiToAgentMessage) => new Promise<void>((resolve) => {
      // post 是同步投递，send 是 async——用 queueMicrotask 等一轮微任务让消息处理完
      uiPort.post(m)
      queueMicrotask(() => resolve())
    })

    await send({ type: 'status_request' })
    await send({ type: 'tools_request' })
    await send({ type: 'list_sessions' })
    await send({ type: 'context_request' })
    await send({ type: 'system_request' })

    expect(types).toContain('status_state')
    expect(types).toContain('tools_list')
    expect(types).toContain('session_list')
    expect(types).toContain('context_state')
    expect(types).toContain('system_state')
  })

  it('new_session 重置并发 session_ready', async () => {
    const { uiPort, types } = makeAgent()
    await new Promise<void>((resolve) => { uiPort.post({ type: 'new_session' }); queueMicrotask(() => resolve()) })
    expect(types).toContain('session_ready')
  })

  it('R2: 未配置时 submit 发 notice 引导 /config 而非静默', async () => {
    // 空配置（无 provider）：isConfigured 为 false，submit 发 notice 而非静默丢弃。
    const { agentPort, uiPort } = new InMemoryChannel()
    const types: string[] = []
    // eslint-disable-next-line no-new
    new Agent(agentPort, loadConfig({}), process.cwd())
    uiPort.onMessage((m: AgentToUiMessage) => types.push(m.type))
    await new Promise<void>((resolve) => { uiPort.post({ type: 'submit', text: 'hi' }); queueMicrotask(() => resolve()) })
    expect(types).toContain('notice')
  })
})
