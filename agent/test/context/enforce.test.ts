import { describe, it, expect } from 'vitest'
import { enforceContextLimit } from '../../src/context/compact/enforce'
import type { Message } from '@dogegg/bridge'

const bigMsg = (text: string): Message => ({ role: 'user', content: text })

describe('enforceContextLimit', () => {
  it('returns context unchanged when under threshold', () => {
    const context = [bigMsg('short'), bigMsg('also short')]
    const result = enforceContextLimit({
      systemPrompt: 'sys',
      context,
      tools: [],
      windowTokens: 100000,
    })
    expect(result.dropped).toBe(0)
    expect(result.context).toHaveLength(2)
  })

  it('drops oldest messages when over threshold', () => {
    // 每条消息约 1000 tokens（4000 字符 / 4），窗口 1000，阈值 80%=800
    // 2 条消息就超阈值（~2000 > 800），应丢弃到 1 条（至少保留最后一条）
    const context = [
      bigMsg('a'.repeat(4000)),
      bigMsg('b'.repeat(4000)),
      bigMsg('c'.repeat(4000)),
    ]
    const result = enforceContextLimit({
      systemPrompt: '',
      context,
      tools: [],
      windowTokens: 1000,
    })
    expect(result.dropped).toBeGreaterThan(0)
    expect(result.context.length).toBeLessThanOrEqual(context.length)
    // 至少保留最后一条
    expect(result.context.length).toBeGreaterThanOrEqual(1)
    // 最后一条应该是最新的消息
    expect(result.context.at(-1)?.content).toBe('c'.repeat(4000))
  })

  it('always keeps at least the last message', () => {
    const context = [bigMsg('a'.repeat(10000))]
    const result = enforceContextLimit({
      systemPrompt: '',
      context,
      tools: [],
      windowTokens: 100,
    })
    expect(result.context).toHaveLength(1)
  })

  it('does not modify the original array', () => {
    const context = [bigMsg('a'.repeat(4000)), bigMsg('b'.repeat(4000))]
    const original = [...context]
    enforceContextLimit({
      systemPrompt: '',
      context,
      tools: [],
      windowTokens: 100,
    })
    expect(context).toEqual(original)
  })
})
