import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore } from '../../src/config'
import { isConfigured } from '@dogegg/bridge'

const store = new ConfigStore()

describe('ConfigStore.load', () => {
  it('returns empty config when no providers', () => {
    const cfg = store.load({})
    expect(cfg.providers).toEqual([])
    expect(cfg.maxIterations).toBe(-1)
  })

  it('falls back to defaults for optional fields', () => {
    const cfg = store.load({
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
    expect(cfg.maxIterations).toBe(-1)
    expect(cfg.maxRetries).toBe(3)
    expect(cfg.defaultProvider).toBe('o')
    expect(cfg.defaultModel).toBe('m')
  })

  it('parses permission buckets', () => {
    const cfg = store.load({
      providers: [
        { name: 'o', protocol: 'openai', baseURL: 'http://x', apiKey: 'k', models: [{ name: 'm' }] },
      ],
      permission: { allow: ['read_file'] },
    })
    expect(cfg.permission.allow).toEqual(['read_file'])
    expect(cfg.permission.ask).toEqual([])
  })

  it('save then load roundtrips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dogegg-cfg-'))
    const file = join(dir, 'config.json')
    const cfg = store.load({ providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x', apiKey: 'k', models: [{ name: 'm' }] }] })
    store.save(cfg, file)
    const reloaded = store.load(JSON.parse(readFileSync(file, 'utf8')))
    expect(reloaded.defaultProvider).toBe('o')
    expect(reloaded.defaultModel).toBe('m')
  })
})

describe('isConfigured', () => {
  it('is false when empty', () => {
    expect(isConfigured(store.load({}))).toBe(false)
  })

  it('is true when a complete provider exists', () => {
    const cfg = store.load({ providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x', apiKey: 'k', models: [{ name: 'm' }] }] })
    expect(isConfigured(cfg)).toBe(true)
  })

  it('is false when provider fields are empty', () => {
    const cfg = store.load({ providers: [{ name: '', protocol: 'openai', baseURL: '', apiKey: '', models: [] }] })
    expect(isConfigured(cfg)).toBe(false)
  })
})
