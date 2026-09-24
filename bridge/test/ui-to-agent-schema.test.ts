import { describe, it, expect } from 'vitest'
import type { UiToAgentMessage } from '../src/contract/ui-to-agent'
import { uiToAgentMessageSchema } from '../src/contract/ui-to-agent-schema'

// 契约漂移防线：ui-to-agent.ts 的类型联合与 ui-to-agent-schema.ts 的 zod schema 之间
// 没有编译期强制（z.ZodType<Union> 只约束「输出 assignable 到联合」，schema 漏掉某个
// 变体不会报错——skills_manage 的 toggle 就是这么漏掉的：TUI 走 in-memory 通道不过
// schema 一切正常，WebUI 的 POST 被 400 静默拒绝）。
//
// 本测试用 Record<消息类型字面量联合, 样本> 做编译期穷举：类型里新增/改名消息，
// 这里缺键直接编译失败；样本不过 schema 则测试失败。类型与 schema 必须同步改。

// 每种上行消息各一个最小合法样本。
const SAMPLES: Record<UiToAgentMessage['type'], UiToAgentMessage> = {
  submit: { type: 'submit', text: '你好' },
  permission_decision: { type: 'permission_decision', id: 'p1', decision: 'allow_once' },
  cancel: { type: 'cancel' },
  new_session: { type: 'new_session' },
  list_sessions: { type: 'list_sessions' },
  resume_session: { type: 'resume_session', id: 's1' },
  config_request: { type: 'config_request' },
  config_set: { type: 'config_set', path: 'x', value: 1 },
  config_add: { type: 'config_add', path: 'x', value: 1 },
  config_remove: { type: 'config_remove', path: 'x', index: 0 },
  tools_request: { type: 'tools_request' },
  context_request: { type: 'context_request' },
  system_request: { type: 'system_request' },
  status_request: { type: 'status_request' },
  log_request: { type: 'log_request' },
  permissions_request: { type: 'permissions_request' },
  permission_revoke: { type: 'permission_revoke', tool: 'shell' },
  rename_session: { type: 'rename_session', title: '标题' },
  skills_request: { type: 'skills_request' },
  skills_manage: { type: 'skills_manage', action: 'toggle', scope: 'user', name: 'docx', enabled: false },
  invoke_skill: { type: 'invoke_skill', name: 'docx', args: '' },
  mcp_request: { type: 'mcp_request' },
  mcp_manage: { type: 'mcp_manage', action: 'toggle', scope: 'global', name: 'x', enabled: false },
  set_cwd: { type: 'set_cwd', path: '.' },
  delete_session: { type: 'delete_session', id: 's1' },
  clear_history: { type: 'clear_history' },
  compact_request: { type: 'compact_request' },
  quit: { type: 'quit' },
}

describe('ui-to-agent schema 与类型契约同步（漂移防线）', () => {
  it('每种消息类型的合法样本都必须通过 schema——schema 漏变体在这里失败', () => {
    for (const [type, sample] of Object.entries(SAMPLES)) {
      const result = uiToAgentMessageSchema.safeParse(sample)
      expect(result.success, `${type} 样本未通过 schema：${result.success ? '' : JSON.stringify(result.error.issues)}`).toBe(true)
    }
  })

  it('skills_manage 的 toggle（WebUI 启停按钮载荷）被放行且字段不丢', () => {
    const raw = { type: 'skills_manage', action: 'toggle', scope: 'user', name: 'docx', enabled: false }
    expect(uiToAgentMessageSchema.parse(raw)).toEqual(raw)
  })
})
