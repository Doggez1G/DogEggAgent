import { z } from 'zod'
import { mcpTransportSchema } from './config'
import type { AgentToUiMessage } from './agent-to-ui'

// AgentToUiMessage 的 zod schema——用于 SSE 客户端校验下行消息。
// 与 agent-to-ui.ts 的类型定义一一对应，只是加了运行时验证能力。
// SSE onmessage 收到的 JSON 经此 schema 校验，失败则丢弃（不传给 listener）。
const stateSchema = z.enum([
  'idle', 'thinking', 'responding', 'tool_calling', 'waiting_permission',
  'executing', 'finished', 'cancelled', 'error', 'compacting',
])

export const agentToUiMessageSchema: z.ZodType<AgentToUiMessage> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state'), from: stateSchema, to: stateSchema }),
  z.object({ type: z.literal('text_delta'), delta: z.string() }),
  z.object({ type: z.literal('thought_delta'), delta: z.string() }),
  z.object({ type: z.literal('message'), role: z.enum(['user', 'assistant', 'tool']), id: z.string() }),
  z.object({ type: z.literal('tool_pending'), name: z.string() }),
  z.object({ type: z.literal('tool_start'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal('tool_end'), id: z.string(), name: z.string(), output: z.string(), error: z.string().optional() }),
  z.object({ type: z.literal('permission_request'), id: z.string(), tool: z.string(), input: z.unknown(), alwaysScope: z.object({ pattern: z.string() }).optional() }),
  z.object({ type: z.literal('session_ready'), id: z.string(), messages: z.array(z.any()), thinking: z.array(z.object({ text: z.string() })).optional() }),
  z.object({ type: z.literal('session_list'), sessions: z.array(z.object({ id: z.string(), updatedAt: z.string(), preview: z.string(),
      title: z.string().optional(), cwd: z.string().optional() })) }),
  z.object({ type: z.literal('session_deleted'), id: z.string() }),
  z.object({ type: z.literal('config_state'), config: z.any() }),
  z.object({ type: z.literal('config_updated'), config: z.any() }),
  z.object({
    type: z.literal('tools_list'),
    tools: z.array(z.object({
      name: z.string(),
      description: z.string(),
      identity: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('builtin') }),
        z.object({ kind: z.literal('mcp'), server: z.string(), name: z.string() }),
      ]),
    })),
  }),
  z.object({
    type: z.literal('context_state'),
    estimatedTokens: z.number(),
    windowTokens: z.number(),
    percent: z.number(),
    breakdown: z
      .object({
        system: z.number(),
        user: z.number(),
        assistant: z.number(),
        tool: z.number(),
        tools: z.number(),
      })
      .optional(),
    lastTurn: z.object({ promptTokens: z.number(), completionTokens: z.number() }).optional(),
    sessionUsage: z.object({ promptTokens: z.number(), completionTokens: z.number(), turns: z.number() }).optional(),
    compactions: z.number(),
  }),
  z.object({ type: z.literal('system_state'), path: z.string(), content: z.string() }),
  z.object({ type: z.literal('status_state'), sessionId: z.string(), provider: z.string(), model: z.string(), cwd: z.string(), state: stateSchema, estimatedTokens: z.number(), windowTokens: z.number(), usage: z.object({ promptTokens: z.number(), completionTokens: z.number(), turns: z.number() }).optional() }),
  z.object({ type: z.literal('log_state'), path: z.string(), tail: z.string() }),
  z.object({ type: z.literal('history_cleared') }),
  z.object({ type: z.literal('notice'), text: z.string(), channel: z.enum(['skills', 'mcp']).optional() }),
  z.object({
    type: z.literal('permissions_list'),
    permissions: z.array(z.object({ tool: z.string(), patterns: z.array(z.string()) })),
  }),
  z.object({ type: z.literal('compaction'), before_tokens: z.number(), after_tokens: z.number(), source: z.enum(['manual', 'auto']) }),
  z.object({
    type: z.literal('skills_list'),
    skills: z.array(z.object({
      name: z.string(),
      description: z.string(),
      scope: z.enum(['project', 'user']),
      path: z.string(),
      enabled: z.boolean(),
      missing: z.boolean(),
    })),
  }),
  z.object({ type: z.literal('skill_content'), scope: z.enum(['project', 'user']), name: z.string(), content: z.string() }),
  z.object({
    type: z.literal('mcp_list'),
    servers: z.array(z.object({
      name: z.string(),
      enabled: z.boolean(),
      scope: z.enum(['global', 'project']),
      transport: mcpTransportSchema,
      status: z.enum(['running', 'starting', 'error', 'stopped']),
      error: z.string().optional(),
      tools: z.array(z.object({ name: z.string(), description: z.string() })),
    })),
  }),
  z.object({ type: z.literal('finished'), usage: z.unknown().optional() }),
  z.object({ type: z.literal('error'), error: z.object({ message: z.string(), name: z.string().optional() }) }),
])
