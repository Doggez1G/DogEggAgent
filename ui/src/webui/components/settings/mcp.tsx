import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2, Pencil } from 'lucide-react'
import type { McpServerConfig, UiPort } from '@dogegg/bridge'
import styles from './settings.module.css'

// MCP Servers 管理区（M4.2）：配置 + 运行时状态列表，增删改 + 启停。
// 数据流：mcp_request 拉取 → mcp_list 广播刷新（状态随生命周期实时变化）；CRUD 走 mcp_manage。
// 表单字段：args/env/headers 用 JSON 字面量输入（无歧义）；解析失败由 agent 侧校验兜底转 notice。

interface McpItem {
  name: string
  enabled: boolean
  scope: 'global' | 'project'
  transport: McpServerConfig['transport']
  status: 'running' | 'starting' | 'error' | 'stopped'
  error?: string
  tools: { name: string; description: string }[]
}

interface FormState {
  scope: 'global' | 'project'
  name: string
  type: 'stdio' | 'http'
  command: string
  args: string   // JSON 数组字面量
  env: string    // JSON 对象字面量（可空）
  url: string
  headers: string // JSON 对象字面量（可空）
}

const emptyForm = (scope: 'global' | 'project'): FormState => ({ scope, name: '', type: 'stdio', command: '', args: '[]', env: '', url: '', headers: '' })

function formToServer(f: FormState): McpServerConfig | { error: string } {
  if (!f.name.trim()) return { error: '缺少名称' }
  if (f.type === 'stdio') {
    let args: string[] = []
    try { args = f.args.trim() ? JSON.parse(f.args) as string[] : [] } catch { return { error: 'args 不是合法 JSON 数组' } }
    let env: Record<string, string> | undefined
    if (f.env.trim()) {
      try { env = JSON.parse(f.env) as Record<string, string> } catch { return { error: 'env 不是合法 JSON 对象' } }
    }
    if (!f.command.trim()) return { error: '缺少 command' }
    return { name: f.name.trim(), enabled: true, transport: { type: 'stdio', command: f.command.trim(), args, ...(env ? { env } : {}) } }
  }
  if (!f.url.trim()) return { error: '缺少 url' }
  let headers: Record<string, string> | undefined
  if (f.headers.trim()) {
    try { headers = JSON.parse(f.headers) as Record<string, string> } catch { return { error: 'headers 不是合法 JSON 对象' } }
  }
  return { name: f.name.trim(), enabled: true, transport: { type: 'http', url: f.url.trim(), ...(headers ? { headers } : {}) } }
}

// 条目 → 表单预填（编辑场景：mcp_list 快照携带 transport 明细，全字段预填；名称锁定不可改）。
function serverToForm(item: McpItem): FormState {
  const base = emptyForm(item.scope)
  if (item.transport.type === 'stdio') {
    return { ...base, name: item.name, type: 'stdio', command: item.transport.command, args: JSON.stringify(item.transport.args ?? []), env: item.transport.env ? JSON.stringify(item.transport.env) : '' }
  }
  return { ...base, name: item.name, type: 'http', url: item.transport.url, headers: item.transport.headers ? JSON.stringify(item.transport.headers) : '' }
}

const STATUS_LABEL: Record<McpItem['status'], string> = { running: '运行中', starting: '启动中', error: '出错', stopped: '已停用' }

export function McpSection({ port }: { port: UiPort }) {
  const [servers, setServers] = useState<McpItem[]>([])
  const [editing, setEditing] = useState<FormState | null>(null)
  const [formError, setFormError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<McpItem | null>(null)
  // 操作失败的 inline 反馈（agent 对 manage 失败的 notice 带 channel='mcp'）；mcp_list 到达即清除。
  const [inlineError, setInlineError] = useState('')

  useEffect(() => {
    port.post({ type: 'mcp_request' })
    const off = port.onMessage((msg) => {
      if (msg.type === 'mcp_list') { setServers(msg.servers); setInlineError('') }
      else if (msg.type === 'notice' && msg.channel === 'mcp') setInlineError(msg.text)
    })
    return off
  }, [port])

  const save = (f: FormState): void => {
    const result = formToServer(f)
    if ('error' in result) { setFormError(result.error); return }
    setFormError('')
    port.post({ type: 'mcp_manage', action: 'save', scope: f.scope, server: result })
    setEditing(null)
  }

  const groups: { label: string; scope: 'global' | 'project' }[] = [
    { label: '全局（~/.dogegg/config.json）', scope: 'global' },
    { label: '项目（.dogegg/.mcp.json）', scope: 'project' },
  ]

  // 编辑态：表单覆盖整个 section（保存/取消返回列表）。
  if (editing) {
    const f = editing
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className={styles.sectionTitle}>{f.name ? `编辑 server：${f.name}` : '新建 MCP server'}</div>
        <select className={styles.input} value={f.scope} onChange={(e) => setEditing({ ...f, scope: e.target.value as 'global' | 'project' })}>
          <option value="global">全局（~/.dogegg/config.json）</option>
          <option value="project">项目（.dogegg/.mcp.json）</option>
        </select>
        <input className={styles.input} placeholder="名称（如 fs / github）" value={f.name} onChange={(e) => setEditing({ ...f, name: e.target.value })} />
        <select className={styles.input} value={f.type} onChange={(e) => setEditing({ ...f, type: e.target.value as 'stdio' | 'http' })}>
          <option value="stdio">stdio（本地进程）</option>
          <option value="http">http（远程服务）</option>
        </select>
        {f.type === 'stdio' ? (
          <>
            <input className={styles.input} placeholder="command（如 npx / node）" value={f.command} onChange={(e) => setEditing({ ...f, command: e.target.value })} />
            <input className={styles.input} placeholder='args（JSON 数组，如 ["-y","@mcp/server"]）' value={f.args} onChange={(e) => setEditing({ ...f, args: e.target.value })} />
            <input className={styles.input} placeholder='env（JSON 对象，可空）' value={f.env} onChange={(e) => setEditing({ ...f, env: e.target.value })} />
          </>
        ) : (
          <>
            <input className={styles.input} placeholder="url（Streamable HTTP 端点）" value={f.url} onChange={(e) => setEditing({ ...f, url: e.target.value })} />
            <input className={styles.input} placeholder='headers（JSON 对象，可空）' value={f.headers} onChange={(e) => setEditing({ ...f, headers: e.target.value })} />
          </>
        )}
        {formError && <div style={{ color: 'var(--color-danger)', fontSize: 12 }}>{formError}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className={styles.navItem} onClick={() => save(f)}>保存（保存即重启该 server）</button>
          <button className={styles.navItem} onClick={() => { setEditing(null); setFormError('') }}>取消</button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className={styles.sectionTitle}>MCP Servers</div>
      {inlineError && <div style={{ color: 'var(--color-danger)', fontSize: 12, marginBottom: 8 }}>{inlineError}</div>}
      {groups.map((g) => {
        const items = servers.filter((s) => s.scope === g.scope)
        return (
          <div key={g.scope} style={{ marginBottom: 16 }}>
            <div className={styles.sectionTitle} style={{ fontSize: 12, opacity: 0.7 }}>{g.label}</div>
            {items.length === 0 && <div style={{ opacity: 0.5, fontSize: 12 }}>（无）</div>}
            {items.map((s) => (
              <div key={s.name} className={styles.mcpCard}>
                <span className={styles.mcpStatusDot} data-status={s.status} />
                <div className={styles.mcpCardBody}>
                  <div className={styles.mcpCardTitle}>
                    <span className={styles.mcpCardName}>{s.enabled ? s.name : `${s.name}（已停用）`}</span>
                    <span className={styles.mcpBadge}>{s.transport.type}</span>
                    <span className={styles.mcpBadge} data-status={s.status}>{STATUS_LABEL[s.status]}</span>
                  </div>
                  <div className={styles.mcpCardMeta}>{s.tools.length} 个工具</div>
                  {s.error && <div className={styles.mcpCardError} title={s.error}>{s.error}</div>}
                </div>
                <div className={styles.mcpCardActions}>
                  <button className={styles.navItem} onClick={() => port.post({ type: 'mcp_manage', action: 'toggle', scope: s.scope, name: s.name, enabled: !s.enabled })}>{s.enabled ? '停用' : '启用'}</button>
                  <button className={styles.permChipX} title="编辑" onClick={() => { setFormError(''); setEditing(serverToForm(s)) }}><Pencil size={12} /></button>
                  <button className={styles.permChipX} title="删除" onClick={() => setPendingDelete(s)}><Trash2 size={12} /></button>
                </div>
              </div>
            ))}
          </div>
        )
      })}

      {pendingDelete && (
        <div className={styles.providerItem} style={{ borderColor: 'var(--color-danger)' }}>
          <div style={{ flex: 1 }}>确认删除 server「{pendingDelete.name}」（{pendingDelete.scope}）？配置移除、进程停止。</div>
          <button className={styles.navItem} onClick={() => { port.post({ type: 'mcp_manage', action: 'delete', scope: pendingDelete.scope, name: pendingDelete.name }); setPendingDelete(null) }}>确认</button>
          <button className={styles.navItem} onClick={() => setPendingDelete(null)}>取消</button>
        </div>
      )}

      {!editing && (
        <button className={styles.navItem} onClick={() => { setFormError(''); setEditing(emptyForm('global')) }}><Plus size={14} /> 新建 MCP server</button>
      )}
    </div>
  )
}
