import type { McpServerConfig } from '@dogegg/bridge'

// MCP server 表单的纯逻辑（无 React 依赖，可单测）：mcp_list 条目 ↔ 表单状态互转 + 提交校验。
// 从 mcp.tsx 抽出——组件文件只留渲染与状态编排，转换/校验是纯函数，测试无需挂载组件。

// mcp_list 广播的单个 server 条目（含运行时状态）。
export interface McpItem {
  name: string
  enabled: boolean
  scope: 'global' | 'project'
  transport: McpServerConfig['transport']
  status: 'running' | 'starting' | 'error' | 'stopped'
  error?: string
  tools: { name: string; description: string }[]
}

export interface FormState {
  scope: 'global' | 'project'
  name: string
  type: 'stdio' | 'http'
  command: string
  args: string   // JSON 数组字面量
  env: string    // JSON 对象字面量（可空）
  url: string
  headers: string // JSON 对象字面量（可空）
  /** 原条目的启停状态——编辑保存时透传（不再硬编码 true），避免把已停用的 server 意外拉起；
      新建态缺省 true（与 TUI keys.ts 的 opts.lock?.enabled ?? true 对齐）。 */
  enabled?: boolean
}

export const emptyForm = (scope: 'global' | 'project'): FormState => ({ scope, name: '', type: 'stdio', command: '', args: '[]', env: '', url: '', headers: '' })

// 表单 → server 配置（mcp_manage save 的载荷）。校验失败返回 { error }（由调用方 inline 展示）。
// enabled 透传表单携带的原值——编辑停用中的 server 再保存不会被误启。
export function formToServer(f: FormState): McpServerConfig | { error: string } {
  if (!f.name.trim()) return { error: '缺少名称' }
  if (f.type === 'stdio') {
    let args: string[] = []
    try { args = f.args.trim() ? JSON.parse(f.args) as string[] : [] } catch { return { error: 'args 不是合法 JSON 数组' } }
    let env: Record<string, string> | undefined
    if (f.env.trim()) {
      try { env = JSON.parse(f.env) as Record<string, string> } catch { return { error: 'env 不是合法 JSON 对象' } }
    }
    if (!f.command.trim()) return { error: '缺少 command' }
    return { name: f.name.trim(), enabled: f.enabled ?? true, transport: { type: 'stdio', command: f.command.trim(), args, ...(env ? { env } : {}) } }
  }
  if (!f.url.trim()) return { error: '缺少 url' }
  let headers: Record<string, string> | undefined
  if (f.headers.trim()) {
    try { headers = JSON.parse(f.headers) as Record<string, string> } catch { return { error: 'headers 不是合法 JSON 对象' } }
  }
  return { name: f.name.trim(), enabled: f.enabled ?? true, transport: { type: 'http', url: f.url.trim(), ...(headers ? { headers } : {}) } }
}

// 条目 → 表单预填（编辑场景：mcp_list 快照携带 transport 明细，全字段预填；
// enabled 一并携带，保存时透传）。
export function serverToForm(item: McpItem): FormState {
  const base = emptyForm(item.scope)
  if (item.transport.type === 'stdio') {
    return { ...base, name: item.name, type: 'stdio', command: item.transport.command, args: JSON.stringify(item.transport.args ?? []), env: item.transport.env ? JSON.stringify(item.transport.env) : '', enabled: item.enabled }
  }
  return { ...base, name: item.name, type: 'http', url: item.transport.url, headers: item.transport.headers ? JSON.stringify(item.transport.headers) : '', enabled: item.enabled }
}
