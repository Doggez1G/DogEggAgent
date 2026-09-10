import { describe, it, expect } from 'vitest'
import { Compactor } from '../../src/turn/compactor'
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

describe('Compactor（全量交接总结）', () => {
  it('未达阈值时不压缩', async () => {
    const context: Message[] = [{ role: 'user', content: '短消息' }]
    const compactor = new Compactor(async () => '摘要')
    const result = await compactor.compact({ context, systemPrompt: 's', tools: [], windowTokens: 100000 })
    expect(result.compacted).toBe(false)
    expect(result.context).toBe(context) // 原样返回
  })

  it('force 跳过阈值：手动 /compact 无条件压缩', async () => {
    const context = makeLongContext() // 长 context + 短摘要 → 非劣原则成立，压缩有意义
    const summarized: Message[][] = []
    const compactor = new Compactor(async (old) => { summarized.push(old); return '摘要' })
    const result = await compactor.compact({ context, systemPrompt: 's', tools: [], windowTokens: 100000, force: true })
    expect(result.compacted).toBe(true)
    expect(summarized[0]).toEqual(context) // 全量：整个 context 都交给模型总结（无 keep 尾巴）
  })

  it('达阈值压缩：context 替换为单条摘要消息（含头标注），全量传给 summarize', async () => {
    const context = makeLongContext()
    const summarized: Message[][] = []
    const compactor = new Compactor(async (old) => { summarized.push(old); return `摘要了 ${old.length} 条` })
    const result = await compactor.compact({ context, systemPrompt: 's', tools: [], windowTokens: 100 })
    expect(result.compacted).toBe(true)
    expect(result.context.length).toBe(1) // 无保留尾巴——摘要即唯一上下文
    expect(result.context[0]).toMatchObject({ role: 'user' })
    expect(result.context[0]!.content).toContain('[对话已压缩')
    expect(result.context[0]!.content).toContain('摘要了')
    expect(summarized[0]).toEqual(context)
    expect(result.before).toBeGreaterThan(result.after)
  })

  it('R1: 只压缩 context，不接收也不修改 history', async () => {
    const context = makeLongContext()
    const originalLength = context.length
    const compactor = new Compactor(async () => '摘要')
    const result = await compactor.compact({ context, systemPrompt: 's', tools: [], windowTokens: 100 })
    expect(context.length).toBe(originalLength)
    expect(result.context).not.toBe(context)
  })

  it('诚实失败：summarize 抛错原样上抛（调用方按错误收尾）', async () => {
    const compactor = new Compactor(async () => { throw new Error('LLM 挂了') })
    await expect(compactor.compact({ context: makeLongContext(), systemPrompt: 's', tools: [], windowTokens: 100 })).rejects.toThrow('LLM 挂了')
  })

  it('诚实失败：空摘要视为压缩失败（防空 context 静默通过）', async () => {
    const compactor = new Compactor(async () => '  ')
    await expect(compactor.compact({ context: makeLongContext(), systemPrompt: 's', tools: [], windowTokens: 100 })).rejects.toThrow('压缩摘要为空')
  })

  it('空 context 不压缩', async () => {
    const compactor = new Compactor(async () => { throw new Error('不应被调用') })
    const result = await compactor.compact({ context: [], systemPrompt: 's', tools: [], windowTokens: 1, force: true })
    expect(result.compacted).toBe(false)
  })

  it('非劣原则：摘要不比原文短时按未压缩返回（小 context 手动压缩的保护）', async () => {
    const context: Message[] = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！我是代码编辑助手' },
    ]
    // 模拟低密度对话的冗长交接文档——比原文还长（真实场景：对一句寒暄做结构化总结）
    const verboseSummary = '1. 任务目标：用户发起了问候。2. 已完成：助手回复了问候并介绍了能力。3. 决策：无。4. 待办：无。'.repeat(15)
    const compactor = new Compactor(async () => verboseSummary)
    const result = await compactor.compact({ context, systemPrompt: 's', tools: [], windowTokens: 100, force: true })
    expect(result.compacted).toBe(false)
    expect(result.context).toBe(context) // 原样返回，不替换
  })
})
