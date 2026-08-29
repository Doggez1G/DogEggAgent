import React, { useState, useCallback } from 'react'
import { SlidersHorizontal, Cpu, ShieldCheck, Wrench, Gauge, Terminal, ScrollText } from 'lucide-react'
import type { Config, UiPort } from '@dogegg/bridge'
import { buildEntries, parentPath, entryLabel, type ConfigPath, type Entry, type TreeCtx } from '../../../shared/config'
import type { SettingsTab } from '../../app/view-state'
import styles from './settings.module.css'

// 设置面板：二级导航（7 个标签页）+ 内容区。
// models 标签页复用 shared/config 的 buildEntries + TreeCtx（与 TUI 的 config 编辑器共享逻辑）。
// 其余标签页根据消息响应类型渲染只读信息。
interface SettingsProps {
  tab: SettingsTab
  config: Config | null
  port: UiPort
  // 各标签页的数据（由 App 从后端消息接收后传入）
  toolsList: { name: string; description: string }[]
  contextState: { estimatedTokens: number; windowTokens: number; percent: number } | null
  systemState: { path: string; content: string } | null
  logState: { path: string; tail: string } | null
  permissionsList: string[]
  onTabChange: (tab: SettingsTab) => void
}

const TABS: { tab: SettingsTab; icon: typeof SlidersHorizontal; label: string }[] = [
  { tab: 'general', icon: SlidersHorizontal, label: 'General' },
  { tab: 'models', icon: Cpu, label: 'Models' },
  { tab: 'permissions', icon: ShieldCheck, label: 'Permissions' },
  { tab: 'tools', icon: Wrench, label: 'Tools' },
  { tab: 'context', icon: Gauge, label: 'Context' },
  { tab: 'system-prompt', icon: Terminal, label: 'System' },
  { tab: 'logs', icon: ScrollText, label: 'Logs' },
]

export function Settings(props: SettingsProps) {
  return (
    <div className={styles.settings + ' panel-enter'}>
      <nav className={styles.tabNav}>
        {TABS.map(({ tab, icon: Icon, label }) => (
          <button
            key={tab}
            className={`${styles.tabBtn} ${props.tab === tab ? styles.tabActive : ''} sidebar-item`}
            onClick={() => props.onTabChange(tab)}
          >
            <Icon size={16} strokeWidth={1.5} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className={styles.tabContent}>
        {props.tab === 'general' && <GeneralTab config={props.config} port={props.port} />}
        {props.tab === 'models' && <ModelsTab config={props.config} port={props.port} />}
        {props.tab === 'permissions' && <PermissionsTab tools={props.permissionsList} port={props.port} />}
        {props.tab === 'tools' && <ToolsTab tools={props.toolsList} port={props.port} />}
        {props.tab === 'context' && <ContextTab state={props.contextState} port={props.port} />}
        {props.tab === 'system-prompt' && <SystemPromptTab state={props.systemState} port={props.port} />}
        {props.tab === 'logs' && <LogsTab state={props.logState} port={props.port} />}
      </div>
    </div>
  )
}

// TreeCtx：把 config 编辑操作翻译成 UiToAgentMessage。
function useTreeCtx(port: UiPort): TreeCtx {
  return {
    set: (path, value) => port.post({ type: 'config_set', path, value }),
    add: (path, value) => port.post({ type: 'config_add', path, value }),
    remove: (path, index, providerIndex) => port.post({ type: 'config_remove', path, index, providerIndex }),
  }
}

// ── General 标签页：systemPrompt / maxIterations / maxRetries / shellProgram 编辑 ──
function GeneralTab({ config, port }: { config: Config | null; port: UiPort }) {
  const [editing, setEditing] = useState<string | null>(null)
  const [value, setValue] = useState('')
  if (!config) return <p className={styles.empty}>Loading config...</p>

  const fields = [
    { key: 'systemPrompt', label: 'System Prompt', value: config.systemPrompt ?? '' },
    { key: 'maxIterations', label: 'Max Iterations', value: String(config.maxIterations) },
    { key: 'maxRetries', label: 'Max Retries', value: String(config.maxRetries) },
    { key: 'shellProgram', label: 'Shell Program', value: config.shellProgram ?? '(platform default)' },
  ]

  return (
    <div className={styles.fieldList}>
      {fields.map((f) => (
        <div key={f.key} className={styles.fieldRow}>
          <span className={styles.fieldLabel}>{f.label}</span>
          {editing === f.key ? (
            <form className={styles.fieldEdit} onSubmit={(e) => { e.preventDefault(); port.post({ type: 'config_set', path: f.key, value: f.key === 'maxIterations' || f.key === 'maxRetries' ? Number(value) || 0 : value }); setEditing(null) }}>
              <input className={styles.fieldInput} value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
              <button type="submit" className={styles.btnPrimary}>Save</button>
              <button type="button" className={styles.btnSecondary} onClick={() => setEditing(null)}>Cancel</button>
            </form>
          ) : (
            <button className={styles.fieldValue} onClick={() => { setEditing(f.key); setValue(f.value) }}>
              {f.value || '(empty)'}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Models 标签页：复用 shared/config buildEntries + TreeCtx ──
function ModelsTab({ config, port }: { config: Config | null; port: UiPort }) {
  const [path, setPath] = useState<ConfigPath>({ kind: 'root' })
  const [cursor, setCursor] = useState(0)
  const ctx = useTreeCtx(port)
  if (!config) return <p className={styles.empty}>Loading config...</p>

  const entries = buildEntries(config, path, ctx)
  const entry = entries[cursor]

  const navigate = (dir: 'up' | 'down' | 'enter' | 'back') => {
    if (dir === 'up') setCursor((c) => (c + entries.length - 1) % Math.max(1, entries.length))
    else if (dir === 'down') setCursor((c) => (c + 1) % Math.max(1, entries.length))
    else if (dir === 'enter' && entry?.kind === 'goto') { setPath(entry.subPath); setCursor(0) }
    else if (dir === 'back') { const p = parentPath(path); if (p) { setPath(p); setCursor(0) } }
  }

  return (
    <div className={styles.treeEditor}>
      <div className={styles.treeBreadcrumb}>
        <button className={styles.crumbBtn} onClick={() => navigate('back')} disabled={path.kind === 'root'}>
          ← Back
        </button>
        <span className={styles.crumbPath}>{path.kind}</span>
      </div>
      <div className={styles.treeList}>
        {entries.map((e, i) => (
          <div
            key={i}
            className={`${styles.treeItem} ${i === cursor ? styles.treeActive : ''}`}
            onClick={() => setCursor(i)}
            onDoubleClick={() => navigate('enter')}
          >
            <span className={styles.treeLabel}>{entryLabel(e)}</span>
            {e.kind === 'goto' && <span className={styles.treeArrow}>›</span>}
          </div>
        ))}
        {entries.length === 0 && <p className={styles.empty}>No items</p>}
      </div>
      <div className={styles.treeActions}>
        <button className={styles.btnSecondary} onClick={() => navigate('up')}>↑</button>
        <button className={styles.btnSecondary} onClick={() => navigate('down')}>↓</button>
        {entry?.kind === 'goto' && <button className={styles.btnPrimary} onClick={() => navigate('enter')}>Enter</button>}
        {entry?.kind === 'action' && <button className={styles.btnPrimary} onClick={() => entry.run()}>Run</button>}
      </div>
    </div>
  )
}

// ── Permissions 标签页：allow_always 列表 + 撤销 ──
function PermissionsTab({ tools, port }: { tools: string[]; port: UiPort }) {
  React.useEffect(() => { port.post({ type: 'permissions_request' }) }, [port])
  return (
    <div className={styles.fieldList}>
      {tools.length === 0 ? (
        <p className={styles.empty}>No always-allowed tools in this session. Select "Allow Always" in the permission dialog to add tools here.</p>
      ) : (
        tools.map((t) => (
          <div key={t} className={styles.fieldRow}>
            <span className={styles.fieldLabel}>{t}</span>
            <button className={styles.btnDanger} onClick={() => port.post({ type: 'permission_revoke', tool: t })}>Revoke</button>
          </div>
        ))
      )}
    </div>
  )
}

// ── Tools 标签页：工具列表（只读）──
function ToolsTab({ tools, port }: { tools: { name: string; description: string }[]; port: UiPort }) {
  React.useEffect(() => { port.post({ type: 'tools_request' }) }, [port])
  return (
    <div className={styles.fieldList}>
      {tools.map((t) => (
        <div key={t.name} className={styles.toolRow}>
          <code className={styles.toolName}>{t.name}</code>
          <span className={styles.toolDesc}>{t.description}</span>
        </div>
      ))}
    </div>
  )
}

// ── Context 标签页：token 占用（只读）──
function ContextTab({ state, port }: { state: { estimatedTokens: number; windowTokens: number; percent: number } | null; port: UiPort }) {
  React.useEffect(() => { port.post({ type: 'context_request' }) }, [port])
  if (!state) return <p className={styles.empty}>Loading context...</p>
  const threshold = Math.round(state.windowTokens * 0.8)
  return (
    <div className={styles.fieldList}>
      <div className={styles.fieldRow}>
        <span className={styles.fieldLabel}>Usage</span>
        <span className={styles.fieldValue}>{state.estimatedTokens.toLocaleString()} / {state.windowTokens.toLocaleString()} tokens ({state.percent}%)</span>
      </div>
      <div className={styles.contextBar}>
        <div className={styles.contextFill} style={{ width: `${Math.min(100, state.percent)}%` }} data-overload={state.percent > 80} />
      </div>
      <p className={styles.hint}>Compaction threshold: 80% = {threshold.toLocaleString()} tokens</p>
    </div>
  )
}

// ── System Prompt 标签页：路径 + 内容（只读）──
function SystemPromptTab({ state, port }: { state: { path: string; content: string } | null; port: UiPort }) {
  React.useEffect(() => { port.post({ type: 'system_request' }) }, [port])
  if (!state) return <p className={styles.empty}>Loading system prompt...</p>
  return (
    <div className={styles.fieldList}>
      <p className={styles.hint}>Path: {state.path}</p>
      <pre className={styles.codeBlock}>{state.content}</pre>
    </div>
  )
}

// ── Logs 标签页：路径 + tail（只读）──
function LogsTab({ state, port }: { state: { path: string; tail: string } | null; port: UiPort }) {
  React.useEffect(() => { port.post({ type: 'log_request' }) }, [port])
  if (!state) return <p className={styles.empty}>Loading logs...</p>
  return (
    <div className={styles.fieldList}>
      <p className={styles.hint}>Path: {state.path}</p>
      <pre className={styles.codeBlock}>{state.tail}</pre>
    </div>
  )
}
