import type { State, Message, ToolPermission, ContextBreakdown } from './shared'
import type { Config, McpTransport } from './config'
import type { ToolListItem } from './tools'

// 后端 → 前端的消息契约。仅类型；方向单一，保证后端/前端解耦且互不 import 业务实现。
// 将来接 SSE 时，序列化/反序列化的正是这一套类型，故 error 用可序列化形状而非 Error。
export type AgentToUiMessage =
  | { type: 'state'; from: State; to: State }
  | { type: 'text_delta'; delta: string }
  | { type: 'thought_delta'; delta: string }
  // LLM 请求层重试从零重发增量：UI 须先清空当前流式 partial（text/thinking），再接收新尝试的
  // delta——否则第 2 次尝试的 delta 追加在第 1 次残文后，展示与持久化分叉。不落盘、不产生新块。
  | { type: 'stream_reset' }
  // id 为真值（非空串），与 tool_start 的 id 同源，供 UI 定位/折叠/滚动。
  // role='user' 时应携带消息原文（发射点：turn-runner runTurn，会话历史里的同一条 user 消息）——
  // UI 靠 text 做回声去重（本端乐观插入 local_user 后忽略同文本回声）与无乐观插入场景
  //（invoke_skill 的用户轮次、其它标签页看远端用户消息）的实时插入。assistant/tool 不带 text。
  | { type: 'message'; role: 'user' | 'assistant' | 'tool'; id: string; text?: string }
  | { type: 'tool_pending'; name: string } // 模型正在流式生成工具调用参数（tool_call_start → tool_start 之间）——大参数期间 UI 需有可见反馈
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_end'; id: string; name: string; output: string; error?: string } // 拒绝/失败工具也发 tool_end（error 标明原因），不再静默塞消息
  | { type: 'permission_request'; id: string; tool: string; input: unknown; alwaysScope?: { pattern: string } } // alwaysScope = agent 推导的范围模式（存在时 UI 渲染第四档「对此范围不再询问」）；措辞由各 UI 自组
  // busy = 快照重发时 agent 是否在跑（gate.busy）。恢复链立法：运行中刷新页面/新标签接入时，
  // session_ready 快照不得把 UI 打回 idle（否则输入框误启用、显示与后端真实状态分叉）——
  // UI 据 busy 先落到「运行中」形态，随后的 status_state 会校正为真实 machine state。
  // live = 运行中的轮内现场（仅 busy=true 时由 agent 附加）：partial 是当前流式中的助手文本
  //（后续 text_delta 从其上续拼），runningTool 是进行中的工具调用（UI 据此重建 running 工具块）。
  // 缺省（空闲期快照）不带 live——恢复后 partial/工具块从 history 重建即可，无现场可补。
  | { type: 'session_ready'; id: string; messages: Message[]; busy: boolean; thinking?: { text: string }[]; live?: { partial?: string; runningTool?: { id: string; name: string; input: unknown } } }
  | { type: 'session_list'; sessions: { id: string; updatedAt: string; preview: string; cwd?: string; title?: string }[] }
  | { type: 'session_deleted'; id: string } // 会话已删除——UI 据此刷新侧栏列表
  | { type: 'config_state'; config: Config }
  | { type: 'config_updated'; config: Config }
  | { type: 'tools_list'; tools: ToolListItem[] } // identity 随行——UI 按来源分组/标注（内建 / MCP · 服务名）
  | {
      type: 'context_state'
      estimatedTokens: number
      windowTokens: number
      percent: number
      breakdown?: ContextBreakdown
      /** 上一轮真实用量（API 返回）——与本轮估算并排展示，可见估算器校准误差。 */
      lastTurn?: { promptTokens: number; completionTokens: number }
      /** 会话累计真实用量（持久化，resume 续计）。 */
      sessionUsage?: { promptTokens: number; completionTokens: number; turns: number }
      /** 会话累计自动压缩次数。 */
      compactions: number
    }
  | { type: 'system_state'; path: string; content: string }
  | { type: 'status_state'; sessionId: string; provider: string; model: string; cwd: string; state: State; estimatedTokens: number; windowTokens: number; usage?: { promptTokens: number; completionTokens: number; turns: number } }
  | { type: 'log_state'; path: string; tail: string }
  | { type: 'history_cleared' }
  | { type: 'notice'; text: string; channel?: 'skills' | 'mcp' | 'config' } // channel：管理面板内联错误定位（skills/mcp/config 的 CRUD 失败与 busy 拒绝），普通提示不带
  | { type: 'permissions_list'; permissions: ToolPermission[] } // /permissions 命令响应：当前会话的 allow_always 授权工具列表
  | { type: 'skills_list'; skills: { name: string; description: string; scope: 'project' | 'user'; path: string; enabled: boolean; missing: boolean }[] } // 当前 skills（项目级覆盖同名用户级时不省略；missing = 停用名单在案但目录已消失的孤儿条目）
  | { type: 'skill_content'; scope: 'project' | 'user'; name: string; content: string } // skills_manage get 的响应：SKILL.md 全文
  | { type: 'mcp_list'; servers: { name: string; enabled: boolean; scope: 'global' | 'project'; transport: McpTransport; status: 'running' | 'starting' | 'error' | 'stopped'; error?: string; tools: { name: string; description: string }[] }[] } // MCP server 配置（含 transport 明细——编辑预填）+ 运行时状态快照
  | { type: 'compaction'; before_tokens: number; after_tokens: number; source: 'manual' | 'auto' } // source 区分手动/自动，UI 据此决定弹 overlay 还是插提示块
  | { type: 'finished'; usage?: unknown }
  | { type: 'error'; error: { message: string; name?: string } } // 可序列化：JSON.stringify(Error) 会丢 stack/name，进程内 Port 与将来 SSE 需同构