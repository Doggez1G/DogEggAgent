import { describe, it, expect } from 'vitest'
import { configSchema } from '../src/contract/config'

// ─────────────────────────────────────────────────────────────────────────────
// configSchema 的 mcpServers 交叉校验（P2-9）：同一数组内服务名重复 → 加载期拒绝。
// 立法：同名条目按「后者覆盖前者」合并语义静默丢弃前者，且首个同名条目启动的 MCP 子进程
// 会被 rebuild 的 diff 判定为「被顶替」而遗留为孤儿进程——两头都是用户不可见的坑，
// 必须在加载期直接拒绝（错误信息指明重复名、合并语义与修复方式）。
// ─────────────────────────────────────────────────────────────────────────────

const stdio = (name: string) => ({ name, enabled: true, transport: { type: 'stdio' as const, command: 'node', args: ['x.mjs'] } })
const http = (name: string) => ({ name, enabled: true, transport: { type: 'http' as const, url: 'http://localhost:1' } })

describe('configSchema：mcpServers 同名条目校验', () => {
  it('同名条目（即使 transport 不同）：拒绝且 message 指明重复名、合并语义与孤儿进程原因', () => {
    const result = configSchema.safeParse({ mcpServers: [stdio('dup'), http('dup')] })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.message.includes('dup'))
      expect(issue).toBeDefined()
      expect(issue!.message).toContain('MCP server 名重复："dup"')
      expect(issue!.message).toContain('后者覆盖前者')
      expect(issue!.message).toContain('孤儿进程')
    }
  })

  it('两个同名以上：每个重复名都产生 issue（三连名报两条）', () => {
    const result = configSchema.safeParse({ mcpServers: [stdio('a'), stdio('a'), stdio('a')] })
    expect(result.success).toBe(false)
    if (!result.success) {
      // 第 2、3 个 'a' 各触发一次（第 1 个是首次出现）。
      expect(result.error.issues.filter((i) => i.message.includes('"a"'))).toHaveLength(2)
    }
  })

  it('名字互不相同 / 空列表：照常通过（默认值照常填充）', () => {
    const ok = configSchema.parse({ mcpServers: [stdio('x'), http('y')] })
    expect(ok.mcpServers).toHaveLength(2)
    expect(configSchema.parse({}).mcpServers).toEqual([])
  })
})
