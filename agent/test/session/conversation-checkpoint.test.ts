import { describe, it, expect } from 'vitest'
import { Conversation } from '../../src/session'

// ─────────────────────────────────────────────────────────────────────────────
// Conversation.checkpoint（轮次中途检查点快照）单测：
// 核心立法是「不改内存」——检查点只是把 loop 实时进度拼成落盘对象，轮末 applyTurnResult
// 才是内存收口。这里验证字段合并方式与内存不变性。
// ─────────────────────────────────────────────────────────────────────────────

function seededConversation(): Conversation {
  const conv = new Conversation('/tmp/proj')
  conv.pushUserMessage('第一问')
  // 用 applyTurnResult 造出「已完成一轮」的状态：history=[u1,a1]、thinking=[t1]、usage 累计、压缩 1 次。
  conv.applyTurnResult({
    context: [{ role: 'user', content: '第一问' }, { role: 'assistant', content: '第一答' }],
    newMessages: [{ role: 'assistant', content: '第一答' }],
    thinking: [{ text: '思考一' }],
    usage: { promptTokens: 10, completionTokens: 5 },
    compactions: 1,
  })
  return conv
}

describe('Conversation.checkpoint', () => {
  it('合并轮内进度：history+newMessages / thinking 拼接 / usage 累加（turns 不计）/ compactions 透传', () => {
    const conv = seededConversation()
    conv.pushUserMessage('第二问') // 轮次已开始：user 消息已在内存 history
    conv.setTitle('我的会话')

    const live = {
      context: [
        { role: 'user' as const, content: '第一问' },
        { role: 'assistant' as const, content: '第一答' },
        { role: 'user' as const, content: '第二问' },
        { role: 'assistant' as const, content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool' as const, tool_call_id: 'c1', content: '结果' },
      ],
      newMessages: [
        { role: 'assistant' as const, content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool' as const, tool_call_id: 'c1', content: '结果' },
      ],
      thinking: [{ text: '思考二' }],
      usage: { promptTokens: 100, completionTokens: 20 },
    }

    const snap = conv.checkpoint(live, [{ tool: 'shell', patterns: [] }], 3)

    expect(snap.id).toBe(conv.getId())
    expect(snap.cwd).toBe('/tmp/proj')
    expect(snap.title).toBe('我的会话')
    // history' = 内存 history（3 条）+ 轮内 newMessages（2 条）
    expect(snap.history).toHaveLength(5)
    expect(snap.history.at(-1)).toMatchObject({ role: 'tool', content: '结果' })
    // context' = live 引用（loop 的实时数组，接收方只读）
    expect(snap.context).toBe(live.context)
    // thinking' = 内存 thinking + 轮内 thinking
    expect(snap.thinking).toEqual([{ text: '思考一' }, { text: '思考二' }])
    // usage' = 会话累计 + 轮内已累计；turns 不 +1（轮未完成）
    expect(snap.usage).toEqual({ promptTokens: 110, completionTokens: 25, turns: 1 })
    expect(snap.compactions).toBe(3)
    expect(snap.sessionPermissions).toEqual([{ tool: 'shell', patterns: [] }])
  })

  it('不改内存：checkpoint 后 history/thinking/usage 与调用前一致', () => {
    const conv = seededConversation()
    conv.pushUserMessage('第二问')
    const historyBefore = [...conv.getHistory()]
    const thinkingBefore = [...conv.getThinking()]
    const usageBefore = conv.getUsage()

    conv.checkpoint(
      {
        context: [],
        newMessages: [{ role: 'assistant', content: '进行中' }],
        thinking: [{ text: '进行中的思考' }],
        usage: { promptTokens: 999, completionTokens: 999 },
      },
      [],
      0,
    )

    expect(conv.getHistory()).toEqual(historyBefore)
    expect(conv.getHistory()).toHaveLength(3) // 不含「进行中」
    expect(conv.getThinking()).toEqual(thinkingBefore)
    expect(conv.getThinking()).toHaveLength(1)
    expect(conv.getUsage()).toEqual(usageBefore)
    expect(conv.getUsage()).toEqual({ promptTokens: 10, completionTokens: 5, turns: 1 })
  })
})
