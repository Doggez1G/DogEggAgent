import { describe, it, expect } from 'vitest'
import { InMemoryChannel } from '../src/channel/in-memory'

describe('InMemoryChannel', () => {
  it('双向投递：agent→ui 与 ui→agent 各达对端', () => {
    const { agentPort, uiPort } = new InMemoryChannel()
    const toUi: string[] = []
    const toAgent: string[] = []
    uiPort.onMessage((m) => toUi.push(m.type))
    agentPort.onMessage((m) => toAgent.push(m.type))

    agentPort.post({ type: 'notice', text: 'hi' })
    uiPort.post({ type: 'tools_request' })

    expect(toUi).toEqual(['notice'])
    expect(toAgent).toEqual(['tools_request'])
  })

  it('退订后不再投递', () => {
    const { agentPort, uiPort } = new InMemoryChannel()
    const got: string[] = []
    const off = uiPort.onMessage((m) => got.push(m.type))
    off()
    agentPort.post({ type: 'notice', text: 'x' })
    expect(got).toEqual([])
  })
})
