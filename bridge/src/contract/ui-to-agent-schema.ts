import { z } from 'zod'
import type { UiToAgentMessage } from './ui-to-agent'
import { mcpServerSchema } from './config'

// UiToAgentMessage 的 zod schema——用于 POST /api/message 的运行时校验。
// 与 ui-to-agent.ts 的类型定义一一对应，只是加了运行时验证能力。
// 前端发来的 JSON body 必须通过此 schema 校验，否则返回 400。
const permissionDecisionSchema = z.enum(['allow_once', 'allow_always', 'allow_always_scoped', 'reject'])

export const uiToAgentMessageSchema: z.ZodType<UiToAgentMessage> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('submit'), text: z.string() }),
  z.object({ type: z.literal('permission_decision'), id: z.string(), decision: permissionDecisionSchema }),
  z.object({ type: z.literal('cancel') }),
  z.object({ type: z.literal('new_session'), cwd: z.string().optional() }),
  z.object({ type: z.literal('list_sessions') }),
  z.object({ type: z.literal('resume_session'), id: z.string() }),
  z.object({ type: z.literal('config_request') }),
  z.object({ type: z.literal('config_set'), path: z.string(), value: z.unknown() }),
  z.object({ type: z.literal('config_add'), path: z.string(), value: z.unknown() }),
  z.object({ type: z.literal('config_remove'), path: z.string(), index: z.number(), providerIndex: z.number().optional() }),
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
    action: z.enum(['create', 'update', 'delete', 'get']),
    scope: z.enum(['project', 'user']),
    name: z.string(),
    description: z.string().optional(),
    content: z.string().optional(),
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
