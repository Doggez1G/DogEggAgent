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

  it('parses v3 structured permission（键 → { whole, patterns }，唯一合法格式）', () => {
    const cfg = store.load({
      providers: [
        { name: 'o', protocol: 'openai', baseURL: 'http://x', apiKey: 'k', models: [{ name: 'm' }] },
      ],
      permission: {
        allow: { shell: { whole: false, patterns: ['git *', 'npm run *'] }, read_file: { whole: true, patterns: [] } },
        reject: {},
        ask: { shell: { whole: false, patterns: ['rm *'] } },
      },
    })
    expect(cfg.permission.allow).toEqual({
      shell: { whole: false, patterns: ['git *', 'npm run *'] },
      read_file: { whole: true, patterns: [] },
    })
    expect(cfg.permission.ask).toEqual({ shell: { whole: false, patterns: ['rm *'] } })
  })

  it('旧格式不受兼容：v2 字符串数组 / M1 条目数组 → 报错拒绝加载（配置演进不兼容原则）', () => {
    const base = { providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x', apiKey: 'k', models: [{ name: 'm' }] }] }
    // v2：桶值为字符串数组
    expect(() => store.load({ ...base, permission: { allow: { read_file: [] }, reject: {}, ask: {} } })).toThrow()
    // M1：桶值为条目数组
    expect(() => store.load({ ...base, permission: { allow: ['read_file'], reject: [], ask: [] } })).toThrow()
  })

  it('factory default: read-class allow / write-class ask when permission omitted (设计 §4.1)', () => {
    const cfg = store.load({
      providers: [
        { name: 'o', protocol: 'openai', baseURL: 'http://x', apiKey: 'k', models: [{ name: 'm' }] },
      ],
    })
    expect(cfg.permission.allow).toEqual({
      read_file: { whole: true, patterns: [] },
      ls: { whole: true, patterns: [] },
      glob: { whole: true, patterns: [] },
      grep: { whole: true, patterns: [] },
    })
    expect(cfg.permission.ask).toEqual({
      write_file: { whole: true, patterns: [] },
      edit_file: { whole: true, patterns: [] },
      shell: { whole: true, patterns: [] },
    })
    expect(cfg.permission.reject).toEqual({})
  })

  it('bare pattern（缺作用域前缀）拒绝加载', () => {
    expect(() => store.load({
      providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x', apiKey: 'k', models: [{ name: 'm' }] }],
      permission: { allow: { read_file: { whole: false, patterns: ['docs/**'] } } },
    })).toThrow(/作用域前缀/)
  })

  it('裸服务名键拒绝加载：服务键必须写 mcp:<服务名> 前缀（交叉校验）', () => {
    expect(() => store.load({
      providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x', apiKey: 'k', models: [{ name: 'm' }] }],
      mcpServers: [{ name: 'playwright', transport: { type: 'stdio', command: 'npx' } }],
      permission: { allow: { playwright: { whole: true, patterns: [] } }, reject: {}, ask: {} },
    })).toThrow(/mcp:playwright/)
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
