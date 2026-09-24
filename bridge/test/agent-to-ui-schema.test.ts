import { describe, it, expect } from 'vitest'
import type { AgentToUiMessage } from '../src/contract/agent-to-ui'
import { agentToUiMessageSchema } from '../src/contract/agent-to-ui-schema'

// agent-to-ui 契约面的 zod 用例：与 ui-to-agent-schema.test.ts 同一职责（类型与 schema 同步，
// 漂移在此暴露），当前聚焦恢复链相关的三个契约点：
// 1. session_ready.busy 必填——运行中保真依赖该字段（busy=true 时 UI 不得被快照打回 idle），
//    旧载荷缺 busy 必须被拒（fail-closed：SSE 客户端丢弃不合法消息，宁可不降级也不静默失真）；
// 2. message 的 role='user' 携带 text 原文——UI 的回声去重 / 实时插入（invoke_skill 的用户轮次、
//    其它标签页看远端用户消息）依赖它；text 可选，缺省放行（发射点未带原文时 UI 维持旧行为）；
// 3. notice——启动期 notice 环形缓冲（agent 侧有界缓冲 + resendSessionState 重放，使 WebUI
//    用户能看到发进空连接集的启动告警）复用既有 notice 消息类型，契约面无需新增变体；
//    此处锁定其形状（text 必填、channel 可选）作为该语义的契约面说明。
describe('agent-to-ui schema：恢复链契约面', () => {
  it('session_ready 带 busy 通过 schema 且字段不丢', () => {
    const msg: AgentToUiMessage = { type: 'session_ready', id: 's1', messages: [], busy: false }
    expect(agentToUiMessageSchema.parse(msg)).toEqual(msg)
  })

  it('session_ready 缺 busy 被拒（fail-closed：运行中保真不容忍旧载荷）', () => {
    const raw = { type: 'session_ready', id: 's1', messages: [] }
    const result = agentToUiMessageSchema.safeParse(raw)
    expect(result.success).toBe(false)
  })

  it('message role=user 带 text 放行且字段不丢（回声去重/实时插入依赖原文）', () => {
    const raw: AgentToUiMessage = { type: 'message', role: 'user', id: 'm1', text: '你好' }
    expect(agentToUiMessageSchema.parse(raw)).toEqual(raw)
  })

  it('message role=user 缺 text 放行（text 可选——发射点未带原文时 UI 维持忽略旧行为）', () => {
    const raw: AgentToUiMessage = { type: 'message', role: 'user', id: 'm1' }
    expect(agentToUiMessageSchema.parse(raw)).toEqual(raw)
  })

  it('message role=assistant/tool 不带 text 照常放行', () => {
    expect(agentToUiMessageSchema.parse({ type: 'message', role: 'assistant', id: 'a1' })).toEqual({ type: 'message', role: 'assistant', id: 'a1' })
    expect(agentToUiMessageSchema.parse({ type: 'message', role: 'tool', id: 't1' })).toEqual({ type: 'message', role: 'tool', id: 't1' })
  })

  it('notice：启动期告警复用该类型（环形缓冲重放同一形状）——text 必填、channel 可选', () => {
    expect(agentToUiMessageSchema.parse({ type: 'notice', text: '权限键 mcp:foo 不是合法服务键' }))
      .toEqual({ type: 'notice', text: '权限键 mcp:foo 不是合法服务键' })
    expect(agentToUiMessageSchema.parse({ type: 'notice', text: 'skills 加载失败', channel: 'skills' }))
      .toEqual({ type: 'notice', text: 'skills 加载失败', channel: 'skills' })
  })
})
