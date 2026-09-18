import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2, Pencil } from 'lucide-react'
import type { UiPort } from '@dogegg/bridge'
import styles from './settings.module.css'

// Skills 管理区（M4.1）：项目级/用户级两组列表 + 创建表单 + 全文编辑 + 删除确认。
// 数据流：skills_request 拉取 → skills_list 广播刷新；CRUD 走 skills_manage（编辑先经 get 取全文）。
// 与 TUI /skills 面板共用同一套 agent 消息——两端对称，无各自的后端。

interface SkillItem {
  name: string
  description: string
  scope: 'project' | 'user'
  path: string
}

export function SkillsSection({ port }: { port: UiPort }) {
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ scope: 'project' as 'project' | 'user', name: '', description: '' })
  const [editing, setEditing] = useState<{ item: SkillItem; content: string } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<SkillItem | null>(null)
  // 操作失败的inline反馈：agent 对 CRUD 失败的 notice 带 channel='skills'——设置弹框内直接可见
  //（notice 也会进聊天区，但用户正看着设置页，那里不该是唯一反馈面）。成功清单到达即清除。
  const [inlineError, setInlineError] = useState('')

  // get 响应的匹配锚点——skill_content 到达时核对是哪一次请求（防止旧响应打开错误的编辑器）。
  const pendingGetRef = useRef<SkillItem | null>(null)

  useEffect(() => {
    port.post({ type: 'skills_request' })
    const off = port.onMessage((msg) => {
      if (msg.type === 'skills_list') { setSkills(msg.skills); setInlineError('') }
      else if (msg.type === 'notice' && msg.channel === 'skills') setInlineError(msg.text)
      else if (msg.type === 'skill_content' && pendingGetRef.current && msg.name === pendingGetRef.current.name && msg.scope === pendingGetRef.current.scope) {
        setEditing({ item: pendingGetRef.current, content: msg.content })
      }
    })
    return off
  }, [port])

  const requestEdit = (item: SkillItem): void => {
    pendingGetRef.current = item
    port.post({ type: 'skills_manage', action: 'get', scope: item.scope, name: item.name })
  }

  const create = (): void => {
    const name = form.name.trim()
    if (!name) return
    port.post({ type: 'skills_manage', action: 'create', scope: form.scope, name, description: form.description.trim() })
    setCreating(false)
    setForm({ scope: form.scope, name: '', description: '' })
  }

  const saveEdit = (): void => {
    if (!editing) return
    port.post({ type: 'skills_manage', action: 'update', scope: editing.item.scope, name: editing.item.name, content: editing.content })
    setEditing(null)
  }

  const groups: { label: string; scope: 'project' | 'user' }[] = [
    { label: '项目级（.dogegg/skills）', scope: 'project' },
    { label: '用户级（~/.dogegg/skills）', scope: 'user' },
  ]

  // 编辑态：整区切换为全文编辑器（textarea + 保存/取消）。
  if (editing) {
    return (
      <div>
        <div className={styles.sectionTitle}>编辑 skill：{editing.item.name}（{editing.item.scope}）</div>
        <textarea
          className={styles.skillEditor}
          value={editing.content}
          onChange={(e) => setEditing({ ...editing, content: e.target.value })}
          spellCheck={false}
        />
        <div className={styles.sectionTitle}>
          <button className={styles.navItem} onClick={saveEdit}>保存</button>
          <button className={styles.navItem} onClick={() => setEditing(null)}>取消</button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className={styles.sectionTitle}>Skills</div>
      {inlineError && <div style={{ color: 'var(--color-danger)', fontSize: 12, marginBottom: 8 }}>{inlineError}</div>}
      {groups.map((g) => {
        const items = skills.filter((s) => s.scope === g.scope)
        return (
          <div key={g.scope} style={{ marginBottom: 16 }}>
            <div className={styles.sectionTitle} style={{ fontSize: 12, opacity: 0.7 }}>{g.label}</div>
            {items.length === 0 && <div style={{ opacity: 0.5, fontSize: 12 }}>（无）</div>}
            {items.map((s) => (
              <div key={`${s.scope}/${s.name}`} className={styles.providerItem}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>/{s.name}</div>
                  <div style={{ opacity: 0.6, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.description || '（无描述）'}
                  </div>
                </div>
                <button className={styles.permChipX} title="编辑" onClick={() => requestEdit(s)}><Pencil size={12} /></button>
                <button className={styles.permChipX} title="删除" onClick={() => setPendingDelete(s)}><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
        )
      })}

      {pendingDelete && (
        <div className={styles.providerItem} style={{ borderColor: 'var(--color-danger)' }}>
          <div style={{ flex: 1 }}>确认删除 skill「{pendingDelete.name}」（{pendingDelete.scope}）？目录整体删除，不可恢复。</div>
          <button className={styles.navItem} onClick={() => { port.post({ type: 'skills_manage', action: 'delete', scope: pendingDelete.scope, name: pendingDelete.name }); setPendingDelete(null) }}>确认</button>
          <button className={styles.navItem} onClick={() => setPendingDelete(null)}>取消</button>
        </div>
      )}

      {!creating && (
        <button className={styles.navItem} onClick={() => setCreating(true)}><Plus size={14} /> 新建 skill</button>
      )}
      {creating && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <select className={styles.input} value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as 'project' | 'user' })}>
            <option value="project">项目级（.dogegg/skills）</option>
            <option value="user">用户级（~/.dogegg/skills）</option>
          </select>
          <input className={styles.input} placeholder="名称（小写字母/数字/连字符，即 /命令名）" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className={styles.input} placeholder="一句话描述（模型与面板靠它判断何时使用）" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className={styles.navItem} onClick={create}>创建（生成骨架 SKILL.md）</button>
            <button className={styles.navItem} onClick={() => setCreating(false)}>取消</button>
          </div>
        </div>
      )}
    </div>
  )
}
