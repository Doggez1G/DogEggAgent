import { describe, it, expect } from 'vitest'
import { applyToolStart, applyToolEnd, extractFilesTouched, type ToolCallEntry } from '../../src/webui/features/turn-tracking/logic/tool-tracking'
import { effectivePerm, displayPerm } from '../../src/shared/permission'
import type { AgentToUiMessage } from '@dogegg/bridge'

// 工具调用追踪的纯逻辑单测——覆盖 UI 状态归并里最复杂的分支。

const startMsg = (overrides: Partial<Extract<AgentToUiMessage, { type: 'tool_start' }>> = {}) =>
  ({ type: 'tool_start', id: 't1', name: 'edit_file', input: { path: 'a.ts' }, ...overrides }) as Extract<AgentToUiMessage, { type: 'tool_start' }>
const endMsg = (overrides: Partial<Extract<AgentToUiMessage, { type: 'tool_end' }>> = {}) =>
  ({ type: 'tool_end', id: 't1', name: 'edit_file', output: 'ok', ...overrides }) as Extract<AgentToUiMessage, { type: 'tool_end' }>

describe('applyToolStart', () => {
  it('追加 running 条目并记录决策与生效权限快照', () => {
    const next = applyToolStart([], startMsg(), 'allow_once', 'allow', 1)
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: 't1', name: 'edit_file', status: 'running', decision: 'allow_once', perm: 'allow', seq: 1 })
  })
})

describe('applyToolEnd', () => {
  it('正常路径：更新状态并保留原 decision', () => {
    const prev: ToolCallEntry[] = [{ id: 't1', name: 'edit_file', status: 'running', decision: 'allow_once', perm: 'ask', seq: 1 }]
    const next = applyToolEnd(prev, endMsg(), 'ask', 2)
    expect(next[0]).toMatchObject({ status: 'done', output: 'ok', decision: 'allow_once' })
  })
  it('更新 perm 为执行结束时的生效权限快照', () => {
    const prev: ToolCallEntry[] = [{ id: 't1', name: 'shell', status: 'running', decision: 'allow_always', perm: 'ask', seq: 1 }]
    const next = applyToolEnd(prev, endMsg({ name: 'shell' }), 'always', 2)
    expect(next[0]).toMatchObject({ status: 'done', perm: 'always', decision: 'allow_always' })
  })
  it('denied 覆盖为 rejected（拒绝优先于原决策）', () => {
    const prev: ToolCallEntry[] = [{ id: 't1', name: 'edit_file', status: 'running', decision: 'allow_once', perm: 'ask', seq: 1 }]
    const next = applyToolEnd(prev, endMsg({ error: 'denied' }), 'ask', 2)
    expect(next[0]).toMatchObject({ status: 'rejected', decision: 'reject' })
  })
  it('孤儿 tool_end（被拒绝/未知工具）创建 rejected 条目', () => {
    const next = applyToolEnd([], endMsg({ error: 'denied' }), 'ask', 1)
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ status: 'rejected', decision: 'reject' })
  })
})

describe('extractFilesTouched', () => {
  it('edit_file / write_file 提取路径', () => {
    expect(extractFilesTouched(startMsg())!).toMatchObject({ path: 'a.ts', action: 'edit' })
    expect(extractFilesTouched(startMsg({ name: 'write_file', input: { path: 'b.ts' } }))!).toMatchObject({ path: 'b.ts', action: 'write' })
  })
  it('其它工具 / 无路径返回 null', () => {
    expect(extractFilesTouched(startMsg({ name: 'shell', input: { command: 'ls' } }))).toBeNull()
    expect(extractFilesTouched(startMsg({ input: {} }))).toBeNull()
  })
})

describe('effectivePerm', () => {
  // v2 grouped 形态：桶 → 工具 → 模式数组（空数组 = 整工具）。
  const cfg = { allow: { read_file: [] }, reject: {}, ask: { shell: [] } }
  it('配置桶优先：allow/reject/ask 原样返回', () => {
    expect(effectivePerm(cfg, 'read_file', new Map())).toBe('allow')
    expect(effectivePerm(cfg, 'shell', new Map())).toBe('ask')
    expect(effectivePerm({ allow: {}, reject: { shell: [] }, ask: {} }, 'shell', new Map())).toBe('reject')
  })
  it('会话内 allow_always 提升显示为 always（区别于配置永久 allow）', () => {
    expect(effectivePerm(cfg, 'shell', new Map([['shell', []]]))).toBe('always')
  })
  it('配置 allow 与会话提升同时存在时显示 allow（配置来源优先）', () => {
    expect(effectivePerm({ allow: { shell: [] }, reject: {}, ask: {} }, 'shell', new Map([['shell', []]]))).toBe('allow')
  })
  it('模式数组工具在 display（无参数）下保守回落默认 ask', () => {
    expect(effectivePerm({ allow: { shell: ['git *'] }, reject: {}, ask: {} }, 'shell', new Map())).toBe('ask')
  })
})

describe('displayPerm', () => {
  it('显式决策优先：once / always / rejected', () => {
    expect(displayPerm({ perm: 'ask', decision: 'allow_once' })).toBe('once')
    expect(displayPerm({ perm: 'ask', decision: 'allow_always' })).toBe('always')
    expect(displayPerm({ perm: 'ask', decision: 'reject' })).toBe('rejected')
  })
  it('无决策回落生效权限快照（含会话提升的 always）', () => {
    expect(displayPerm({ perm: 'allow' })).toBe('allow')
    expect(displayPerm({ perm: 'reject' })).toBe('reject')
    // 关键回归：allow_always 之后的后续调用无决策、perm=always——不能落回 'ask'
    expect(displayPerm({ perm: 'always' })).toBe('always')
    expect(displayPerm({ perm: 'ask' })).toBe('ask')
  })
})
