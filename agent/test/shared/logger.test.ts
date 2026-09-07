import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '../../src/shared'

describe('Logger', () => {
  it('writes per-session log files under the instance dir', () => {
    const d = mkdtempSync(join(tmpdir(), 'dogegg-log2-'))
    const logger = new Logger(d)
    logger.log('abc', 'state', 'idle → thinking')
    logger.log('abc', 'tool', 'read_file ok')
    logger.log('other', 'state', 'idle → responding')
    expect(readFileSync(join(d, 'abc.log'), 'utf8')).toContain('idle → thinking')
    expect(readFileSync(join(d, 'other.log'), 'utf8')).toContain('idle → responding')
  })

  it('tail returns the last N lines only', () => {
    const d = mkdtempSync(join(tmpdir(), 'dogegg-log3-'))
    const logger = new Logger(d)
    for (let i = 1; i <= 5; i++) logger.log('s', 'state', `line ${i}`)
    const tail = logger.tail('s', 2).split('\n')
    expect(tail).toHaveLength(2)
    expect(tail[0]).toContain('line 4')
    expect(tail[1]).toContain('line 5')
  })

  it('tail returns empty for a session with no log file; null dir disables logging', () => {
    const d = mkdtempSync(join(tmpdir(), 'dogegg-log4-'))
    const logger = new Logger(d)
    expect(logger.path('missing')).toBe(join(d, 'missing.log'))
    expect(logger.tail('missing')).toBe('')

    const disabled = new Logger(null)
    expect(disabled.path('s')).toBeNull()
    expect(() => disabled.log('s', 'state', 'no-op')).not.toThrow()
    expect(disabled.tail('s')).toBe('')
  })
})
