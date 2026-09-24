import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { ToolRegistry, TOOL_NAME_RE } from '../../src/tools/registry'
import type { Tool } from '../../src/tools'

// 注册表统一关口的立法测试：合规三档（原样 / 整体哈希 / 冲突可见失败）+ 身份生命周期。
// 关口保证任何来源的 LLM 可见名必然满足供应商 API 硬规定（TOOL_NAME_RE），且身份与工具同增同删。
function fakeTool(name: string): Tool {
  return { name, description: '', schema: z.object({}), parameters: {}, execute: async () => ({ content: '' }) }
}

describe('TOOL_NAME_RE（供应商函数名硬规定）', () => {
  it('放行常规名；拒绝越界字符与超长', () => {
    expect(TOOL_NAME_RE.test('mcp__playwright__browser_close')).toBe(true)
    expect(TOOL_NAME_RE.test('read_file')).toBe(true)
    expect(TOOL_NAME_RE.test('mcp__我的服务__close')).toBe(false) // 非 ASCII
    expect(TOOL_NAME_RE.test('mcp__a b__c')).toBe(false) // 空格
    expect(TOOL_NAME_RE.test('mcp__a.b__c')).toBe(false) // 点
    expect(TOOL_NAME_RE.test('a'.repeat(65))).toBe(false) // 64 上限
    expect(TOOL_NAME_RE.test('a'.repeat(64))).toBe(true)
  })
})

describe('ToolRegistry 注册关口', () => {
  it('合规名原样注册，返回值即原名（调用方无感）', () => {
    const r = new ToolRegistry()
    expect(r.register(fakeTool('mcp__a__b'))).toBe('mcp__a__b')
    expect(r.get('mcp__a__b')).toBeDefined()
  })

  it('不合规名整体哈希为 h-<12位hex> 确定性标签；Tool.name 被改写为标签', () => {
    const r = new ToolRegistry()
    const label = r.register(fakeTool('mcp__我的服务__close'))
    expect(label).toMatch(/^h-[0-9a-f]{12}$/)
    expect(r.get(label)!.name).toBe(label) // schemas()/all() 看到的必然是合规名
    // 确定性：同名必同标签（跨注册表、跨进程一致——纯函数哈希）
    expect(new ToolRegistry().register(fakeTool('mcp__我的服务__close'))).toBe(label)
  })

  it('长度超限同样走哈希档', () => {
    const r = new ToolRegistry()
    expect(r.register(fakeTool('a'.repeat(65)))).toMatch(/^h-[0-9a-f]{12}$/)
  })

  it('冲突可见失败：占用已存在标签的注册抛错，绝不静默覆盖', () => {
    const r = new ToolRegistry()
    r.register(fakeTool('mcp__a__x'))
    expect(() => r.register(fakeTool('mcp__a__x'))).toThrow(/冲突/)
    expect(r.all().filter((t) => t.name === 'mcp__a__x')).toHaveLength(1)
  })

  it('身份：缺省 builtin；mcp 身份随注册记录、随摘除删除', () => {
    const r = new ToolRegistry()
    const b = r.register(fakeTool('read_x'))
    expect(r.identityOf(b)).toEqual({ kind: 'builtin' })
    const m = r.register(fakeTool('mcp__s__t'), { kind: 'mcp', server: 's', name: 't' })
    expect(r.identityOf(m)).toEqual({ kind: 'mcp', server: 's', name: 't' })
    r.unregister(m)
    expect(r.get(m)).toBeUndefined()
    expect(r.identityOf(m)).toBeUndefined()
  })

  it('labelsWhere 按身份谓词找标签（按服务摘除的数据源）', () => {
    const r = new ToolRegistry()
    r.register(fakeTool('mcp__s1__a'), { kind: 'mcp', server: 's1', name: 'a' })
    r.register(fakeTool('mcp__s1__b'), { kind: 'mcp', server: 's1', name: 'b' })
    r.register(fakeTool('mcp__s2__c'), { kind: 'mcp', server: 's2', name: 'c' })
    expect(r.labelsWhere((id) => id.kind === 'mcp' && id.server === 's1').sort()).toEqual(['mcp__s1__a', 'mcp__s1__b'])
  })

  it('listTools 携带身份（tools_list 载荷不变量：凡注册必有身份）', () => {
    const r = new ToolRegistry()
    r.register(fakeTool('mcp__s__t'), { kind: 'mcp', server: 's', name: 't' })
    expect(r.listTools()).toEqual([
      { name: 'mcp__s__t', description: '', identity: { kind: 'mcp', server: 's', name: 't' } },
    ])
  })

  it('哈希改写保留原型：class 实现的 Tool 方法在原型上，浅拷贝会把它丢掉', () => {
    // 回归点：{...tool} 只搬自有字段——class 工具（execute 在原型上）被哈希改写后
    // execute 变 undefined，调用即崩。Object.create+assign 修复后方法必须存活。
    class HashedTool implements Tool {
      readonly name = 'mcp__我的服务__close' // 非法名 → 必走哈希档
      readonly description = 'class 工具'
      readonly schema = z.object({})
      readonly parameters = {}
      async execute(): Promise<{ content: string }> {
        return { content: 'ok-from-prototype' }
      }
    }
    const r = new ToolRegistry()
    const label = r.register(new HashedTool())
    expect(label).toMatch(/^h-[0-9a-f]{12}$/)
    const t = r.get(label)!
    expect(t.name).toBe(label)
    expect(r.identityOf(label)).toEqual({ kind: 'builtin' })
    expect(r.listTools()[0]).toMatchObject({ name: label, description: 'class 工具' })
    expect(t.execute({}, { cwd: '.', signal: new AbortController().signal })).resolves.toEqual({
      content: 'ok-from-prototype',
    })
  })
})
