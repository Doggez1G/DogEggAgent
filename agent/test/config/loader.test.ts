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

  it('parses permission buckets (legacy 扁平条目 → v2 grouped 归一化)', () => {
    const cfg = store.load({
      providers: [
        { name: 'o', protocol: 'openai', baseURL: 'http://x', apiKey: 'k', models: [{ name: 'm' }] },
      ],
      permission: { allow: ['read_file', { tool: 'shell', command: 'git *' }], reject: ['shell'] },
    })
    // legacy 兼容：裸名 → 空数组（整工具）；规则对象 → 主参数模式数组。
    expect(cfg.permission.allow).toEqual({ read_file: [], shell: ['git *'] })
    expect(cfg.permission.reject).toEqual({ shell: [] })
    expect(cfg.permission.ask).toEqual({})
  })

  it('parses v2 grouped permission (桶 → 工具 → 模式数组，空 = 整工具)', () => {
    const cfg = store.load({
      providers: [
        { name: 'o', protocol: 'openai', baseURL: 'http://x', apiKey: 'k', models: [{ name: 'm' }] },
      ],
      permission: { allow: { shell: ['git *', 'npm run *'], read_file: [] }, reject: {}, ask: { shell: ['rm *'] } },
    })
    expect(cfg.permission.allow).toEqual({ shell: ['git *', 'npm run *'], read_file: [] })
    expect(cfg.permission.ask).toEqual({ shell: ['rm *'] })
  })

  it('factory default: read-class allow / write-class ask when permission omitted (设计 §4.1)', () => {
    const cfg = store.load({
      providers: [
        { name: 'o', protocol: 'openai', baseURL: 'http://x', apiKey: 'k', models: [{ name: 'm' }] },
      ],
    })
    expect(cfg.permission.allow).toEqual({ read_file: [], ls: [], glob: [], grep: [] })
    expect(cfg.permission.ask).toEqual({ write_file: [], edit_file: [], shell: [] })
    expect(cfg.permission.reject).toEqual({})
  })

  it('bare pattern（缺作用域前缀）拒绝加载', () => {
    expect(() => store.load({
      providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x', apiKey: 'k', models: [{ name: 'm' }] }],
      permission: { allow: { read_file: ['docs/**'] } },
    })).toThrow(/作用域前缀/)
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
