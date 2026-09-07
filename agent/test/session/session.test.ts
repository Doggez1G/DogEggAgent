import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { SessionStore } from '../../src/session'

const dir = mkdtempSync(join(tmpdir(), 'dogegg-sess-'))
const store = new SessionStore(dir)

describe('SessionStore', () => {
  it('R1: 双持久化 save/load（history + context）', () => {
    const history = [{ role: 'user' as const, content: 'hi' }]
    const context = [{ role: 'user' as const, content: 'hi' }]
    store.save({ id: 's1', history, context, allowedTools: [], cwd: '', thinking: [] })
    const loaded = store.load('s1')
    expect(loaded.id).toBe('s1')
    expect(loaded.history[0]).toMatchObject({ role: 'user', content: 'hi' })
    expect(loaded.context[0]).toMatchObject({ role: 'user', content: 'hi' })
  })

  it('lists sessions with preview（取 history 末条）', () => {
    expect(store.list().length).toBe(1)
    expect(store.list()[0]!.preview).toBe('hi')
  })
})
