import { describe, it, expect } from 'vitest'
import { ProviderRegistry } from '../../src/llm/provider/openai'
import type { ProviderConfig } from '@dogegg/bridge'

const provider: ProviderConfig = {
  name: 'openai',
  protocol: 'openai',
  baseURL: 'http://x/v1',
  apiKey: 'k',
  models: [{ name: 'gpt-4o', contextWindow: 100, maxOutput: 10, reasoning: false }],
}

describe('ProviderRegistry', () => {
  it('resolves provider by name', () => {
    expect(new ProviderRegistry([provider]).get('openai')?.name).toBe('openai')
  })

  it('resolves provider containing a model', () => {
    expect(new ProviderRegistry([provider]).findByModel('gpt-4o')?.name).toBe('openai')
  })

  it('returns undefined for unknown names', () => {
    const r = new ProviderRegistry([provider])
    expect(r.get('nope')).toBeUndefined()
    expect(r.findByModel('nope')).toBeUndefined()
  })
})