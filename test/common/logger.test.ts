import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initLogger, log, readLogTail, sessionLogPath } from '../../src/common/utils/logger'

describe('logger', () => {
  it('writes per-session log files under the init dir', () => {
    const d = mkdtempSync(join(tmpdir(), 'dogegg-log2-'))
    initLogger(d)
    log('abc', 'state', 'idle → thinking')
    log('abc', 'tool', 'read_file ok')
    log('other', 'state', 'idle → responding')
    expect(readFileSync(join(d, 'abc.log'), 'utf8')).toContain('idle → thinking')
    expect(readFileSync(join(d, 'other.log'), 'utf8')).toContain('idle → responding')
  })

  it('readLogTail returns the last N lines only', () => {
    const d = mkdtempSync(join(tmpdir(), 'dogegg-log3-'))
    initLogger(d)
    for (let i = 1; i <= 5; i++) log('s', 'state', `line ${i}`)
    const tail = readLogTail('s', 2).split('\n')
    expect(tail).toHaveLength(2)
    expect(tail[0]).toContain('line 4')
    expect(tail[1]).toContain('line 5')
  })

  it('readLogTail returns empty for a session with no log file', () => {
    const d = mkdtempSync(join(tmpdir(), 'dogegg-log4-'))
    initLogger(d)
    expect(sessionLogPath('missing')).toBe(join(d, 'missing.log'))
    expect(readLogTail('missing')).toBe('')
  })
})