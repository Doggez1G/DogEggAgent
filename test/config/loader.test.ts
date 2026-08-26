import { describe, it, expect } from 'vitest'
import { loadConfig } from '../../src/config/loader'

describe('loadConfig', () => {
  it('rejects a config missing providers', () => {
    expect(() => loadConfig({})).toThrow()
  })

  it('falls back to defaults for optional fields', () => {
    const cfg = loadConfig({
      providers: [
        {
          name: 'o',
          protocol: 'openai',
          baseURL: 'http://x/v1',
          apiKey: 'k',
          models: [{ name: 'm', contextWindow: 100, maxOutput: 10, reasoning: false }],
        },
      ],
    })
    expect(cfg.maxIterations).toBe(50)
    expect(cfg.maxRetries).toBe(3)
    expect(cfg.defaultProvider).toBe('o')
    expect(cfg.defaultModel).toBe('m')
  })

  it('parses permission buckets', () => {
    const cfg = loadConfig({
      providers: [
        { name: 'o', protocol: 'openai', baseURL: 'http://x', apiKey: 'k', models: [{ name: 'm' }] },
      ],
      permission: { allow: ['read_file'] },
    })
    expect(cfg.permission.allow).toEqual(['read_file'])
    expect(cfg.permission.ask).toEqual([])
  })
})