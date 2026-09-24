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

// ─────────────────────────────────────────────────────────────────────────────
// preview 口径（P3 修复回归）：从尾部向前找首条非 tool 且 content 为非空 string 的消息——
// 轮次收尾时 history 常以 tool 消息结尾（工具任务刚结束），只看末条会得到空 preview。
// ─────────────────────────────────────────────────────────────────────────────
describe('SessionStore preview 口径', () => {
  const dir3 = mkdtempSync(join(tmpdir(), 'dogegg-sess-p-'))
  const store3 = new SessionStore(dir3)

  it('history 以 tool 结尾时，preview 回退到末条非 tool 消息', () => {
    store3.save({
      id: 'p1',
      history: [
        { role: 'user', content: '帮我读文件' },
        { role: 'assistant', content: '好的，我来读取' },
        { role: 'tool', tool_call_id: 'c1', content: '文件内容……' },
      ],
      context: [],
      sessionPermissions: [],
      usage: { promptTokens: 0, completionTokens: 0, turns: 0 },
      compactions: 0,
      cwd: '',
      thinking: [],
    })
    expect(store3.list().find((s) => s.id === 'p1')!.preview).toBe('好的，我来读取')
  })

  it('尾部非 tool 但 content 为空串的跳过；tool 后紧邻 assistant 正常命中', () => {
    store3.save({
      id: 'p2',
      history: [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '' },
        { role: 'assistant', content: '最终回答' },
      ],
      context: [],
      sessionPermissions: [],
      usage: { promptTokens: 0, completionTokens: 0, turns: 0 },
      compactions: 0,
      cwd: '',
      thinking: [],
    })
    expect(store3.list().find((s) => s.id === 'p2')!.preview).toBe('最终回答')
  })
})
