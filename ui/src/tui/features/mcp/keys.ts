import type { Key } from 'ink'
import type { McpServerConfig, UiToAgentMessage } from '@dogegg/bridge'
import type { View } from '../../view-state'

export interface McpKeysApi {
  setView(view: View): void
  post(msg: UiToAgentMessage): void
  openMenu(title: string, items: { label: string; onSelect: () => void }[]): void
  /** 吞掉打开菜单/弹层当次的回车（与 session picker 同理由）。 */
  suppressEnter(): void
  /** 报错提示（JSON 解析失败等）——转 info 面板可见。 */
  notice(text: string): void
}

// MCP 面板按键：↑↓ 选择、Enter 详情（工具清单 → info 面板）、a 新建（类型 → 字段 → 落点）、
// t 启用/停用、d 删除（确认菜单）、esc 返回。
// 新建流的字段输入用 prompt 弹层逐步收集；args/env 用 JSON 字面量（无歧义；解析失败转 notice 不写配置）。
export function handleMcpKeys(v: Extract<View, { kind: 'mcp' }>, key: Key, inputChar: string, api: McpKeysApi): void {
  const current = v.servers[v.cursor]
  if (key.upArrow) {
    api.setView({ ...v, cursor: (v.cursor + v.servers.length - 1) % Math.max(1, v.servers.length) })
  } else if (key.downArrow) {
    api.setView({ ...v, cursor: (v.cursor + 1) % Math.max(1, v.servers.length) })
  } else if (key.escape) {
    api.setView({ kind: 'none' })
  } else if (key.return && current) {
    // 详情：本地数据拼装（状态/工具清单都在 mcp_list 镜像里），无需再请求。
    const lines = [
      `name     ${current.name}`,
      `scope    ${current.scope}`,
      `type     ${current.transport.type}`,
      `status   ${current.status}${current.error ? `（${current.error}）` : ''}`,
      `enabled  ${current.enabled ? '是（t 停用）' : '否（t 启用）'}`,
      '',
      ...current.tools.map((t) => `mcp__${current.name}__${t.name} — ${t.description}`),
    ]
    api.setView({ kind: 'info', title: `MCP ${current.name}`, lines })
  } else if (inputChar === 'a') {
    api.suppressEnter()
    api.openMenu('添加哪种传输类型的 server？', [
      { label: 'stdio（本地进程：command + args）', onSelect: () => addStdioFlow(api, v) },
      { label: 'http（远程服务：url + headers）', onSelect: () => addHttpFlow(api, v) },
    ])
  } else if (inputChar === 'e' && current) {
    // 编辑：预填现有 transport 明细（mcp_list 快照下发）；名称与落点不可改（名称即身份，upsert 原条目）。
    if (current.transport.type === 'stdio') {
      const t = current.transport
      editStdioFlow(api, v, current, { command: t.command, args: JSON.stringify(t.args ?? []), env: t.env ? JSON.stringify(t.env) : '' })
    } else {
      const t = current.transport
      editHttpFlow(api, v, current, { url: t.url, headers: t.headers ? JSON.stringify(t.headers) : '' })
    }
  } else if (inputChar === 't' && current) {
    api.post({ type: 'mcp_manage', action: 'toggle', scope: current.scope, name: current.name, enabled: !current.enabled })
  } else if (inputChar === 'd' && current) {
    api.suppressEnter()
    api.openMenu(`删除 server ${current.name}（${current.scope}）？配置条目将移除，进程停止。`, [
      { label: '确认删除', onSelect: () => { api.post({ type: 'mcp_manage', action: 'delete', scope: current.scope, name: current.name }); api.setView({ kind: 'none' }) } },
      { label: '取消', onSelect: () => api.setView(v) },
    ])
  }
}

// stdio 新建/编辑：name → command → args（JSON 数组）→ env（JSON 对象）→ 落点（新建选，编辑沿用原落点）。
// 编辑（preset 提供时）：名称与落点锁定——名称即身份，save 按 upsert 原条目覆盖。
function addStdioFlow(api: McpKeysApi, panel: Extract<View, { kind: 'mcp' }>, preset?: { name: string; scope: 'global' | 'project'; fields: { command: string; args: string; env: string } }): void {
  const val = preset?.fields
  api.setView(prompt('server 名称（如 fs / github）', preset?.name ?? '', panel, (name) => {
    api.setView(prompt('command（如 npx / node）', val?.command ?? '', panel, (command) => {
      api.setView(prompt('args（JSON 数组，如 ["-y","@mcp/server"]；无参填 []）', val?.args ?? '[]', panel, (argsRaw) => {
        const args = parseJson<string[]>(api, argsRaw, [])
        api.setView(prompt('env（JSON 对象，如 {"KEY":"V"}；无填 {}）', val?.env ?? '', panel, (envRaw) => {
          const env = parseJson<Record<string, string> | undefined>(api, envRaw, undefined)
          const entry: McpServerConfig = { name: name.trim(), enabled: true, transport: { type: 'stdio', command: command.trim(), args, ...(env ? { env } : {}) } }
          if (preset) api.post({ type: 'mcp_manage', action: 'save', scope: preset.scope, server: entry })
          else pickScope(api, panel, (scope) => api.post({ type: 'mcp_manage', action: 'save', scope, server: entry }))
        }))
      }))
    }))
  }))
}

// http 新建/编辑：name → url → headers（JSON 对象）→ 落点（新建选，编辑沿用原落点）。
function addHttpFlow(api: McpKeysApi, panel: Extract<View, { kind: 'mcp' }>, preset?: { name: string; scope: 'global' | 'project'; fields: { url: string; headers: string } }): void {
  const val = preset?.fields
  api.setView(prompt('server 名称', preset?.name ?? '', panel, (name) => {
    api.setView(prompt('url（Streamable HTTP 端点）', val?.url ?? '', panel, (url) => {
      api.setView(prompt('headers（JSON 对象，如 {"Authorization":"Bearer x"}；无填 {}）', val?.headers ?? '', panel, (headersRaw) => {
        const headers = parseJson<Record<string, string> | undefined>(api, headersRaw, undefined)
        const entry: McpServerConfig = { name: name.trim(), enabled: true, transport: { type: 'http', url: url.trim(), ...(headers ? { headers } : {}) } }
        if (preset) api.post({ type: 'mcp_manage', action: 'save', scope: preset.scope, server: entry })
        else pickScope(api, panel, (scope) => api.post({ type: 'mcp_manage', action: 'save', scope, server: entry }))
      }))
    }))
  }))
}

// 编辑流分发（名称与落点锁定；字段具体化避免 Record 索引的 string|undefined）。
function editStdioFlow(api: McpKeysApi, panel: Extract<View, { kind: 'mcp' }>, current: { name: string; scope: 'global' | 'project' }, fields: { command: string; args: string; env: string }): void {
  addStdioFlow(api, panel, { name: current.name, scope: current.scope, fields })
}
function editHttpFlow(api: McpKeysApi, panel: Extract<View, { kind: 'mcp' }>, current: { name: string; scope: 'global' | 'project' }, fields: { url: string; headers: string }): void {
  addHttpFlow(api, panel, { name: current.name, scope: current.scope, fields })
}

// 落点选择菜单：全局 config.json / 项目 .mcp.json；确认后回 none（mcp_list 广播驱动面板刷新）。
function pickScope(api: McpKeysApi, panel: Extract<View, { kind: 'mcp' }>, onSave: (scope: 'global' | 'project') => void): void {
  api.openMenu('写入到哪一层？', [
    { label: '全局（~/.dogegg/config.json，所有项目可用）', onSelect: () => { onSave('global'); api.setView({ kind: 'none' }) } },
    { label: '项目（.dogegg/.mcp.json，随仓库共享）', onSelect: () => { onSave('project'); api.setView({ kind: 'none' }) } },
  ])
}

function prompt(title: string, value: string, panel: Extract<View, { kind: 'mcp' }>, onSubmit: (v: string) => void): View {
  return { kind: 'prompt', title, value, returnView: panel, onSubmit }
}

// JSON 参数解析：非法 JSON → notice 并返回兜底值（不写配置——宁可少配不可错配）。
function parseJson<T>(api: McpKeysApi, raw: string, fallback: T): T {
  const t = raw.trim()
  if (!t) return fallback
  try { return JSON.parse(t) as T } catch {
    api.notice('JSON 解析失败——请检查输入格式（本次未写入配置）')
    return fallback
  }
}
