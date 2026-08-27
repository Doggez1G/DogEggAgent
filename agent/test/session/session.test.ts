import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { saveSession, loadSession, listSessions } from '../../src/session'

const dir = mkdtempSync(join(tmpdir(), 'dogegg-sess-'))

describe('session store', () => {
  it('R1: 双持久化 save/load（history + context）', () => {
    const history = [{ role: 'user' as const, content: 'hi' }]
    const context = [{ role: 'user' as const, content: 'hi' }]
    saveSession('s1', history, context, dir)
    const loaded = loadSession('s1', dir)
    expect(loaded.id).toBe('s1')
    expect(loaded.history[0]).toMatchObject({ role: 'user', content: 'hi' })
    expect(loaded.context[0]).toMatchObject({ role: 'user', content: 'hi' })
  })

  it('lists sessions with preview（取 history 末条）', () => {
    expect(listSessions(dir).length).toBe(1)
    expect(listSessions(dir)[0]!.preview).toBe('hi')
  })
})