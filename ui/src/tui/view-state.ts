import type { McpTransport } from '@dogegg/bridge'
import type { ConfigPath } from './features/config'

// UI 自己的视图态（叠加在后端状态机之上，二者正交）。
// 决定当前显示哪个 overlay：无 / 权限弹层 / 菜单选择器 / 会话选择器 / 标量输入 / 配置编辑器 / 只读信息面板。
// skills 面板条目（skills_list 消息的条目形态；scope 决定分组与覆盖关系）。
export interface SkillEntry {
  name: string
  description: string
  scope: 'project' | 'user'
  path: string
}

// MCP server 条目（mcp_list 消息的条目形态：配置（含 transport 明细——编辑预填）+ 运行时状态）。
export interface McpServerEntry {
  name: string
  enabled: boolean
  scope: 'global' | 'project'
  transport: McpTransport
  status: 'running' | 'starting' | 'error' | 'stopped'
  error?: string
  tools: { name: string; description: string }[]
}

export type View =
  | { kind: 'none' }
  | { kind: 'permission'; id: string; tool: string; input: unknown; alwaysScope?: { pattern: string }; cursor: number }
  | { kind: 'menu'; title: string; items: { label: string; onSelect: () => void }[]; cursor: number }
  | { kind: 'sessionPicker'; sessions: { id: string; preview: string; title?: string; updatedAt: string }[]; cursor: number; query: string }
  | { kind: 'prompt'; title: string; value: string; onSubmit: (v: string) => void; returnPath?: ConfigPath; returnCursor?: number; returnView?: View }
  | { kind: 'skills'; cursor: number; skills: SkillEntry[] }
  | { kind: 'mcp'; cursor: number; servers: McpServerEntry[] }
  | { kind: 'config'; path: ConfigPath; cursor: number; preview: boolean | null }
  | { kind: 'info'; title: string; lines: string[] } // /context /tools /status /system /log /help 的只读面板
