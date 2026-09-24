import { z } from 'zod'
import type { UiToAgentMessage } from './ui-to-agent'
import { mcpServerSchema } from './config'

// UiToAgentMessage 的 zod schema——用于 POST /api/message 的运行时校验。
// 与 ui-to-agent.ts 的类型定义一一对应，只是加了运行时验证能力。
// 前端发来的 JSON body 必须通过此 schema 校验，否则返回 400。
// 【漂移防线】类型与 schema 的成员对照没有编译期强制（ZodType<Union> 只约束输出 assignable，
// schema 漏变体不报错）——bridge/test/ui-to-agent-schema.test.ts 用 Record<消息类型联合, 样本>
// 穷举守卫：新增消息类型不补样本直接编译失败，样本不过 schema 测试失败。两者必须同步改。
const permissionDecisionSchema = z.enum(['allow_once', 'allow_always', 'allow_always_scoped', 'reject'])

export const uiToAgentMessageSchema: z.ZodType<UiToAgentMessage> = z.discriminatedUnion('type', [
  // text min(1)：空文本提交是前端防线失守（TUI/WebUI 输入框校验旁路、手写请求）——
  // 后端 schema 兜底拒绝，避免空 user 消息白烧一轮 LLM 调用。
  z.object({ type: z.literal('submit'), text: z.string().min(1) }),
  z.object({ type: z.literal('permission_decision'), id: z.string(), decision: permissionDecisionSchema }),
  z.object({ type: z.literal('cancel') }),
  z.object({ type: z.literal('new_session'), cwd: z.string().optional() }),
  z.object({ type: z.literal('list_sessions') }),
  z.object({ type: z.literal('resume_session'), id: z.string() }),
  z.object({ type: z.literal('config_request') }),
  z.object({ type: z.literal('config_set'), path: z.string(), value: z.unknown() }),
  z.object({ type: z.literal('config_add'), path: z.string(), value: z.unknown() }),
  // index int/min(0)：删除定位必须是合法数组下标——小数/负数在编辑器越界检查前就被 schema 拦下。
  z.object({ type: z.literal('config_remove'), path: z.string(), index: z.number().int().min(0), providerIndex: z.number().int().min(0).optional() }),
  z.object({ type: z.literal('tools_request') }),
  z.object({ type: z.literal('context_request') }),
  z.object({ type: z.literal('system_request') }),
  z.object({ type: z.literal('status_request') }),
  z.object({ type: z.literal('log_request') }),
  z.object({ type: z.literal('permissions_request') }),
  z.object({ type: z.literal('permission_revoke'), tool: z.string(), pattern: z.string().optional() }),
  z.object({ type: z.literal('rename_session'), title: z.string() }),
  z.object({ type: z.literal('skills_request') }),
  z.object({
    type: z.literal('skills_manage'),
    action: z.enum(['create', 'update', 'delete', 'get', 'toggle']),
    scope: z.enum(['project', 'user']),
    name: z.string(),
    description: z.string().optional(),
    // content 若存在则 min(1)：空串保存会把 SKILL.md 清成空文件（防清空立法，manager.update 同步兜底）。
    content: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({ type: z.literal('invoke_skill'), name: z.string(), args: z.string() }),
  z.object({ type: z.literal('mcp_request') }),
  z.object({
    type: z.literal('mcp_manage'),
    action: z.enum(['save', 'delete', 'toggle']),
    scope: z.enum(['global', 'project']),
    server: mcpServerSchema.optional(),
    name: z.string().optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({ type: z.literal('set_cwd'), path: z.string() }),
  z.object({ type: z.literal('delete_session'), id: z.string() }),
  z.object({ type: z.literal('clear_history') }),
  z.object({ type: z.literal('compact_request') }),
  z.object({ type: z.literal('quit') }),
])
