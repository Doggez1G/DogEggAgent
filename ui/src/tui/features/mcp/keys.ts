import type { Key } from 'ink'
import type { McpServerConfig, UiToAgentMessage } from '@dogegg/bridge'
import type { FormField, View } from '../../view-state'

export interface McpKeysApi {
  setView(view: View): void
  post(msg: UiToAgentMessage): void
  /** 确认菜单（returnView 供 esc 返回来源视图）。 */
  openMenu(title: string, items: { label: string; onSelect: () => void }[], returnView?: View): void
  /** 吞掉打开菜单/弹层当次的回车（与 session picker 同理由）。 */
  suppressEnter(): void
  /** 报错提示（JSON 解析失败等）——转 info 面板可见。 */
  notice(text: string): void
}

// MCP 面板按键：↑↓ 选择、Enter 详情（工具清单 → info 面板，esc 回本面板）、
// a 新建 / e 编辑（表单视图：全部字段一屏列出，Enter 逐字段编辑/切换，s 保存，esc 回列表不保存）、
// t 启停、d 删除（确认菜单 esc 回面板）。
export function handleMcpKeys(v: Extract<View, { kind: 'mcp' }>, key: Key, inputChar: string, api: McpKeysApi): void {
  const current = v.servers[v.cursor]
  if (key.upArrow) {
    api.setView({ ...v, cursor: (v.cursor + v.servers.length - 1) % Math.max(1, v.servers.length) })
  } else if (key.downArrow) {
    api.setView({ ...v, cursor: (v.cursor + 1) % Math.max(1, v.servers.length) })
  } else if (key.escape) {
    api.setView({ kind: 'none' })
  } else if (key.return && current) {
    // 详情：本地数据拼装（状态/工具清单都在 mcp_list 镜像里）；returnView 让 esc 回到本面板。
    const lines = [
      `name     ${current.name}`,
      `scope    ${current.scope}`,
      `type     ${current.transport.type}`,
      `status   ${current.status}${current.error ? `（${current.error}）` : ''}`,
      `enabled  ${current.enabled ? '是（t 停用）' : '否（t 启用）'}`,
      '',
      ...current.tools.map((t) => `mcp__${current.name}__${t.name} — ${t.description}`),
    ]
    api.setView({ kind: 'info', title: `MCP ${current.name}`, lines, returnView: v })
  } else if (inputChar === 'a') {
    api.suppressEnter()
    api.openMenu('添加哪种传输类型的 server？', [
      { label: 'stdio（本地进程：command + args）', onSelect: () => mcpForm(api, v, { type: 'stdio' }) },
      { label: 'http（远程服务：url + headers）', onSelect: () => mcpForm(api, v, { type: 'http' }) },
    ], v)
  } else if (inputChar === 'e' && current) {
    // 编辑：预填现有 transport 明细；名称与落点锁定（名称即身份，save 按 upsert 覆盖），enabled 保留。
    mcpForm(api, v, { type: current.transport.type, lock: { name: current.name, scope: current.scope, enabled: current.enabled, transport: current.transport } })
  } else if (inputChar === 't' && current) {
    api.post({ type: 'mcp_manage', action: 'toggle', scope: current.scope, name: current.name, enabled: !current.enabled })
  } else if (inputChar === 'd' && current) {
    api.suppressEnter()
    api.openMenu(`删除 server ${current.name}（${current.scope}）？配置条目将移除，进程停止。`, [
      { label: '确认删除', onSelect: () => { api.post({ type: 'mcp_manage', action: 'delete', scope: current.scope, name: current.name }); api.setView(v) } },
      { label: '取消', onSelect: () => api.setView(v) },
    ], v)
  }
}

const SCOPE_OPTIONS = [
  { label: '全局（~/.dogegg/config.json，所有项目可用）', value: 'global' },
  { label: '项目（.dogegg/.mcp.json，随仓库共享）', value: 'project' },
]

// 表单流（重构自逐字段 prompt 链）：全部字段一屏列出——落点/名称（编辑态锁定）、
// 按 type 展开传输字段；Enter 逐字段编辑/切换，s 或保存行提交；校验失败 notice 并留在表单；
// esc 随时回列表不保存。编辑态 enabled 保留（编辑停用中的 server 不会误启用）。
function mcpForm(api: McpKeysApi, panel: Extract<View, { kind: 'mcp' }>, opts: {
  type: 'stdio' | 'http'
  lock?: { name: string; scope: 'global' | 'project'; enabled: boolean; transport: McpServerConfig['transport'] }
}): void {
  const t = opts.lock?.transport
  const fields: FormField[] = [
    { label: '落点', value: opts.lock?.scope ?? 'global', options: SCOPE_OPTIONS, readonly: !!opts.lock },
    { label: '名称', value: opts.lock?.name ?? '', readonly: !!opts.lock },
  ]
  if (opts.type === 'stdio') {
    fields.push(
      { label: 'command', value: t?.type === 'stdio' ? t.command : '' },
      { label: 'args（JSON 数组，如 ["-y","@mcp/server"]）', value: t?.type === 'stdio' ? JSON.stringify(t.args ?? []) : '[]' },
      { label: 'env（JSON 对象，如 {"KEY":"V"}）', value: t?.type === 'stdio' && t.env ? JSON.stringify(t.env) : '{}' },
    )
  } else {
    fields.push(
      { label: 'url（Streamable HTTP 端点）', value: t?.type === 'http' ? t.url : '' },
      { label: 'headers（JSON 对象，如 {"Authorization":"Bearer x"}）', value: t?.type === 'http' && t.headers ? JSON.stringify(t.headers) : '{}' },
    )
  }
  api.setView({
    kind: 'form',
    title: `${opts.lock ? '编辑' : '新建'} MCP server（${opts.type}）`,
    fields,
    cursor: 0,
    returnView: panel,
    submitLabel: '保存 server',
    onSubmit: (values) => submitMcp(api, panel, opts, values),
  })
}

// 提交校验与落库：值序 = [落点, 名称, ...传输字段]。失败 notice 并留在表单（不写配置——宁可少配不可错配）。
function submitMcp(
  api: McpKeysApi,
  panel: Extract<View, { kind: 'mcp' }>,
  opts: { type: 'stdio' | 'http'; lock?: { name: string; scope: 'global' | 'project'; enabled: boolean; transport: McpServerConfig['transport'] } },
  values: string[],
): void {
  const [scope, name, ...rest] = values
  if (!name?.trim()) { api.notice('名称不能为空——未保存'); return }
  const finalScope = (opts.lock?.scope ?? scope) as 'global' | 'project'
  const enabled = opts.lock?.enabled ?? true

  let transport: McpServerConfig['transport']
  if (opts.type === 'stdio') {
    const command = rest[0]?.trim() ?? ''
    if (!command) { api.notice('command 不能为空——未保存'); return }
    const args = parseJsonField(api, 'args', rest[1] ?? '')
    if (!args.ok) return
    if (!Array.isArray(args.value)) { api.notice('args 应为 JSON 数组——未保存'); return }
    const env = parseJsonField(api, 'env', rest[2] ?? '')
    if (!env.ok) return
    if (env.value !== undefined && (typeof env.value !== 'object' || Array.isArray(env.value))) { api.notice('env 应为 JSON 对象——未保存'); return }
    transport = { type: 'stdio', command, args: args.value as string[], ...(env.value ? { env: env.value as Record<string, string> } : {}) }
  } else {
    const url = rest[0]?.trim() ?? ''
    if (!url) { api.notice('url 不能为空——未保存'); return }
    const headers = parseJsonField(api, 'headers', rest[1] ?? '')
    if (!headers.ok) return
    if (headers.value !== undefined && (typeof headers.value !== 'object' || Array.isArray(headers.value))) { api.notice('headers 应为 JSON 对象——未保存'); return }
    transport = { type: 'http', url, ...(headers.value ? { headers: headers.value as Record<string, string> } : {}) }
  }

  api.post({ type: 'mcp_manage', action: 'save', scope: finalScope, server: { name: name.trim(), enabled, transport } })
  api.setView(panel) // 回列表——mcp_list 广播驱动刷新
}

// JSON 字段解析：空串 → 兜底；非法 JSON → notice + ok:false（提交中止，留在表单修正）。
function parseJsonField(api: McpKeysApi, label: string, raw: string): { ok: true; value: unknown } | { ok: false } {
  const t = raw.trim()
  if (!t) return { ok: true, value: undefined }
  try { return { ok: true, value: JSON.parse(t) } } catch {
    api.notice(`${label} 不是合法 JSON——未保存`)
    return { ok: false }
  }
}
