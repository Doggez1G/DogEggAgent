import { describe, it, expect } from 'vitest'
import { buildEntries, parentPath, entryLabel } from '../../../src/tui/features/config'
import { configSchema, type Config } from '@dogegg/bridge'

const ctx = { set: () => {}, add: () => {}, remove: () => {} }
const cfg = configSchema.parse({ providers: [{ name: 'openai', protocol: 'openai', baseURL: 'http://x', apiKey: 'k', models: [{ name: 'gpt-4o', reasoning: false }] }] })

describe('config-tree', () => {
  it('root lists top-level fields', () => {
    const labels = buildEntries(cfg, { kind: 'root' }, ctx).map((e) => e.label)
    expect(labels).toEqual(['systemPrompt', 'defaultProvider', 'defaultModel', 'maxIterations', 'maxRetries', 'shellProgram', 'theme', 'permission', 'providers', 'skills', 'mcpServers'])
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

  it('provider scalar edits use index-based paths, not name', () => {
    const multi = configSchema.parse({
      providers: [
        { name: '', protocol: 'openai', baseURL: '', apiKey: '', models: [] },
        { name: '', protocol: 'openai', baseURL: '', apiKey: '', models: [] },
      ],
    })
    const calls: [string, unknown][] = []
    const tracking = { set: (p: string, v: unknown) => calls.push([p, v]), add: () => {}, remove: () => {} }
    const entries = buildEntries(multi, { kind: 'provider', index: 1 }, tracking)
    const nameEntry = entries.find((e) => e.kind === 'scalar' && e.label === 'name')!
    ;(nameEntry as { save: (v: string) => void }).save('second')
    expect(calls).toContainEqual(['providers.1.name', 'second'])
  })

  it('model scalar edits use index-based paths', () => {
    const multi = configSchema.parse({
      providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x', apiKey: 'k', models: [{ name: '' }, { name: '' }] }],
    })
    const calls: [string, unknown][] = []
    const tracking = { set: (p: string, v: unknown) => calls.push([p, v]), add: () => {}, remove: () => {} }
    const entries = buildEntries(multi, { kind: 'model', providerIndex: 0, modelIndex: 1 }, tracking)
    const nameEntry = entries.find((e) => e.kind === 'scalar' && e.label === 'name')!
    ;(nameEntry as { save: (v: string) => void }).save('gpt-4o-mini')
    expect(calls).toContainEqual(['providers.0.models.1.name', 'gpt-4o-mini'])
  })
})
describe('config-tree permission 编辑（v2：桶 → 工具 → 模式数组）', () => {
  const permCfg = configSchema.parse({
    providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x', apiKey: 'k', models: [{ name: 'm' }] }],
    permission: { allow: { read_file: [], shell: ['git *', 'npm run *'] }, ask: { shell: ['rm *'] }, reject: {} },
  })

  it('permission 层列出三桶（计数）+ 固定默认说明行', () => {
    const entries = buildEntries(permCfg, { kind: 'permission' }, ctx)
    expect(entries.map((e) => (e.kind === 'goto' ? e.value : ''))).toEqual(['2 个工具', '0 个工具', '1 个工具', ''])
    expect(entries[3]!.label).toContain('固定安全默认')
  })

  it('桶层列出工具（摘要含跨桶提示）+ 添加工具入口', () => {
    const entries = buildEntries(permCfg, { kind: 'permissionBucket', bucket: 'allow' }, ctx)
    expect(entries.map((e) => e.label)).toEqual(['read_file', 'shell', '＋ 添加工具'])
    const [readFile, shell] = entries
    if (readFile?.kind !== 'goto' || shell?.kind !== 'goto') throw new Error('expected goto entries')
    expect(readFile.value).toBe('整工具')
    expect(shell.value).toContain('2 条模式')
    expect(shell.value).toContain('另在 ask 桶有规则')
  })

  it('工具层：整工具态显示转换提示；添加模式经 prompt 落整桶 set', () => {
    const calls: [string, unknown][] = []
    const tracking = { set: (p: string, v: unknown) => calls.push([p, v]), add: () => {}, remove: () => {} }
    const empty = buildEntries(permCfg, { kind: 'permissionTool', bucket: 'allow', tool: 'read_file' }, tracking)
    expect(empty[0]!.label).toContain('整工具生效')
    expect(empty[1]!.kind).toBe('prompt')
    ;(empty[1] as { save: (v: string) => void }).save('docs/**')
    expect(calls).toContainEqual(['permission.allow', { read_file: ['docs/**'], shell: ['git *', 'npm run *'] }])
  })

  it('工具层：模式行 scalar 就地编辑（非空 + 去重）与 d 删除', () => {
    const calls: [string, unknown][] = []
    const tracking = { set: (p: string, v: unknown) => calls.push([p, v]), add: () => {}, remove: () => {} }
    const entries = buildEntries(permCfg, { kind: 'permissionTool', bucket: 'allow', tool: 'shell' }, tracking)
    expect(entries.map((e) => e.label)).toEqual(['git *', 'npm run *', '＋ 添加模式'])
    const first = entries[0]!
    expect(first.kind).toBe('scalar')
    ;(first as { save: (v: string) => void }).save('git push *') // 改名
    expect(calls).toContainEqual(['permission.allow', { read_file: [], shell: ['git push *', 'npm run *'] }])
    ;(first as { save: (v: string) => void }).save('npm run *') // 重复 → 不发
    ;(first as { save: (v: string) => void }).save('  ') // 空白 → 不发
    expect(calls).toHaveLength(1)
    ;(first as { del: () => void }).del!()
    expect(calls).toContainEqual(['permission.allow', { read_file: [], shell: ['npm run *'] }])
  })

  it('selectTool 只列本桶没有的工具，加入即空数组（整工具）', () => {
    const calls: [string, unknown][] = []
    const tracking = { set: (p: string, v: unknown) => calls.push([p, v]), add: () => {}, remove: () => {} }
    const entries = buildEntries(permCfg, { kind: 'selectTool', bucket: 'allow' }, tracking)
    expect(entries.map((e) => e.label)).toEqual(['write_file', 'edit_file', 'ls', 'glob', 'grep']) // KNOWN_TOOLS 顺序过滤掉本桶已有的 read_file/shell
    ;(entries[0] as { run: () => void }).run()
    expect(calls[0]![0]).toBe('permission.allow')
    expect(calls[0]![1]).toMatchObject({ write_file: [] })
  })

  it('d 从桶中移除整个工具键', () => {
    const calls: [string, unknown][] = []
    const tracking = { set: (p: string, v: unknown) => calls.push([p, v]), add: () => {}, remove: () => {} }
    const entries = buildEntries(permCfg, { kind: 'permissionBucket', bucket: 'allow' }, tracking)
    ;(entries[0] as { del: () => void }).del!()
    expect(calls).toContainEqual(['permission.allow', { shell: ['git *', 'npm run *'] }])
  })
})
