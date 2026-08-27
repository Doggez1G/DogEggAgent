import { describe, it, expect } from 'vitest'
import { shouldCompact, estimateContextTokens, splitForCompaction } from '../../src/context'

describe('context', () => {
  it('estimates tokens across system + messages + tools', () => {
    const n = estimateContextTokens('sys prompt', [{ role: 'user', content: 'hi' }], [{ type: 'function' }])
    expect(n).toBeGreaterThan(0)
  })

  it('shouldCompact triggers at 80%', () => {
    expect(shouldCompact(81, 100)).toBe(true)
    expect(shouldCompact(79, 100)).toBe(false)
  })

  it('splitForCompaction keeps recent messages and returns older ones', () => {
    const msgs = [1, 2, 3, 4, 5, 6].map((i) => ({ role: 'user' as const, content: String(i) }))
    const { old, fresh } = splitForCompaction(msgs, 2)
    expect(old.map((m) => m.content)).toEqual(['1', '2', '3', '4'])
    expect(fresh.map((m) => m.content)).toEqual(['5', '6'])
  })
})