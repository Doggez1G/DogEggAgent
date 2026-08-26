import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { saveSession, loadSession, listSessions } from '../../src/agent/session'

const dir = mkdtempSync(join(tmpdir(), 'dogegg-sess-'))

describe('session store', () => {
  it('saves and loads messages', () => {
    saveSession('s1', [{ role: 'user', content: 'hi' }], dir)
    const loaded = loadSession('s1', dir)
    expect(loaded.id).toBe('s1')
    expect(loaded.messages[0]).toMatchObject({ role: 'user', content: 'hi' })
  })

  it('lists sessions with preview', () => {
    expect(listSessions(dir).length).toBe(1)
    expect(listSessions(dir)[0]!.preview).toBe('hi')
  })
})