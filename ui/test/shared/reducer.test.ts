import { describe, it, expect } from 'vitest'
import { reducer, type ChatState } from '../../src/shared/reducer'
import type { AgentToUiMessage } from '@dogegg/bridge'

const initial: ChatState = { blocks: [], status: 'idle', partial: null, toolActive: false }

// 辅助：构造一条已落盘的 assistant partial 状态。
function withPartial(kind: 'assistant' | 'thinking', text: string): ChatState {
  return { blocks: [], status: kind === 'thinking' ? 'thinking' : 'responding', partial: { kind, text }, toolActive: false }
}

describe('reducer — local_user', () => {
  it('追加 user block', () => {
    const state = reducer(initial, { type: 'local_user', text: '你好' })
    expect(state.blocks).toHaveLength(1)
    expect(state.blocks[0]).toMatchObject({ kind: 'user', text: '你好' })
    expect(state.partial).toBeNull()
  })
})

describe('reducer — text_delta', () => {
  it('累积到 assistant partial', () => {
    const state = reducer(initial, { type: 'text_delta', delta: 'hello' })
    expect(state.partial).toEqual({ kind: 'assistant', text: 'hello' })
    expect(state.status).toBe('responding')
  })

  it('连续 delta 累积', () => {
    let s = reducer(initial, { type: 'text_delta', delta: 'hello' })
    s = reducer(s, { type: 'text_delta', delta: ' world' })
    expect(s.partial).toEqual({ kind: 'assistant', text: 'hello world' })
  })

  it('partial 为 thinking 时先 flush 再开新 assistant partial', () => {
    const s = reducer(withPartial('thinking', '思考内容'), { type: 'text_delta', delta: '回答' })
    expect(s.partial).toEqual({ kind: 'assistant', text: '回答' })
    // thinking 被落盘为 block
    expect(s.blocks.some((b) => b.kind === 'thinking')).toBe(true)
  })
})

describe('reducer — thought_delta', () => {
  it('累积到 thinking partial', () => {
    const state = reducer(initial, { type: 'thought_delta', delta: '思考' })
    expect(state.partial).toEqual({ kind: 'thinking', text: '思考' })
    expect(state.status).toBe('thinking')
  })

  it('partial 为 assistant 时先 flush 再开新 thinking partial', () => {
    const s = reducer(withPartial('assistant', '回答内容'), { type: 'thought_delta', delta: '思考' })
    expect(s.partial).toEqual({ kind: 'thinking', text: '思考' })
    expect(s.blocks.some((b) => b.kind === 'assistant')).toBe(true)
  })
})

describe('reducer — message (assistant)', () => {
  it('flush partial 为 block', () => {
    const s = reducer(withPartial('assistant', '完整回答'), { type: 'message', role: 'assistant', id: 'm1' })
    expect(s.partial).toBeNull()
    expect(s.blocks.some((b) => b.kind === 'assistant' && b.text === '完整回答')).toBe(true)
  })

  it('role 非 assistant 不改 state', () => {
    const s = reducer(withPartial('assistant', '回答'), { type: 'message', role: 'tool', id: 't1' })
    expect(s).toEqual(withPartial('assistant', '回答'))
  })
})

describe('reducer — tool_pending', () => {
  it('记录正在生成参数的工具名', () => {
    const s = reducer(initial, { type: 'tool_pending', name: 'shell' })
    expect(s.pendingTool).toBe('shell')
    expect(s.blocks).toHaveLength(0) // 不产生块——只是动态区提示
  })

  it('tool_start 到达时清除 pendingTool 并创建真实工具块', () => {
    let s = reducer(initial, { type: 'tool_pending', name: 'shell' })
    s = reducer(s, { type: 'tool_start', id: 'tc1', name: 'shell', input: { command: 'ls' } })
    expect(s.pendingTool).toBeNull()
    expect(s.blocks.some((b) => b.kind === 'tool')).toBe(true)
  })

  it('错误到达时清除 pendingTool（轮次中断不留悬挂提示）', () => {
    let s = reducer(initial, { type: 'tool_pending', name: 'shell' })
    s = reducer(s, { type: 'error', error: { message: '流中断' } })
    expect(s.pendingTool).toBeNull()
  })

  it('cancelled 时清除 pendingTool', () => {
    let s = reducer(initial, { type: 'tool_pending', name: 'shell' })
    s = reducer(s, { type: 'state', from: 'responding', to: 'cancelled' })
    expect(s.pendingTool).toBeNull()
  })
})

describe('reducer — tool_start', () => {
  it('flush partial + 追加结构化 tool block', () => {
    const s = reducer(withPartial('assistant', '回答'), {
      type: 'tool_start', id: 'tc1', name: 'read_file', input: { path: 'a.txt' },
    })
    expect(s.partial).toBeNull()
    expect(s.status).toBe('executing')
    const tool = s.blocks.find((b) => b.kind === 'tool')
    expect(tool).toMatchObject({
      toolId: 'tc1',
      toolName: 'read_file',
      toolInput: { path: 'a.txt' },
      toolStatus: 'running',
      text: 'read_file a.txt', // shared/formatToolTitle 产物
    })
    expect(tool?.toolBody).toBeUndefined() // running 块不可展开
  })
})

describe('reducer — tool_end', () => {
  it('按 toolId 匹配更新 tool block（结构化结果 + 展开正文）', () => {
    let s = reducer(initial, { type: 'tool_start', id: 'tc1', name: 'read_file', input: { path: 'a.txt' } })
    s = reducer(s, { type: 'tool_end', id: 'tc1', name: 'read_file', output: '文件内容' })
    const tool = s.blocks.find((b) => b.toolId === 'tc1')
    expect(tool).toMatchObject({ toolStatus: 'done', toolOutput: '文件内容', toolName: 'read_file' })
    expect(tool?.text).toContain('1 行')
    expect(tool?.toolBody).toEqual([{ text: '文件内容', kind: 'plain' }])
    expect(s.toolActive).toBe(false)
  })

  it('denied 标记 rejected 状态（区别于一般失败）', () => {
    let s = reducer(initial, { type: 'tool_start', id: 'tc1', name: 'shell', input: { command: 'ls' } })
    s = reducer(s, { type: 'tool_end', id: 'tc1', name: 'shell', output: '', error: 'denied' })
    const tool = s.blocks.find((b) => b.toolId === 'tc1')
    expect(tool).toMatchObject({ toolStatus: 'rejected', toolError: 'denied' })
    expect(tool?.text).toContain('已拒绝')
    expect(tool?.toolBody?.[0]).toEqual({ text: '✕ denied', kind: 'plain' })
  })

  it('edit_file 的 toolBody 含 diff 着色行（del/add），头行带 diffstat', () => {
    let s = reducer(initial, { type: 'tool_start', id: 'tc1', name: 'edit_file', input: { path: 'a.ts', old_string: 'old', new_string: 'new' } })
    s = reducer(s, { type: 'tool_end', id: 'tc1', name: 'edit_file', output: 'done' })
    const tool = s.blocks.find((b) => b.toolId === 'tc1')
    expect(tool?.toolBody).toEqual([
      { text: '- old', kind: 'del' },
      { text: '+ new', kind: 'add' },
    ])
    expect(tool?.text).toContain('+1 -1')
  })

  it('未找到匹配 toolId 时不改 state', () => {
    const s1 = reducer(initial, { type: 'tool_start', id: 'tc1', name: 'read_file', input: {} })
    const s2 = reducer(s1, { type: 'tool_end', id: 'unknown', name: 'read_file', output: 'x' })
    expect(s2).toEqual(s1)
  })
})

describe('reducer — state', () => {
  it('cancelled 时 flush partial', () => {
    const s = reducer(withPartial('assistant', '半句话'), { type: 'state', from: 'responding', to: 'cancelled' })
    expect(s.partial).toBeNull()
    expect(s.status).toBe('cancelled')
    expect(s.blocks.some((b) => b.kind === 'assistant')).toBe(true)
  })

  it('idle 时 flush partial', () => {
    const s = reducer(withPartial('thinking', '思考中'), { type: 'state', from: 'thinking', to: 'idle' })
    expect(s.partial).toBeNull()
    expect(s.status).toBe('idle')
  })

  it('其他状态不 flush 只更新 status', () => {
    const s = reducer(withPartial('assistant', '回答'), { type: 'state', from: 'responding', to: 'thinking' })
    expect(s.partial).toEqual({ kind: 'assistant', text: '回答' })
    expect(s.status).toBe('thinking')
  })
})

describe('reducer — finished', () => {
  it('flush partial + 设 status', () => {
    const s = reducer(withPartial('assistant', '完成'), { type: 'finished' })
    expect(s.partial).toBeNull()
    expect(s.status).toBe('finished')
  })
})

describe('reducer — error', () => {
  it('flush partial + 追加 error block', () => {
    const s = reducer(withPartial('assistant', '半句'), { type: 'error', error: { message: '出错了' } })
    expect(s.partial).toBeNull()
    expect(s.status).toBe('error')
    expect(s.blocks.some((b) => b.kind === 'error' && b.text === '出错了')).toBe(true)
    // partial 内容也被保留为 block
    expect(s.blocks.some((b) => b.kind === 'assistant')).toBe(true)
  })
})

describe('reducer — notice', () => {
  it('追加 notice block 不改 status', () => {
    const s = reducer(initial, { type: 'notice', text: '提示信息' })
    expect(s.blocks).toHaveLength(1)
    expect(s.blocks[0]).toMatchObject({ kind: 'notice', text: '提示信息' })
    expect(s.status).toBe('idle')
  })
})

describe('reducer — session_ready', () => {
  it('重建 blocks + 清空 partial', () => {
    const s = reducer(withPartial('assistant', '残留'), {
      type: 'session_ready', id: 's1', messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！' },
      ],
    })
    expect(s.partial).toBeNull()
    expect(s.status).toBe('idle')
    expect(s.blocks).toHaveLength(2)
    expect(s.blocks[0]).toMatchObject({ kind: 'user', text: '你好' })
    expect(s.blocks[1]).toMatchObject({ kind: 'assistant', text: '你好！' })
  })

  it('thinking 对齐：空字符串条目不显示思考块', () => {
    const s = reducer(initial, {
      type: 'session_ready', id: 's1',
      messages: [
        { role: 'user', content: '问' },
        { role: 'assistant', content: '答' },
      ],
      thinking: [{ text: '' }],
    })
    expect(s.blocks.some((b) => b.kind === 'thinking')).toBe(false)
    expect(s.blocks).toHaveLength(2)
  })

  it('thinking 对齐：非空条目显示思考块', () => {
    const s = reducer(initial, {
      type: 'session_ready', id: 's1',
      messages: [
        { role: 'user', content: '问' },
        { role: 'assistant', content: '答' },
      ],
      thinking: [{ text: '这是思考内容' }],
    })
    expect(s.blocks.some((b) => b.kind === 'thinking')).toBe(true)
    expect(s.blocks).toHaveLength(3) // thinking + user + assistant
  })

  it('thinking 对齐：混合会话（先空后非空）', () => {
    const s = reducer(initial, {
      type: 'session_ready', id: 's1',
      messages: [
        { role: 'user', content: '问1' },
        { role: 'assistant', content: '答1' },
        { role: 'user', content: '问2' },
        { role: 'assistant', content: '答2' },
      ],
      thinking: [{ text: '' }, { text: '第二轮思考' }],
    })
    // 第一轮无思考，第二轮有思考
    const thinkingBlocks = s.blocks.filter((b) => b.kind === 'thinking')
    expect(thinkingBlocks).toHaveLength(1)
    expect(thinkingBlocks[0]?.full).toBe('第二轮思考')
  })

  it('tool_calls 的 assistant 消息也消费 thinking 条目', () => {
    const s = reducer(initial, {
      type: 'session_ready', id: 's1',
      messages: [
        { role: 'user', content: '读文件' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '文件内容' },
        { role: 'assistant', content: '这是文件内容' },
      ],
      thinking: [{ text: '决定读文件' }, { text: '总结文件内容' }],
    })
    // 两条 assistant 消息各消费一个 thinking 条目
    const thinkingBlocks = s.blocks.filter((b) => b.kind === 'thinking')
    expect(thinkingBlocks).toHaveLength(2)
    // tool_calls assistant（content=null）消费第一个 thinking
    expect(thinkingBlocks[0]?.full).toBe('决定读文件')
    // 最终回复 assistant 消费第二个 thinking
    expect(thinkingBlocks[1]?.full).toBe('总结文件内容')
  })

  it('tool 块从 tool_calls + tool 消息配对重建', () => {
    const s = reducer(initial, {
      type: 'session_ready', id: 's1',
      messages: [
        { role: 'user', content: '读文件' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '文件内容' },
      ],
    })
    const tool = s.blocks.find((b) => b.kind === 'tool')
    expect(tool).toMatchObject({
      toolName: 'read_file',
      toolInput: { path: 'a.txt' },
      toolStatus: 'done',
      toolOutput: '文件内容',
    })
    expect(tool?.text).toContain('a.txt')
    expect(tool?.toolBody).toEqual([{ text: '文件内容', kind: 'plain' }])
  })
})

describe('reducer — compaction', () => {
  it('auto 来源显示 compacted 文案', () => {
    const s = reducer(initial, { type: 'compaction', before_tokens: 5000, after_tokens: 1000, source: 'auto' })
    expect(s.blocks[0]?.text).toContain('compacted')
    expect(s.blocks[0]?.text).toContain('5000')
    expect(s.blocks[0]?.text).toContain('1000')
  })

  it('manual 来源显示 compacted 文案', () => {
    const s = reducer(initial, { type: 'compaction', before_tokens: 5000, after_tokens: 1000, source: 'manual' })
    expect(s.blocks[0]?.text).toContain('compacted')
    expect(s.blocks[0]?.text).not.toContain('auto')
  })
})

describe('reducer — history_cleared', () => {
  it('flush partial + 替换为 notice block', () => {
    const s = reducer(withPartial('assistant', '残留'), { type: 'history_cleared' })
    expect(s.partial).toBeNull()
    expect(s.blocks).toHaveLength(1)
    expect(s.blocks[0]).toMatchObject({ kind: 'notice', text: 'History cleared' })
  })
})

describe('reducer — 不产生 block 的消息类型', () => {
  const noChangeTypes: AgentToUiMessage[] = [
    { type: 'tools_list', tools: [] },
    { type: 'status_state', sessionId: 's1', provider: 'p', model: 'm', cwd: '/', state: 'idle', estimatedTokens: 0, windowTokens: 1000 },
    { type: 'context_state', estimatedTokens: 0, windowTokens: 1000, percent: 0 },
    { type: 'system_state', path: '/p', content: 'c' },
    { type: 'log_state', path: '/l', tail: 't' },
  ]
  for (const msg of noChangeTypes) {
    it(`${msg.type} 不改 state`, () => {
      const s = reducer(initial, msg)
      expect(s).toEqual(initial)
    })
  }
})
