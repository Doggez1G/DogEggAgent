import { describe, it, expect } from 'vitest'
import { parseCommand, matchCommands, COMMANDS } from '../../src/shared/commands'
import { isExpandable } from '../../src/shared/block'
import type { Block } from '../../src/shared/block'

describe('parseCommand', () => {
  it('空输入返回 user 空文本', () => {
    expect(parseCommand('')).toEqual({ kind: 'user', text: '' })
    expect(parseCommand('   ')).toEqual({ kind: 'user', text: '' })
  })

  it('非斜杠输入返回 user 消息', () => {
    expect(parseCommand('你好')).toEqual({ kind: 'user', text: '你好' })
    expect(parseCommand('帮我写代码')).toEqual({ kind: 'user', text: '帮我写代码' })
  })

  it('/new → new_session', () => {
    expect(parseCommand('/new')).toEqual({ kind: 'message', msg: { type: 'new_session' } })
  })

  it('/session → list_sessions', () => {
    expect(parseCommand('/session')).toEqual({ kind: 'message', msg: { type: 'list_sessions' } })
  })

  it('/config → config_request', () => {
    expect(parseCommand('/config')).toEqual({ kind: 'message', msg: { type: 'config_request' } })
  })

  it('/model → config_request', () => {
    expect(parseCommand('/model')).toEqual({ kind: 'message', msg: { type: 'config_request' } })
  })

  it('/clear → clear_history', () => {
    expect(parseCommand('/clear')).toEqual({ kind: 'message', msg: { type: 'clear_history' } })
  })

  it('/compact → compact_request', () => {
    expect(parseCommand('/compact')).toEqual({ kind: 'message', msg: { type: 'compact_request' } })
  })

  it('/cd 有参数 → set_cwd', () => {
    expect(parseCommand('/cd /home/user')).toEqual({ kind: 'message', msg: { type: 'set_cwd', path: '/home/user' } })
  })

  it('/cd 支持空格路径', () => {
    expect(parseCommand('/cd C:\\Program Files\\app')).toEqual({ kind: 'message', msg: { type: 'set_cwd', path: 'C:\\Program Files\\app' } })
  })

  it('/cd 无参数 → help', () => {
    expect(parseCommand('/cd')).toEqual({ kind: 'help' })
  })

  it('/context → context_request', () => {
    expect(parseCommand('/context')).toEqual({ kind: 'message', msg: { type: 'context_request' } })
  })

  it('/tools → tools_request', () => {
    expect(parseCommand('/tools')).toEqual({ kind: 'message', msg: { type: 'tools_request' } })
  })

  it('/system → system_request', () => {
    expect(parseCommand('/system')).toEqual({ kind: 'message', msg: { type: 'system_request' } })
  })

  it('/status → status_request', () => {
    expect(parseCommand('/status')).toEqual({ kind: 'message', msg: { type: 'status_request' } })
  })

  it('/log → log_request', () => {
    expect(parseCommand('/log')).toEqual({ kind: 'message', msg: { type: 'log_request' } })
  })

  it('/permissions → permissions_request', () => {
    expect(parseCommand('/permissions')).toEqual({ kind: 'message', msg: { type: 'permissions_request' } })
  })

  it('/quit → quit', () => {
    expect(parseCommand('/quit')).toEqual({ kind: 'message', msg: { type: 'quit' } })
  })

  it('/help → help', () => {
    expect(parseCommand('/help')).toEqual({ kind: 'help' })
  })

  it('未知命令 → unknown（UI 显式提示并保留输入，不吞成帮助页）', () => {
    expect(parseCommand('/xyz')).toEqual({ kind: 'unknown', cmd: '/xyz' })
  })
})

describe('matchCommands', () => {
  it('非 / 开头返回空', () => {
    expect(matchCommands('hello')).toEqual([])
  })

  it('精确匹配返回空（用户已打完）', () => {
    expect(matchCommands('/new')).toEqual([])
    expect(matchCommands('/help')).toEqual([])
  })

  it('前缀匹配返回候选项', () => {
    const matches = matchCommands('/s')
    const cmds = matches.map((m) => m.cmd)
    expect(cmds).toContain('/session')
    expect(cmds).toContain('/status')
    expect(cmds).toContain('/system')
  })

  it('/ 返回全部命令', () => {
    const matches = matchCommands('/')
    expect(matches).toHaveLength(COMMANDS.length)
  })

  it('逐步缩小范围', () => {
    expect(matchCommands('/se').map((m) => m.cmd)).toEqual(['/session'])
  })
})

describe('isExpandable', () => {
  it('thinking 有 full → true', () => {
    const b: Block = { kind: 'thinking', color: 'yellow', text: '摘要', full: '完整思考' }
    expect(isExpandable(b)).toBe(true)
  })

  it('tool 有 toolBody → true', () => {
    const b: Block = { kind: 'tool', color: 'cyan', text: '工具', toolBody: [{ text: 'x', kind: 'plain' }] }
    expect(isExpandable(b)).toBe(true)
  })

  it('thinking 无 full → false', () => {
    const b: Block = { kind: 'thinking', color: 'yellow', text: '摘要' }
    expect(isExpandable(b)).toBe(false)
  })

  it('tool 无 toolBody → false', () => {
    const b: Block = { kind: 'tool', color: 'cyan', text: '工具' }
    expect(isExpandable(b)).toBe(false)
  })

  it('assistant → false', () => {
    const b: Block = { kind: 'assistant', color: 'text', text: '回答' }
    expect(isExpandable(b)).toBe(false)
  })

  it('user → false', () => {
    const b: Block = { kind: 'user', color: 'accent', text: '问题' }
    expect(isExpandable(b)).toBe(false)
  })

  it('error → false', () => {
    const b: Block = { kind: 'error', color: 'red', text: '错误' }
    expect(isExpandable(b)).toBe(false)
  })

  it('notice → false', () => {
    const b: Block = { kind: 'notice', color: 'subtext', text: '提示' }
    expect(isExpandable(b)).toBe(false)
  })
})
