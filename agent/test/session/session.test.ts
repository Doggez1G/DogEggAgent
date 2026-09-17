import { mkdtempSync, writeFileSync } from 'node:fs'
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
    store.save({ id: 's1', history, context, sessionPermissions: [], usage: { promptTokens: 100, completionTokens: 20, turns: 1 }, compactions: 0, cwd: '', thinking: [] })
    const loaded = store.load('s1')
    expect(loaded.id).toBe('s1')
    expect(loaded.usage).toEqual({ promptTokens: 100, completionTokens: 20, turns: 1 })
    expect(loaded.history[0]).toMatchObject({ role: 'user', content: 'hi' })
    expect(loaded.context[0]).toMatchObject({ role: 'user', content: 'hi' })
  })

  it('lists sessions with preview（取 history 末条）', () => {
    expect(store.list().length).toBe(1)
    expect(store.list()[0]!.preview).toBe('hi')
  })
})

describe('SessionStore title（会话标题往返）', () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'dogegg-sess-t-'))
  const store2 = new SessionStore(dir2)
  const base = { id: 't1', history: [], context: [], sessionPermissions: [], usage: { promptTokens: 0, completionTokens: 0, turns: 0 }, compactions: 0, cwd: '', thinking: [] }

  it('title 随快照 save/load 往返，list 摘要携带', () => {
    store2.save({ ...base, title: '我的标题' })
    expect(store2.load('t1').title).toBe('我的标题')
    expect(store2.list().find((s) => s.id === 't1')?.title).toBe('我的标题')
  })

  it('旧快照无 title 字段 → 加载为 undefined（不报错）', () => {
    // 手写一份无 title 的旧格式快照——兼容 M2.5 之前的会话文件。
    writeFileSync(join(dir2, 'legacy.json'), JSON.stringify({ id: 'legacy', history: [], context: [] }))
    expect(store2.load('legacy').title).toBeUndefined()
  })
})
