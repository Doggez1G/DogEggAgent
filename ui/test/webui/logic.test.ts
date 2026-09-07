import { describe, it, expect } from 'vitest'
import { applyToolStart, applyToolEnd, extractFilesTouched, type ToolCallEntry } from '../../src/webui/features/turn-tracking/logic/tool-tracking'
import type { AgentToUiMessage } from '@dogegg/bridge'

// 工具调用追踪的纯逻辑单测——覆盖 UI 状态归并里最复杂的分支。

const startMsg = (overrides: Partial<Extract<AgentToUiMessage, { type: 'tool_start' }>> = {}) =>
  ({ type: 'tool_start', id: 't1', name: 'edit_file', input: { path: 'a.ts' }, ...overrides }) as Extract<AgentToUiMessage, { type: 'tool_start' }>
const endMsg = (overrides: Partial<Extract<AgentToUiMessage, { type: 'tool_end' }>> = {}) =>
  ({ type: 'tool_end', id: 't1', name: 'edit_file', output: 'ok', ...overrides }) as Extract<AgentToUiMessage, { type: 'tool_end' }>

describe('applyToolStart', () => {
  it('追加 running 条目并记录决策与配置权限', () => {
    const next = applyToolStart([], startMsg(), 'allow_once', 'allow', 1)
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: 't1', name: 'edit_file', status: 'running', decision: 'allow_once', configPerm: 'allow', seq: 1 })
  })
})

describe('applyToolEnd', () => {
  it('正常路径：更新状态并保留原 decision', () => {
    const prev: ToolCallEntry[] = [{ id: 't1', name: 'edit_file', status: 'running', decision: 'allow_once', configPerm: 'ask', seq: 1 }]
    const next = applyToolEnd(prev, endMsg(), 'ask', 2)
    expect(next[0]).toMatchObject({ status: 'done', output: 'ok', decision: 'allow_once' })
  })
  it('denied 覆盖为 rejected（拒绝优先于原决策）', () => {
    const prev: ToolCallEntry[] = [{ id: 't1', name: 'edit_file', status: 'running', decision: 'allow_once', configPerm: 'ask', seq: 1 }]
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
