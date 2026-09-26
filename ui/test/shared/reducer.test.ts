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

describe('reducer — stream_reset', () => {
  it('清空 assistant partial 且不落盘、不产生新块', () => {
    const s = reducer(withPartial('assistant', '第一次尝试的残文'), { type: 'stream_reset' })
    expect(s.partial).toBeNull()
    expect(s.blocks).toHaveLength(0)
    expect(s.status).toBe('responding') // 不动 status（cancelled/idle 的强制 flush 立法不受影响）
  })

  it('清空 thinking partial 且不落盘', () => {
    const s = reducer(withPartial('thinking', '残思'), { type: 'stream_reset' })
    expect(s.partial).toBeNull()
    expect(s.blocks).toHaveLength(0)
  })

  it('reset 后的新 delta 从零累积（不拼接残文——展示与持久化不分叉）', () => {
    let s = reducer(withPartial('assistant', '残文'), { type: 'stream_reset' })
    s = reducer(s, { type: 'text_delta', delta: '新' })
    expect(s.partial).toEqual({ kind: 'assistant', text: '新' })
  })

  it('同时清空 pendingTool（重试后模型改吐纯文本时「准备调用 X」不悬挂到轮末）', () => {
    let s = reducer(initial, { type: 'tool_pending', name: 'shell' })
    s = reducer(s, { type: 'stream_reset' })
    expect(s.pendingTool).toBeNull()
    // 不产生块、不清 partial 之外的东西——下一次 tool_call_start/tool_pending 会重新设置。
    expect(s.blocks).toHaveLength(0)
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

describe('reducer — message (user)：回声去重与实时插入', () => {
  // 立法（reducer message 分支）：user message 事件携带 text 原文——末尾已是同文本 user 块
  // 视为本端乐观插入（local_user）的回声，忽略；否则实时插入（invoke_skill 的用户轮次、
  // 其它标签页看远端用户消息，否则要等下次 session_ready 才可见）。text 缺省维持忽略旧行为。
  it('回声去重：本端乐观插入后，同文本 user 回声不重复插入', () => {
    let s = reducer(initial, { type: 'local_user', text: '你好' })
    s = reducer(s, { type: 'message', role: 'user', id: 'm1', text: '你好' })
    expect(s.blocks).toHaveLength(1)
    expect(s.blocks[0]).toMatchObject({ kind: 'user', color: 'accent', text: '你好' })
  })

  it('invoke_skill 场景：无乐观插入，用户轮次实时插入（不必等 session_ready 重建）', () => {
    const s = reducer(initial, { type: 'message', role: 'user', id: 'm1', text: '/translate 展开后的正文' })
    expect(s.blocks).toHaveLength(1)
    expect(s.blocks[0]).toMatchObject({ kind: 'user', color: 'accent', text: '/translate 展开后的正文' })
  })

  it('末尾是不同文本的 user 块时不误吞（多标签：远端用户消息照常插入）', () => {
    let s = reducer(initial, { type: 'local_user', text: '本端的提问' })
    s = reducer(s, { type: 'message', role: 'user', id: 'm2', text: '另一标签的提问' })
    expect(s.blocks).toHaveLength(2)
    expect(s.blocks[0]).toMatchObject({ kind: 'user', text: '本端的提问' })
    expect(s.blocks[1]).toMatchObject({ kind: 'user', text: '另一标签的提问' })
  })

  it('末尾是 assistant 等非 user 块时照常插入（flush 后的轮次间消息不丢）', () => {
    let s = reducer(withPartial('assistant', '上一轮的回答'), { type: 'message', role: 'assistant', id: 'a1' })
    expect(s.blocks).toHaveLength(1) // flush 落盘 assistant
    s = reducer(s, { type: 'message', role: 'user', id: 'm1', text: '新一轮的提问' })
    expect(s.blocks).toHaveLength(2)
    expect(s.blocks[0]).toMatchObject({ kind: 'assistant', text: '上一轮的回答' })
    expect(s.blocks[1]).toMatchObject({ kind: 'user', text: '新一轮的提问' })
  })

  it('text 缺省（旧发射点）维持忽略旧行为——不产生空文本块', () => {
    let s = reducer(initial, { type: 'local_user', text: '你好' })
    s = reducer(s, { type: 'message', role: 'user', id: 'm1' })
    expect(s.blocks).toHaveLength(1)
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
    expect(tool?.toolBody).toEqual([{ text: '文件内容', no: 1, kind: 'plain' }])
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
})

describe('reducer — tool_end（孤儿，无配对 tool_start）', () => {
  // R3 立法：拒绝也发 tool_end（无 tool_start）——reducer 兜底生成完整 tool 块，
  // 不再静默丢弃（旧行为：聊天区零反馈 + pendingTool 悬挂）。
  it('tool_pending 状态下收到孤儿 denied tool_end → 新增 rejected 块且 pendingTool 清空', () => {
    let s = reducer(initial, { type: 'tool_pending', name: 'shell' })
    s = reducer(s, { type: 'tool_end', id: 'tc9', name: 'shell', output: '', error: 'denied' })
    expect(s.pendingTool).toBeNull()
    expect(s.blocks).toHaveLength(1)
    const tool = s.blocks[0]!
    expect(tool).toMatchObject({
      kind: 'tool', toolId: 'tc9', toolName: 'shell',
      toolStatus: 'rejected', toolError: 'denied', toolOutput: '',
    })
    expect(tool.text).toContain('已拒绝')
    expect(tool.toolBody?.[0]).toEqual({ text: '✕ denied', kind: 'plain' })
  })

  it('非 denied 孤儿 → error 块（区别于用户拒绝）', () => {
    const s = reducer(initial, { type: 'tool_end', id: 'tc9', name: 'shell', output: '', error: '执行超时' })
    expect(s.blocks).toHaveLength(1)
    expect(s.blocks[0]).toMatchObject({ kind: 'tool', toolId: 'tc9', toolStatus: 'error', toolError: '执行超时' })
  })

  it('tool_end 不带名时回退 pendingTool 标签', () => {
    let s = reducer(initial, { type: 'tool_pending', name: 'read_file' })
    s = reducer(s, { type: 'tool_end', id: 'tc9', name: '', output: '', error: 'denied' })
    expect(s.blocks[0]).toMatchObject({ kind: 'tool', toolName: 'read_file', toolStatus: 'rejected' })
  })

  it('孤儿到达时未落盘的 partial 先 flush（助手文本在工具块之前）', () => {
    const s = reducer(withPartial('assistant', '半句话'), { type: 'tool_end', id: 'tc9', name: 'shell', output: '', error: 'denied' })
    expect(s.blocks).toHaveLength(2)
    expect(s.blocks[0]).toMatchObject({ kind: 'assistant', text: '半句话' })
    expect(s.blocks[1]).toMatchObject({ kind: 'tool', toolStatus: 'rejected' })
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
      type: 'session_ready', id: 's1', busy: false, messages: [
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
      type: 'session_ready', id: 's1', busy: false,
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
      type: 'session_ready', id: 's1', busy: false,
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
      type: 'session_ready', id: 's1', busy: false,
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
      type: 'session_ready', id: 's1', busy: false,
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
      type: 'session_ready', id: 's1', busy: false,
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
    expect(tool?.toolBody).toEqual([{ text: '文件内容', no: 1, kind: 'plain' }])
  })
})

describe('reducer — session_ready busy（运行中保真）', () => {
  // 立法：恢复链快照不得把 UI 打回 idle——运行中刷新页面/新标签接入时，busy=true 的快照
  // 先落到「运行中」形态（thinking），随后的 status_state 推送校正为真实 machine state。
  it('busy=true：status 不落 idle（落 thinking——输入框不误启用），blocks 照常重建', () => {
    const s = reducer(withPartial('assistant', '残留'), {
      type: 'session_ready', id: 's1', busy: true,
      messages: [{ role: 'user', content: '运行中的提问' }],
    })
    expect(s.status).toBe('thinking')
    expect(s.partial).toBeNull()
    expect(s.blocks).toHaveLength(1)
    expect(s.blocks[0]).toMatchObject({ kind: 'user', text: '运行中的提问' })
  })

  it('busy=false：status 为 idle（与既有行为一致）', () => {
    const s = reducer(initial, { type: 'session_ready', id: 's1', busy: false, messages: [] })
    expect(s.status).toBe('idle')
    expect(s.blocks).toHaveLength(0)
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
    { type: 'context_state', estimatedTokens: 0, windowTokens: 1000, percent: 0, compactions: 0 },
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

describe('reducer — 块 id（单调递增，全分支赋值）', () => {
  // 立法：所有新建块（local_user/flush/tool_start/孤儿 tool_end/error/notice/compaction/
  // session_ready 重建/history_cleared 替换）统一经 allocId/appendBlock 分配 id，
  // WebUI 用 b.id 作 React key——整体替换 blocks 时下标 key 会错位复用组件实例。
  it('local_user → tool_start → notice 各块 id 严格递增', () => {
    let s = reducer(initial, { type: 'local_user', text: '问' })
    s = reducer(s, { type: 'tool_start', id: 'tc1', name: 'shell', input: { command: 'ls' } })
    s = reducer(s, { type: 'notice', text: '运行中提示' })
    expect(s.blocks.map((b) => b.id)).toEqual([0, 1, 2])
  })

  it('error 一轮双块（flush 的 assistant + error 块）共用同一条序号线，不重号', () => {
    const s = reducer(withPartial('assistant', '半句'), { type: 'error', error: { message: '出错了' } })
    expect(s.blocks.map((b) => b.id)).toEqual([0, 1])
    expect(s.blocks[0]).toMatchObject({ kind: 'assistant' })
    expect(s.blocks[1]).toMatchObject({ kind: 'error' })
  })

  it('tool_end 就地更新不改变块 id（tool_start 与 tool_end 是同一块）', () => {
    let s = reducer(initial, { type: 'tool_start', id: 'tc1', name: 'shell', input: { command: 'ls' } })
    const startId = s.blocks.find((b) => b.toolId === 'tc1')?.id
    expect(startId).toBeDefined()
    s = reducer(s, { type: 'tool_end', id: 'tc1', name: 'shell', output: 'ok' })
    expect(s.blocks.find((b) => b.toolId === 'tc1')?.id).toBe(startId)
  })

  it('孤儿 tool_end 的兜底块、compaction 提示块都拿 id', () => {
    const orphan = reducer(initial, { type: 'tool_end', id: 'tc9', name: 'shell', output: '', error: 'denied' })
    expect(orphan.blocks[0]?.id).toBe(0)
    const compact = reducer(initial, { type: 'compaction', before_tokens: 10, after_tokens: 5, source: 'auto' })
    expect(compact.blocks[0]?.id).toBe(0)
  })

  it('session_ready 重建块接续 state.nextId（跨会话单调），重建后追加不重号', () => {
    let s = reducer(initial, { type: 'local_user', text: '旧会话的块' }) // id 0，nextId → 1
    s = reducer(s, {
      type: 'session_ready', id: 's1', busy: false,
      messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好！' }],
    })
    expect(s.blocks.map((b) => b.id)).toEqual([1, 2])
    s = reducer(s, { type: 'notice', text: '重建后追加' })
    expect(s.blocks[2]?.id).toBe(3)
  })

  it('history_cleared 的替换块也拿 id（接续 flush 推进后的序号）', () => {
    // withPartial 无 nextId：flush 先落盘 assistant（id 0），替换的 notice 块拿 id 1。
    let s = reducer(withPartial('assistant', '残留'), { type: 'history_cleared' })
    expect(s.blocks).toHaveLength(1)
    expect(s.blocks[0]?.id).toBe(1)
    s = reducer(s, { type: 'notice', text: '后续' })
    expect(s.blocks[1]?.id).toBe(2)
  })
})

describe('reducer — 终态防御复位 toolActive（P2-38）', () => {
  // 立法：R3+try/catch 下 tool_end 总会发出（匹配分支会清 toolActive），三个终止分支补复位
  // 是零成本兜底——防 emit 链路抛错等极端路径把 running 态残留到下一轮。
  const runningSetup = (): ChatState => {
    const s = reducer(initial, { type: 'tool_start', id: 'tc1', name: 'shell', input: { command: 'ls' } })
    expect(s.toolActive).toBe(true)
    return s
  }

  it('state → cancelled 复位', () => {
    const s = reducer(runningSetup(), { type: 'state', from: 'executing', to: 'cancelled' })
    expect(s.toolActive).toBe(false)
    expect(s.status).toBe('cancelled')
  })

  it('state → idle 复位', () => {
    const s = reducer(runningSetup(), { type: 'state', from: 'executing', to: 'idle' })
    expect(s.toolActive).toBe(false)
    expect(s.status).toBe('idle')
  })

  it('finished 复位', () => {
    const s = reducer(runningSetup(), { type: 'finished' })
    expect(s.toolActive).toBe(false)
    expect(s.status).toBe('finished')
  })

  it('error 复位（且不影响 error 块的追加）', () => {
    const s = reducer(runningSetup(), { type: 'error', error: { message: '流中断' } })
    expect(s.toolActive).toBe(false)
    expect(s.blocks.some((b) => b.kind === 'error')).toBe(true)
  })
})

describe('reducer — session_ready live 恢复（P2-23）', () => {
  // 立法：live 是「运行中保真」的下半场——快照携带的现场让新接入端无缝接住正在进行的流。
  it('busy + live.partial：恢复为流式中的 assistant partial，后续 text_delta 续拼', () => {
    let s = reducer(initial, {
      type: 'session_ready', id: 's1', busy: true,
      messages: [{ role: 'user', content: '运行中的提问' }],
      live: { partial: '正在生成的回答' },
    })
    expect(s.partial).toEqual({ kind: 'assistant', text: '正在生成的回答' })
    s = reducer(s, { type: 'text_delta', delta: '……续' })
    expect(s.partial).toEqual({ kind: 'assistant', text: '正在生成的回答……续' })
  })

  it('live.runningTool：追加 running 工具块（formatToolTitle 摘要 + input 透传）并置 toolActive', () => {
    const s = reducer(initial, {
      type: 'session_ready', id: 's1', busy: true,
      messages: [{ role: 'user', content: '读文件' }],
      live: { runningTool: { id: 'tc-live', name: 'read_file', input: { path: 'a.txt' } } },
    })
    expect(s.toolActive).toBe(true)
    const tool = s.blocks.find((b) => b.kind === 'tool')
    expect(tool).toMatchObject({
      id: expect.any(Number),
      toolId: 'tc-live',
      toolName: 'read_file',
      toolInput: { path: 'a.txt' },
      toolStatus: 'running',
    })
    expect(tool?.text).toContain('read_file')
    expect(tool?.text).toContain('a.txt')
  })

  it('runningTool 恢复后 tool_end 按 toolId 精确配对、就地转正（不产生孤儿块）', () => {
    let s = reducer(initial, {
      type: 'session_ready', id: 's1', busy: true, messages: [],
      live: { runningTool: { id: 'tc-live', name: 'shell', input: { command: 'ls' } } },
    })
    s = reducer(s, { type: 'tool_end', id: 'tc-live', name: 'shell', output: 'x' })
    expect(s.blocks).toHaveLength(1)
    expect(s.blocks[0]).toMatchObject({ toolStatus: 'done', toolOutput: 'x' })
    expect(s.toolActive).toBe(false)
  })

  it('partial 与 runningTool 并存：都恢复（partial + running 块同框）', () => {
    const s = reducer(initial, {
      type: 'session_ready', id: 's1', busy: true, messages: [],
      live: {
        partial: '半句话',
        runningTool: { id: 'tc-live', name: 'shell', input: { command: 'ls' } },
      },
    })
    expect(s.partial).toEqual({ kind: 'assistant', text: '半句话' })
    expect(s.toolActive).toBe(true)
    expect(s.blocks.find((b) => b.kind === 'tool')?.toolStatus).toBe('running')
  })

  it('busy 但无 live：partial 保持空、不追加工具块（旧快照行为不变）', () => {
    const s = reducer(initial, {
      type: 'session_ready', id: 's1', busy: true,
      messages: [{ role: 'user', content: '运行中的提问' }],
    })
    expect(s.partial).toBeNull()
    expect(s.toolActive).toBe(false)
    expect(s.blocks).toHaveLength(1)
  })

  it('空闲快照（busy=false 无 live）：行为完全不变', () => {
    const s = reducer(initial, {
      type: 'session_ready', id: 's1', busy: false,
      messages: [{ role: 'user', content: '你好' }],
    })
    expect(s.status).toBe('idle')
    expect(s.partial).toBeNull()
    expect(s.blocks).toHaveLength(1)
  })
})

describe('reducer — P1-9 冻结判据协同（notice 插在运行中工具块之后）', () => {
  // TUI Static 冻结按 toolStatus==='running' 找第一个运行块（app.tsx）——notice/local_user/
  // compaction 插到运行块后面时判据必须仍能定位；旧「toolActive 时最后一块未完成」判据
  // 会把运行块错误固化进 Static（Ink Static 只增量渲染新下标，tool_end 就地更新永不重绘）。
  it('工具运行中插入 notice：running 块可被 findIndex 定位且在 notice 之前', () => {
    let s = reducer(initial, { type: 'local_user', text: '问' })
    s = reducer(s, { type: 'tool_start', id: 'tc1', name: 'shell', input: { command: 'ls' } })
    s = reducer(s, { type: 'notice', text: '运行中，请稍候——本条未发送' })
    const runningIdx = s.blocks.findIndex((b) => b.toolStatus === 'running')
    expect(runningIdx).toBe(1)
    expect(s.blocks[runningIdx]).toMatchObject({ toolId: 'tc1', toolName: 'shell' })
    expect(s.blocks[runningIdx + 1]).toMatchObject({ kind: 'notice', text: '运行中，请稍候——本条未发送' })
    // tool_end 按 toolId 精确配对、就地转正后，判据失配（全部块可固化进 Static）。
    s = reducer(s, { type: 'tool_end', id: 'tc1', name: 'shell', output: '' })
    expect(s.blocks.findIndex((b) => b.toolStatus === 'running')).toBe(-1)
    expect(s.blocks.find((b) => b.toolId === 'tc1')).toMatchObject({ toolStatus: 'done' })
  })
})

describe('reducer — 思考摘要文案（与 message-block 头行对齐）', () => {
  // 文案立法：实际操作是浏览模式（Ctrl+↑/↓）后 Enter 展开——省略行提示须与
  // message-block 头行「浏览模式 Enter 展开」一致，不误导为「回车展开」。
  it('flush 的思考摘要省略行使用「浏览模式 Enter 展开」', () => {
    const s = reducer(withPartial('thinking', '一\n二\n三\n四'), { type: 'message', role: 'assistant', id: 'm1' })
    const t = s.blocks.find((b) => b.kind === 'thinking')
    expect(t?.text).toContain('浏览模式 Enter 展开')
    expect(t?.text).not.toContain('回车展开')
    expect(t?.full).toBe('一\n二\n三\n四')
  })

  it('session_ready 重建的思考摘要同样使用对齐文案', () => {
    const s = reducer(initial, {
      type: 'session_ready', id: 's1', busy: false,
      messages: [{ role: 'user', content: '问' }, { role: 'assistant', content: '答' }],
      thinking: [{ text: '一\n二\n三\n四' }],
    })
    const t = s.blocks.find((b) => b.kind === 'thinking')
    expect(t?.text).toContain('浏览模式 Enter 展开')
    expect(t?.text).not.toContain('展开查看')
  })
})
