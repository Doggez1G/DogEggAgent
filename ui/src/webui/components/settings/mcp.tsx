import { useEffect, useState } from 'react'
import { Plus, Trash2, Pencil } from 'lucide-react'
import type { UiPort } from '@dogegg/bridge'
import { emptyForm, formToServer, serverToForm, type McpItem } from './mcp-form'
import { safeSettingsPost } from './safe-post'
import styles from './settings.module.css'

// MCP Servers 管理区（M4.2）：配置 + 运行时状态列表，增删改 + 启停。
// 数据流：mcp_request 拉取 → mcp_list 广播刷新（状态随生命周期实时变化）；CRUD 走 mcp_manage。
// 表单字段：args/env/headers 用 JSON 字面量输入（无歧义）；解析失败由 agent 侧校验兜底转 notice。
// 表单互转/校验的纯逻辑在 ./mcp-form（可单测）；提交失败走 safeSettingsPost → inlineError。

// 编辑态 = 表单 + 原条目（origin）。origin 非空即编辑已有 server：名称与作用域锁定——
// 名称即 upsert 键，改名等于新建另一条而不是修改原条目；scope 决定写入哪个配置文件，同理锁定。
interface EditingState {
  form: ReturnType<typeof serverToForm>
  origin: McpItem | null
}

const STATUS_LABEL: Record<McpItem['status'], string> = { running: '运行中', starting: '启动中', error: '出错', stopped: '已停用' }

export function McpSection({ port }: { port: UiPort }) {
  const [servers, setServers] = useState<McpItem[]>([])
  const [editing, setEditing] = useState<EditingState | null>(null)
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

  const save = (f: EditingState['form']): void => {
    const result = formToServer(f)
    if ('error' in result) { setFormError(result.error); return }
    setFormError('')
    safeSettingsPost(port, { type: 'mcp_manage', action: 'save', scope: f.scope, server: result }, (e) => setInlineError(`保存失败：${e.message}`))
    setEditing(null)
  }

  const groups: { label: string; scope: 'global' | 'project' }[] = [
    { label: '全局（~/.dogegg/config.json）', scope: 'global' },
    { label: '项目（.dogegg/.mcp.json）', scope: 'project' },
  ]

  // 编辑态：表单覆盖整个 section（保存/取消返回列表）。
  if (editing) {
    const f = editing.form
    const locked = editing.origin !== null
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className={styles.sectionTitle}>{locked ? `编辑 server：${editing.origin!.name}` : '新建 MCP server'}</div>
        {/* 编辑态锁定 scope：作用域决定写入哪个配置文件，变更等于搬到另一处而非修改。 */}
        <select
          className={styles.input}
          value={f.scope}
          disabled={locked}
          onChange={(e) => setEditing({ ...editing, form: { ...f, scope: e.target.value as 'global' | 'project' } })}
          title={locked ? '编辑已有 server 时不可更改作用域' : undefined}
        >
          <option value="global">全局（~/.dogegg/config.json）</option>
          <option value="project">项目（.dogegg/.mcp.json）</option>
        </select>
        {/* 编辑态锁定名称：名称即 upsert 键，改名等于新建另一条 server 而非修改原条目。 */}
        <input
          className={styles.input}
          placeholder="名称（如 fs / github）"
          value={f.name}
          readOnly={locked}
          onChange={(e) => setEditing({ ...editing, form: { ...f, name: e.target.value } })}
          title={locked ? '名称即 upsert 键，改名等于新建——编辑态不可改' : undefined}
        />
        <select className={styles.input} value={f.type} onChange={(e) => setEditing({ ...editing, form: { ...f, type: e.target.value as 'stdio' | 'http' } })}>
          <option value="stdio">stdio（本地进程）</option>
          <option value="http">http（远程服务）</option>
        </select>
        {f.type === 'stdio' ? (
          <>
            <input className={styles.input} placeholder="command（如 npx / node）" value={f.command} onChange={(e) => setEditing({ ...editing, form: { ...f, command: e.target.value } })} />
            <input className={styles.input} placeholder='args（JSON 数组，如 ["-y","@mcp/server"]）' value={f.args} onChange={(e) => setEditing({ ...editing, form: { ...f, args: e.target.value } })} />
            <input className={styles.input} placeholder='env（JSON 对象，可空）' value={f.env} onChange={(e) => setEditing({ ...editing, form: { ...f, env: e.target.value } })} />
          </>
        ) : (
          <>
            <input className={styles.input} placeholder="url（Streamable HTTP 端点）" value={f.url} onChange={(e) => setEditing({ ...editing, form: { ...f, url: e.target.value } })} />
            <input className={styles.input} placeholder='headers（JSON 对象，可空）' value={f.headers} onChange={(e) => setEditing({ ...editing, form: { ...f, headers: e.target.value } })} />
          </>
        )}
        {formError && <div style={{ color: 'var(--color-danger)', fontSize: 12 }}>{formError}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className={styles.actionBtn} onClick={() => save(f)}>保存（保存即重启该 server）</button>
          <button className={styles.actionBtn} onClick={() => { setEditing(null); setFormError('') }}>取消</button>
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
                    {/* 名称超长单行省略（mcpCardName）——全名放 title 悬停可看。 */}
                    <span className={styles.mcpCardName} title={s.name}>{s.enabled ? s.name : `${s.name}（已停用）`}</span>
                    <span className={styles.mcpBadge}>{s.transport.type}</span>
                    <span className={styles.mcpBadge} data-status={s.status}>{STATUS_LABEL[s.status]}</span>
                  </div>
                  <div className={styles.mcpCardMeta}>{s.tools.length} 个工具</div>
                  {s.error && <div className={styles.mcpCardError} title={s.error}>{s.error}</div>}
                </div>
                <div className={styles.mcpCardActions}>
                  <button className={styles.actionBtn} onClick={() => safeSettingsPost(port, { type: 'mcp_manage', action: 'toggle', scope: s.scope, name: s.name, enabled: !s.enabled }, (e) => setInlineError(`操作失败：${e.message}`))}>{s.enabled ? '停用' : '启用'}</button>
                  <button className={styles.permChipX} title="编辑" onClick={() => { setFormError(''); setEditing({ form: serverToForm(s), origin: s }) }}><Pencil size={12} /></button>
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
          <button className={styles.actionBtn} onClick={() => { safeSettingsPost(port, { type: 'mcp_manage', action: 'delete', scope: pendingDelete.scope, name: pendingDelete.name }, (e) => setInlineError(`删除失败：${e.message}`)); setPendingDelete(null) }}>确认</button>
          <button className={styles.actionBtn} onClick={() => setPendingDelete(null)}>取消</button>
        </div>
      )}

      {!editing && (
        <button className={styles.actionBtn} onClick={() => { setFormError(''); setEditing({ form: emptyForm('global'), origin: null }) }}><Plus size={14} /> 新建 MCP server</button>
      )}
    </div>
  )
}
