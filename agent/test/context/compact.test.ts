import { describe, it, expect } from 'vitest'
import { compactContext } from '../../src/context/compact'
import type { Message } from '@dogegg/bridge'

// 构造一个超长 context（超过窗口 80%），触发压缩。
function makeLongContext(): Message[] {
  const msgs: Message[] = []
  for (let i = 0; i < 20; i++) {
    msgs.push({ role: 'user', content: `消息 ${i} `.repeat(100) })
    msgs.push({ role: 'assistant', content: `回答 ${i} `.repeat(100) })
  }
  return msgs
}

describe('compactContext', () => {
  it('未达阈值时不压缩', async () => {
    const context: Message[] = [{ role: 'user', content: '短消息' }]
    const result = await compactContext({
      context, systemPrompt: 's', tools: [], windowTokens: 100000,
      summarize: async () => '摘要',
    })
    expect(result.compacted).toBe(false)
    expect(result.context).toBe(context) // 原样返回
  })

  it('达阈值且有旧历史时压缩', async () => {
    const context = makeLongContext()
    const result = await compactContext({
      context, systemPrompt: 's', tools: [], windowTokens: 100, // 极小窗口强制触发
      summarize: async (old) => `摘要了 ${old.length} 条`,
    })
    expect(result.compacted).toBe(true)
    expect(result.context.length).toBeLessThan(context.length)
    // 压缩后第一条是摘要消息
    expect(result.context[0]).toMatchObject({ role: 'user' })
    expect(result.context[0]!.content).toContain('摘要')
    expect(result.before).toBeGreaterThan(result.after)
  })

  it('R1: 只压缩 context，不接收也不修改 history', async () => {
    // compactContext 的签名只接收 context——它根本碰不到 history。
    // 此测试验证函数签名不含 history（编译期保证）+ 返回的新 context 与传入无关。
    const context = makeLongContext()
    const originalLength = context.length
    const result = await compactContext({
      context, systemPrompt: 's', tools: [], windowTokens: 100,
      summarize: async () => '摘要',
    })
    // 传入的 context 数组不被原地修改（compactContext 返回新数组）
    expect(context.length).toBe(originalLength)
    expect(result.context).not.toBe(context)
  })
})
