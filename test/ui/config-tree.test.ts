import { describe, it, expect } from 'vitest'
import { buildEntries, parentPath, entryLabel } from '../../src/ui/tui/config-tree'
import { loadConfig } from '../../src/config/loader'

const ctx = { set: () => {}, add: () => {}, remove: () => {} }
const cfg = loadConfig({ providers: [{ name: 'openai', protocol: 'openai', baseURL: 'http://x', apiKey: 'k', models: [{ name: 'gpt-4o', reasoning: false }] }] })

describe('config-tree', () => {
  it('root lists top-level fields', () => {
    const labels = buildEntries(cfg, { kind: 'root' }, ctx).map((e) => e.label)
    expect(labels).toEqual(['systemPrompt', 'defaultProvider', 'defaultModel', 'maxIterations', 'maxRetries', 'permission', 'providers'])
  })

  it('providers lists provider entries plus an add action', () => {
    const entries = buildEntries(cfg, { kind: 'providers' }, ctx)
    expect(entries.some((e) => e.kind === 'goto' && e.label === 'openai')).toBe(true)
    expect(entries.some((e) => e.kind === 'action')).toBe(true)
  })

  it('provider lists its fields plus a delete action', () => {
    const labels = buildEntries(cfg, { kind: 'provider', index: 0 }, ctx).map((e) => e.label)
    expect(labels).toEqual(['name', 'baseURL', 'apiKey', 'models', '删除此 provider'])
  })

  it('model exposes boolean reasoning field', () => {
    const entries = buildEntries(cfg, { kind: 'model', providerIndex: 0, modelIndex: 0 }, ctx)
    expect(entries.some((e) => e.kind === 'bool' && e.label === 'reasoning')).toBe(true)
  })

  it('parentPath walks up and yields null at root', () => {
    expect(parentPath({ kind: 'provider', index: 0 })).toEqual({ kind: 'providers' })
    expect(parentPath({ kind: 'providers' })).toEqual({ kind: 'root' })
    expect(parentPath({ kind: 'root' })).toBeNull()
  })

  it('entryLabel reflects bool preview', () => {
    const entries = buildEntries(cfg, { kind: 'model', providerIndex: 0, modelIndex: 0 }, ctx)
    const reasoning = entries.find((e) => e.kind === 'bool')!
    expect(entryLabel(reasoning)).toBe('reasoning  false')
    expect(entryLabel(reasoning, true)).toBe('reasoning  true')
  })
})