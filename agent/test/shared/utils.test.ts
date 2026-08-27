import { describe, it, expect } from 'vitest'
import { newId } from '../../src/shared'
import { estimateTokens } from '../../src/context'
import { truncate } from '../../src/context'

describe('common utils', () => {
  it('newId is unique across calls', () => {
    expect(newId()).not.toBe(newId())
  })

  it('estimateTokens counts CJK and ASCII', () => {
    expect(estimateTokens('你好')).toBe(2)
    expect(estimateTokens('hello world')).toBeGreaterThan(0)
  })

  it('truncate caps length and marks truncation', () => {
    const out = truncate('a'.repeat(100), 10)
    expect(out.length).toBeLessThan(40)
    expect(out).toContain('截断')
  })
})