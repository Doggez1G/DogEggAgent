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
    expect(labels).toEqual(['name', 'protocol', 'baseURL', 'apiKey', 'models', '删除此 provider'])
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

  it('selectTool：MCP 服务聚合为一个条目（整组生效），内建工具逐个', () => {
    const calls: [string, unknown][] = []
    const tracking = { set: (p: string, v: unknown) => calls.push([p, v]), add: () => {}, remove: () => {} }
    // 运行时清单是完整快照（注册表 = 内建 + MCP），此处按真实形状构造全部内建 + playwright 两个工具。
    const tools = [
      ...['read_file', 'write_file', 'edit_file', 'shell', 'ls', 'glob', 'grep'].map((name) => ({ name, description: '', identity: { kind: 'builtin' as const } })),
      { name: 'mcp__playwright__browser_close', description: '', identity: { kind: 'mcp' as const, server: 'playwright', name: 'browser_close' } },
      { name: 'mcp__playwright__browser_navigate', description: '', identity: { kind: 'mcp' as const, server: 'playwright', name: 'browser_navigate' } },
    ]
    const entries = buildEntries(permCfg, { kind: 'selectTool', bucket: 'ask' }, tracking, tools)
    // 服务条目在先（来源运行时身份——permCfg 未配 mcpServers）；内建排除 ask 桶已有的 shell。
    expect(entries.map((e) => e.label)).toEqual([
      'playwright（MCP 服务 · 2 个工具）',
      'read_file', 'write_file', 'edit_file', 'ls', 'glob', 'grep',
    ])
    ;(entries[0] as { run: () => void }).run()
    expect(calls[0]![1]).toMatchObject({ playwright: [] })
    // 选择即钻入：选中后直接落到该键的 permissionTool 细化层（免 esc 退回再钻入的往返）。
    expect(entries[0]).toMatchObject({ afterRunPath: { kind: 'permissionTool', bucket: 'ask', tool: 'playwright' } })
  })

  it('selectTool：离线服务标注未运行；配置 mcpServers 里的服务即使无运行时工具也出现', () => {
    const srvCfg = configSchema.parse({
      providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x', apiKey: 'k', models: [{ name: 'm' }] }],
      mcpServers: [{ name: 'fs', transport: { type: 'stdio', command: 'npx' } }],
      permission: { allow: {}, reject: {}, ask: {} },
    })
    // 未传 tools（未播种）→ 内建回退静态 KNOWN_TOOLS；服务条目在先。
    const entries = buildEntries(srvCfg, { kind: 'selectTool', bucket: 'allow' }, ctx)
    expect(entries.map((e) => e.label)).toEqual([
      'fs（MCP 服务 · 未运行）',
      'read_file', 'write_file', 'edit_file', 'shell', 'ls', 'glob', 'grep',
    ])
  })

  it('桶层：服务键标注（MCP 服务）+ 整组摘要', () => {
    const srvCfg = configSchema.parse({
      providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x', apiKey: 'k', models: [{ name: 'm' }] }],
      mcpServers: [{ name: 'playwright', transport: { type: 'stdio', command: 'npx' } }],
      permission: { allow: { playwright: [] }, reject: {}, ask: {} },
    })
    const entries = buildEntries(srvCfg, { kind: 'permissionBucket', bucket: 'allow' }, ctx, [])
    expect(entries.map((e) => e.label)).toEqual(['playwright（MCP 服务）', '＋ 添加工具'])
    const first = entries[0]!
    expect(first.kind).toBe('goto')
    expect((first as { value: string }).value).toBe('整组（该服务所有工具）')
  })

  it('服务键钻入：运行时清单勾选式细化 + 通配行 + 添加通配', () => {
    const calls: [string, unknown][] = []
    const tracking = { set: (p: string, v: unknown) => calls.push([p, v]), add: () => {}, remove: () => {} }
    const tools = [
      { name: 'mcp__playwright__browser_close', description: '', identity: { kind: 'mcp' as const, server: 'playwright', name: 'browser_close' } },
      { name: 'mcp__playwright__browser_navigate', description: '', identity: { kind: 'mcp' as const, server: 'playwright', name: 'browser_navigate' } },
    ]
    const srvCfg = configSchema.parse({
      providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x', apiKey: 'k', models: [{ name: 'm' }] }],
      mcpServers: [{ name: 'playwright', transport: { type: 'stdio', command: 'npx' } }],
      permission: { allow: {}, reject: {}, ask: { playwright: ['browser_close', 'browser_*'] } },
    })
    const entries = buildEntries(srvCfg, { kind: 'permissionTool', bucket: 'ask', tool: 'playwright' }, tracking, tools)
    expect(entries.map((e) => e.label)).toEqual([
      '✓ browser_close', '· browser_navigate', '＊ browser_*', '＋ 添加通配（匹配该服务的内部工具名，如 browser_*）',
    ])
    ;(entries[1] as { run: () => void }).run() // 勾选 browser_navigate
    expect(calls[0]![1]).toMatchObject({ playwright: ['browser_close', 'browser_*', 'browser_navigate'] })
    ;(entries[0] as { run: () => void }).run() // 取消勾选 browser_close
    expect(calls[1]![1]).toMatchObject({ playwright: ['browser_*'] })
  })

  it('d 从桶中移除整个工具键', () => {
    const calls: [string, unknown][] = []
    const tracking = { set: (p: string, v: unknown) => calls.push([p, v]), add: () => {}, remove: () => {} }
    const entries = buildEntries(permCfg, { kind: 'permissionBucket', bucket: 'allow' }, tracking)
    ;(entries[0] as { del: () => void }).del!()
    expect(calls).toContainEqual(['permission.allow', { shell: ['git *', 'npm run *'] }])
  })
})
