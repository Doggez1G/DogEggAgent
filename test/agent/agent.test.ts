import { describe, it, expect } from 'vitest'
import { Agent } from '../../src/agent/index'
import { loadConfig } from '../../src/config/loader'

const cfg = loadConfig({ providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x/v1', apiKey: 'k', models: [{ name: 'm' }] }] })

describe('Agent command routing', () => {
  it('responds to read-only info commands', async () => {
    const agent = new Agent(cfg, process.cwd())
    const types: string[] = []
    agent.on((e) => types.push(e.type))

    await agent.send({ type: 'status_request' })
    await agent.send({ type: 'tools_request' })
    await agent.send({ type: 'list_sessions' })
    await agent.send({ type: 'context_request' })
    await agent.send({ type: 'system_request' })

    expect(types).toContain('status_state')
    expect(types).toContain('tools_list')
    expect(types).toContain('session_list')
    expect(types).toContain('context_state')
    expect(types).toContain('system_state')
  })

  it('new_session resets and emits session_ready', async () => {
    const agent = new Agent(cfg, process.cwd())
    const types: string[] = []
    agent.on((e) => types.push(e.type))
    await agent.send({ type: 'new_session' })
    expect(types).toContain('session_ready')
  })
})