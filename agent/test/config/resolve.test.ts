import { describe, it, expect } from 'vitest'
import { resolveCurrent } from '../../src/config'
import type { Config, ProviderConfig } from '@dogegg/bridge'

const provider: ProviderConfig = {
  name: 'openai',
  protocol: 'openai',
  baseURL: 'http://x/v1',
  apiKey: 'k',
  models: [{ name: 'gpt-4o', contextWindow: 100, maxOutput: 10, reasoning: false }],
}

const config: Config = {
  defaultProvider: 'openai',
  defaultModel: 'gpt-4o',
  maxIterations: 50,
  maxRetries: 3,
    mcpServers: [],
  permission: { allow: {}, reject: {}, ask: {} },
  providers: [provider],
}

describe('resolveCurrent', () => {
  it('按 defaultProvider + defaultModel 解析', () => {
    expect(resolveCurrent(config).provider.name).toBe('openai')
    expect(resolveCurrent(config).model.name).toBe('gpt-4o')
  })

  it('defaultProvider 未命中时回落首个 provider', () => {
    expect(resolveCurrent({ ...config, defaultProvider: 'nope' }).provider.name).toBe('openai')
  })

  it('defaultModel 未命中时回落首个 model', () => {
    expect(resolveCurrent({ ...config, defaultModel: 'nope' }).model.name).toBe('gpt-4o')
  })
})
