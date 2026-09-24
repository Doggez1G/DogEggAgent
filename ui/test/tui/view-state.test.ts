import { describe, it, expect } from 'vitest'
import type { AgentToUiMessage } from '@dogegg/bridge'
import { refreshPanelsDeep, type View, type SkillEntry } from '../../src/tui/view-state'
import { mergeStatusBarData, type StatusBarData } from '../../src/tui/app/use-agent-events'

// 视图事件域纯函数单测：
// - refreshPanelsDeep：skills_list/mcp_list 广播沿 returnView 链刷新面板快照（esc 返回不看过期列表）；
// - mergeStatusBarData：status_state 合并保留 title（/status 不再清空状态栏会话名）。

const skill = (name: string): SkillEntry => ({ name, description: '', scope: 'project', path: '', enabled: true, missing: false })

describe('refreshPanelsDeep', () => {
  // 更新函数：skills 面板换成新清单并夹取 cursor（与 use-agent-events 的接线同款）。
  const update = (v: View): View =>
    v.kind === 'skills' ? { ...v, skills: [skill('new-skill')], cursor: Math.min(v.cursor, 0) } : v

  it('顶层是 skills：直接更新', () => {
    const view: View = { kind: 'skills', cursor: 2, skills: [skill('a'), skill('b')] }
    const next = refreshPanelsDeep(view, 'skills', update)
    expect(next).toMatchObject({ kind: 'skills', cursor: 0 })
    expect((next as Extract<View, { kind: 'skills' }>).skills.map((s) => s.name)).toEqual(['new-skill'])
  })

  it('挂在 menu → info 链上的 skills 面板被刷新（esc 返回看到新列表）', () => {
    const skillsView: View = { kind: 'skills', cursor: 0, skills: [skill('old')] }
    const view: View = {
      kind: 'menu', title: '顶层菜单', items: [{ label: 'a', onSelect: () => {} }], cursor: 0,
      returnView: { kind: 'info', title: '详情', lines: ['x'], returnView: skillsView },
    }
    const next = refreshPanelsDeep(view, 'skills', update)
    // 顶层 menu 不匹配但因子树变更而重建，链上的 skills 快照已更新。
    expect(next.kind).toBe('menu')
    const inner = (next as Extract<View, { kind: 'menu' }>).returnView
    expect(inner!.kind).toBe('info')
    const panel = (inner as Extract<View, { kind: 'info' }>).returnView
    expect((panel as Extract<View, { kind: 'skills' }>).skills.map((s) => s.name)).toEqual(['new-skill'])
  })

  it('挂在 permission / form 的 returnView 链上同样刷新', () => {
    const skillsView: View = { kind: 'skills', cursor: 0, skills: [skill('old')] }
    const permView: View = { kind: 'permission', id: 'p1', tool: 'shell', input: null, cursor: 0, returnView: skillsView }
    const next = refreshPanelsDeep(permView, 'skills', update)
    const panel = (next as Extract<View, { kind: 'permission' }>).returnView as Extract<View, { kind: 'skills' }>
    expect(panel.skills.map((s) => s.name)).toEqual(['new-skill'])

    const formView: View = {
      kind: 'form', title: '表单', fields: [{ label: '名称', value: '' }], cursor: 0,
      returnView: { kind: 'skills', cursor: 0, skills: [skill('old')] },
      submitLabel: 'ok', onSubmit: () => {},
    }
    const next2 = refreshPanelsDeep(formView, 'skills', update)
    const panel2 = (next2 as Extract<View, { kind: 'form' }>).returnView as Extract<View, { kind: 'skills' }>
    expect(panel2.skills.map((s) => s.name)).toEqual(['new-skill'])
  })

  it('无任何匹配：返回原引用（不触发无谓重渲染）', () => {
    const view: View = { kind: 'menu', title: 't', items: [{ label: 'a', onSelect: () => {} }], cursor: 0, returnView: { kind: 'info', title: 'i', lines: [] } }
    expect(refreshPanelsDeep(view, 'skills', update)).toBe(view)
  })

  it('子树无变化时保持父引用不变（逐层短路）', () => {
    const untouched: View = { kind: 'skills', cursor: 0, skills: [skill('old')] }
    const view: View = {
      kind: 'menu', title: 't', items: [{ label: 'a', onSelect: () => {} }], cursor: 0,
      returnView: { kind: 'info', title: 'i', lines: [], returnView: untouched },
    }
    const next = refreshPanelsDeep(view, 'mcp', update) // 找的是 mcp，链上只有 skills → 全链无匹配
    expect(next).toBe(view)
  })
})

describe('mergeStatusBarData', () => {
  const msg = {
    type: 'status_state' as const,
    sessionId: 's1', provider: 'openai', model: 'gpt-x', cwd: '/w',
    state: 'idle' as const, estimatedTokens: 120, windowTokens: 1000,
    usage: { promptTokens: 10, completionTokens: 20, turns: 2 },
  } as Extract<AgentToUiMessage, { type: 'status_state' }>

  it('更新 status_state 负责的字段', () => {
    const next = mergeStatusBarData({}, msg)
    expect(next).toMatchObject({ provider: 'openai', model: 'gpt-x', sessionId: 's1', tokens: 120, windowTokens: 1000, cwd: '/w' })
    expect(next.usage).toEqual({ promptTokens: 10, completionTokens: 20, turns: 2 })
  })

  it('关键回归：保留 prev 中的 title（/status 不再清空状态栏会话名）', () => {
    const prev: StatusBarData = { sessionId: 's0', title: '修复登录 bug' }
    const next = mergeStatusBarData(prev, msg)
    expect(next.title).toBe('修复登录 bug')
    expect(next.sessionId).toBe('s1')
  })
})
