import { describe, it, expect } from 'vitest'
import { shouldCompact, estimateContextTokens } from '../../src/agent/context'

describe('context', () => {
  it('estimates tokens across system + messages + tools', () => {
    const n = estimateContextTokens('sys prompt', [{ role: 'user', content: 'hi' }], [{ type: 'function' }])
    expect(n).toBeGreaterThan(0)
  })

  it('shouldCompact triggers at 80%', () => {
    expect(shouldCompact(81, 100)).toBe(true)
    expect(shouldCompact(79, 100)).toBe(false)
  })
})