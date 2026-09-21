import { describe, it, expect } from 'vitest'
import type { PermissionConfig, ToolIdentity } from '@dogegg/bridge'
import { PermissionManager } from '../../src/permission'

// 服务键立法测试（bridge/contract/permission.ts 的 MCP 分支经 PermissionManager 全链路验证）：
// 桶键可以是 MCP 服务裸名——MCP 工具按【注册期身份】（server + 内部工具名）匹配，与 LLM 可见名
// 字面无关（哈希标签同样命中）；数组空 = 整组；非空 = 内部名精确/通配（永不涉参数）；
// 名字分支并存（遗留 mcp__x__* 键）；跨桶优先级不变（ask 压 allow：整组放行 + 个别询问可行）。
const ids = (map: Record<string, ToolIdentity>) => (): ReadonlyMap<string, ToolIdentity> => new Map(Object.entries(map))

describe('权限服务键（MCP 服务裸名桶键）', () => {
  // 推演基线：playwright 整组放行，仅 browser_evaluate 强制询问。
  const cfg: PermissionConfig = {
    allow: { 'mcp:playwright': { whole: true, patterns: [] } },
    reject: {},
    ask: { 'mcp:playwright': { whole: false, patterns: ['browser_evaluate'] } },
  }

  it('整组放行：身份 server 命中 whole 规则，内部名无关', () => {
    const pm = new PermissionManager(cfg, [], ids({
      'mcp__playwright__browser_navigate': { kind: 'mcp', server: 'playwright', name: 'browser_navigate' },
    }))
    expect(pm.classify('mcp__playwright__browser_navigate')).toBe('allow')
  })

  it('ask 勾选个别压过 allow 整组（桶优先级：ask > allow）', () => {
    const pm = new PermissionManager(cfg, [], ids({
      'mcp__playwright__browser_evaluate': { kind: 'mcp', server: 'playwright', name: 'browser_evaluate' },
    }))
    expect(pm.classify('mcp__playwright__browser_evaluate')).toBe('ask')
  })

  it('非空数组按内部工具名匹配：精确与通配（browser_*）皆可，不涉参数', () => {
    const askCfg: PermissionConfig = {
      allow: {},
      reject: {},
      ask: { 'mcp:playwright': { whole: false, patterns: ['browser_evaluate', 'browser_*'] } },
    }
    const pm = new PermissionManager(askCfg, [], ids({
      'mcp__playwright__browser_evaluate': { kind: 'mcp', server: 'playwright', name: 'browser_evaluate' },
      'mcp__playwright__browser_navigate': { kind: 'mcp', server: 'playwright', name: 'browser_navigate' },
      'mcp__playwright__tab_select': { kind: 'mcp', server: 'playwright', name: 'tab_select' },
    }))
    expect(pm.classify('mcp__playwright__browser_evaluate')).toBe('ask') // 精确
    expect(pm.classify('mcp__playwright__browser_navigate')).toBe('ask') // 通配前缀
    expect(pm.classify('mcp__playwright__tab_select')).toBe('ask') // 默认 ask 兜底（未被规则覆盖）
  })

  it('whole:false + 空选 = 不命中任何工具（键存在但无规则）', () => {
    const pm = new PermissionManager(
      { allow: { 'mcp:playwright': { whole: false, patterns: [] } }, reject: {}, ask: {} },
      [],
      ids({ 'mcp__playwright__x': { kind: 'mcp', server: 'playwright', name: 'x' } }),
    )
    expect(pm.classify('mcp__playwright__x')).toBe('ask')
  })

  it('哈希标签同样命中：匹配按身份进行，LLM 可见名只是调用管道', () => {
    const pm = new PermissionManager(
      { allow: { 'mcp:我的服务': { whole: true, patterns: [] } }, reject: {}, ask: {} },
      [],
      ids({ 'h-3fa2b1c9d0e4': { kind: 'mcp', server: '我的服务', name: 'close' } }),
    )
    expect(pm.classify('h-3fa2b1c9d0e4')).toBe('allow')
  })

  it('kind 门控：无身份（未注入）时服务键不命中——名字分支也匹配不上裸服务名', () => {
    const pm = new PermissionManager({ allow: { 'mcp:playwright': { whole: true, patterns: [] } }, reject: {}, ask: {} })
    expect(pm.classify('mcp__playwright__x')).toBe('ask') // 固定安全默认，而非误放行
  })

  it('kind 门控：内建身份不走服务分支（服务键对内建工具无效）', () => {
    const pm = new PermissionManager(
      { allow: { shell: { whole: true, patterns: [] } }, reject: {}, ask: {} },
      [],
      ids({ shell: { kind: 'builtin' } }),
    )
    expect(pm.classify('shell')).toBe('allow') // 名字分支命中
  })

  it('名字分支并存：遗留 mcp__x__* 通配键继续有效（无需身份）', () => {
    const pm = new PermissionManager({ allow: { 'mcp__playwright__*': { whole: true, patterns: [] } }, reject: {}, ask: {} })
    expect(pm.classify('mcp__playwright__browser_close')).toBe('allow')
  })

  it('reject 整组压过 allow（安全立法不变）', () => {
    const pm = new PermissionManager(
      {
        allow: { 'mcp:playwright': { whole: true, patterns: [] } },
        reject: { 'mcp:playwright': { whole: false, patterns: ['browser_evaluate'] } },
        ask: {},
      },
      [],
      ids({ 'mcp__playwright__browser_evaluate': { kind: 'mcp', server: 'playwright', name: 'browser_evaluate' } }),
    )
    expect(pm.classify('mcp__playwright__browser_evaluate')).toBe('reject')
  })
})
