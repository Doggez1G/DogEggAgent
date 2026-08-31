import React, { useState } from 'react'
import { SlidersHorizontal, Cpu, ShieldCheck, Wrench, Gauge, Terminal, ScrollText, ChevronRight, Plus, Trash2, Check, X, FolderClosed, Clock } from 'lucide-react'
import type { Config, UiPort } from '@dogegg/bridge'
import { buildEntries, parentPath, entryLabel, type ConfigPath, type Entry, type TreeCtx } from '../../../shared/config'
import type { SettingsTab } from '../../app/view-state'
import styles from './settings.module.css'

// 设置弹窗：左侧 tab 导航 + 右侧内容区。
// 每个标签页使用表单组件（Toggle / Select / Input / Card）而非简陋的行内编辑。
interface SettingsProps {
  tab: SettingsTab
  config: Config | null
  port: UiPort
  toolsList: { name: string; description: string }[]
  contextState: { estimatedTokens: number; windowTokens: number; percent: number } | null
  systemState: { path: string; content: string } | null
  logState: { path: string; tail: string } | null
  permissionsList: string[]
  onTabChange: (tab: SettingsTab) => void
  onBack: () => void
}

const TABS: { tab: SettingsTab; icon: typeof SlidersHorizontal; label: string; desc: string }[] = [
  { tab: 'general', icon: SlidersHorizontal, label: 'General', desc: 'Core agent configuration' },
  { tab: 'models', icon: Cpu, label: 'Models', desc: 'Providers and model settings' },
  { tab: 'permissions', icon: ShieldCheck, label: 'Permissions', desc: 'Session tool permissions' },
  { tab: 'tools', icon: Wrench, label: 'Tools', desc: 'Available tools' },
  { tab: 'context', icon: Gauge, label: 'Context', desc: 'Token usage and limits' },
  { tab: 'system-prompt', icon: Terminal, label: 'System', desc: 'System prompt content' },
  { tab: 'logs', icon: ScrollText, label: 'Logs', desc: 'Debug log tail' },
]

export function Settings(props: SettingsProps) {
  const activeTab = TABS.find(t => t.tab === props.tab)
  return (
    <div className={styles.settings}>
      <nav className={styles.tabNav}>
        {TABS.map(({ tab, icon: Icon, label }) => (
          <button
            key={tab}
            className={`${styles.tabBtn} ${props.tab === tab ? styles.tabActive : ''}`}
            onClick={() => props.onTabChange(tab)}
          >
            <Icon size={15} strokeWidth={1.5} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className={styles.tabContent}>
        {activeTab && (
          <div className={styles.tabHeader}>
            <h2 className={styles.tabTitle}>{activeTab.label}</h2>
            <p className={styles.tabDesc}>{activeTab.desc}</p>
          </div>
        )}
        <div className={styles.tabInner}>
          {props.tab === 'general' && <GeneralTab config={props.config} port={props.port} />}
          {props.tab === 'models' && <ModelsTab config={props.config} port={props.port} />}
          {props.tab === 'permissions' && <PermissionsTab tools={props.permissionsList} port={props.port} />}
          {props.tab === 'tools' && <ToolsTab tools={props.toolsList} port={props.port} />}
          {props.tab === 'context' && <ContextTab state={props.contextState} port={props.port} />}
          {props.tab === 'system-prompt' && <SystemPromptTab state={props.systemState} port={props.port} />}
          {props.tab === 'logs' && <LogsTab state={props.logState} port={props.port} />}
        </div>
      </div>
    </div>
  )
}

// ── 通用 UI 组件 ──

// Toggle 开关
function Toggle({ on, onClick }: { on: boolean; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button className={`${styles.toggle} ${on ? styles.toggleOn : ''}`} onClick={onClick} role="switch" aria-checked={on}>
      <span className={styles.toggleKnob} />
    </button>
  )
}

// Select 下拉框
function Select({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div className={styles.selectWrap}>
      <select className={styles.select} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronRight size={12} strokeWidth={2} className={styles.selectArrow} />
    </div>
  )
}

// Input with save/cancel
function EditableInput({ value, placeholder, onSave, mono }: { value: string; placeholder: string; onSave: (v: string) => void; mono?: boolean }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  if (editing) {
    return (
      <div className={styles.inputRow}>
        <input
          className={`${styles.input} ${mono ? styles.inputMono : ''}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter') { onSave(draft); setEditing(false) } if (e.key === 'Escape') setEditing(false) }}
        />
        <button className={styles.inputSave} onClick={() => { onSave(draft); setEditing(false) }}><Check size={14} strokeWidth={2} /></button>
        <button className={styles.inputCancel} onClick={() => setEditing(false)}><X size={14} strokeWidth={2} /></button>
      </div>
    )
  }
  return (
    <button className={`${styles.editBtn} ${mono ? styles.editBtnMono : ''}`} onClick={() => { setDraft(value); setEditing(true) }}>
      {value || placeholder}
    </button>
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

// ── General 标签页：表单式编辑（Toggle / Select / EditableInput）──
function GeneralTab({ config, port }: { config: Config | null; port: UiPort }) {
  if (!config) return <p className={styles.empty}>Loading config...</p>
  const providers = config.providers.map(p => ({ value: p.name, label: p.name || '(unnamed)' }))
  const currentProviderModels = config.providers.find(p => p.name === config.defaultProvider)?.models ?? []
  const modelOptions = currentProviderModels.map(m => ({ value: m.name, label: m.name || '(unnamed)' }))

  return (
    <div className={styles.formList}>
      {/* Provider 选择 */}
      <div className={styles.formField}>
        <label className={styles.formLabel}>Default Provider</label>
        <Select
          value={config.defaultProvider ?? ''}
          options={providers.length ? providers : [{ value: '', label: '(none)' }]}
          onChange={(v) => port.post({ type: 'config_set', path: 'defaultProvider', value: v })}
        />
      </div>

      {/* Model 选择 */}
      <div className={styles.formField}>
        <label className={styles.formLabel}>Default Model</label>
        <Select
          value={config.defaultModel ?? ''}
          options={modelOptions.length ? modelOptions : [{ value: '', label: '(select provider first)' }]}
          onChange={(v) => port.post({ type: 'config_set', path: 'defaultModel', value: v })}
        />
      </div>

      {/* System Prompt */}
      <div className={styles.formField}>
        <label className={styles.formLabel}>System Prompt Path</label>
        <EditableInput
          value={config.systemPrompt ?? ''}
          placeholder='(built-in default)'
          onSave={(v) => port.post({ type: 'config_set', path: 'systemPrompt', value: v })}
          mono
        />
      </div>

      {/* Shell Program */}
      <div className={styles.formField}>
        <label className={styles.formLabel}>Shell Program</label>
        <EditableInput
          value={config.shellProgram ?? ''}
          placeholder='(auto — platform default)'
          onSave={(v) => port.post({ type: 'config_set', path: 'shellProgram', value: v })}
          mono
        />
      </div>

      {/* Max Iterations */}
      <div className={styles.formField}>
        <label className={styles.formLabel}>Max Iterations</label>
        <EditableInput
          value={String(config.maxIterations)}
          placeholder='10'
          onSave={(v) => port.post({ type: 'config_set', path: 'maxIterations', value: Number(v) || 0 })}
          mono
        />
      </div>

      {/* Max Retries */}
      <div className={styles.formField}>
        <label className={styles.formLabel}>Max Retries</label>
        <EditableInput
          value={String(config.maxRetries)}
          placeholder='3'
          onSave={(v) => port.post({ type: 'config_set', path: 'maxRetries', value: Number(v) || 0 })}
          mono
        />
      </div>

      {/* Permission Buckets */}
      <div className={styles.sectionDivider} />
      <div className={styles.formField}>
        <label className={styles.formLabel}>Permission: Always Allow</label>
        <p className={styles.formHint}>{config.permission.allow.length} tool(s) — edit in Models tab</p>
      </div>
      <div className={styles.formField}>
        <label className={styles.formLabel}>Permission: Always Reject</label>
        <p className={styles.formHint}>{config.permission.reject.length} tool(s)</p>
      </div>
      <div className={styles.formField}>
        <label className={styles.formLabel}>Permission: Ask</label>
        <p className={styles.formHint}>{config.permission.ask.length} tool(s)</p>
      </div>
    </div>
  )
}

// ── Models 标签页：树形编辑器 + 面包屑 ──
function ModelsTab({ config, port }: { config: Config | null; port: UiPort }) {
  const [path, setPath] = useState<ConfigPath>({ kind: 'root' })
  const ctx = useTreeCtx(port)
  if (!config) return <p className={styles.empty}>Loading config...</p>
  const entries = buildEntries(config, path, ctx)

  const handleEntryClick = (entry: Entry) => {
    if (entry.kind === 'goto') setPath(entry.subPath)
    else if (entry.kind === 'action') entry.run()
    else if (entry.kind === 'bool') entry.save(!entry.value)
  }

  const breadcrumbs: ConfigPath[] = []
  let p: ConfigPath | null = path
  while (p) { breadcrumbs.unshift(p); p = parentPath(p) }

  return (
    <div className={styles.treeEditor}>
      <div className={styles.breadcrumb}>
        {breadcrumbs.map((bp, i) => (
          <React.Fragment key={i}>
            {i > 0 && <ChevronRight size={12} strokeWidth={1.5} className={styles.crumbSep} />}
            <button className={i === breadcrumbs.length - 1 ? styles.crumbActive : styles.crumbItem} onClick={() => i < breadcrumbs.length - 1 && setPath(bp)}>
              {bp.kind === 'permissionBucket' ? `permission/${bp.bucket}` : bp.kind}
            </button>
          </React.Fragment>
        ))}
      </div>
      <div className={styles.treeList}>
        {entries.map((e, i) => (
          <div key={i} className={styles.treeRow} onClick={() => handleEntryClick(e)}>
            <span className={styles.treeLabel}>{entryLabel(e)}</span>
            <div className={styles.treeActionsInline}>
              {e.kind === 'goto' && <ChevronRight size={14} strokeWidth={1.5} className={styles.treeArrow} />}
              {e.kind === 'bool' && <Toggle on={e.value} onClick={(ev: React.MouseEvent) => { ev.stopPropagation(); e.save(!e.value) }} />}
              {(e.kind === 'goto' || e.kind === 'action') && e.del && (
                <button className={styles.treeDelBtn} onClick={(ev) => { ev.stopPropagation(); e.del!() }}><Trash2 size={13} strokeWidth={1.5} /></button>
              )}
            </div>
          </div>
        ))}
        {entries.length === 0 && <p className={styles.empty}>No items</p>}
      </div>
    </div>
  )
}

// ── Permissions 标签页 ──
function PermissionsTab({ tools, port }: { tools: string[]; port: UiPort }) {
  React.useEffect(() => { port.post({ type: 'permissions_request' }) }, [port])
  return (
    <div className={styles.cardList}>
      {tools.length === 0 ? (
        <div className={styles.emptyCard}>
          <ShieldCheck size={32} strokeWidth={1} className={styles.emptyIcon} />
          <p className={styles.emptyTitle}>No Always-Allowed Tools</p>
          <p className={styles.emptyDesc}>When a tool requests permission, choose "Allow Always" to add it here.</p>
        </div>
      ) : (
        tools.map((t) => (
          <div key={t} className={styles.permCard}>
            <div className={styles.permInfo}><Wrench size={16} strokeWidth={1.5} className={styles.permIcon} /><code className={styles.permName}>{t}</code></div>
            <button className={styles.revokeBtn} onClick={() => port.post({ type: 'permission_revoke', tool: t })}>Revoke</button>
          </div>
        ))
      )}
    </div>
  )
}

// ── Tools 标签页 ──
function ToolsTab({ tools, port }: { tools: { name: string; description: string }[]; port: UiPort }) {
  React.useEffect(() => { port.post({ type: 'tools_request' }) }, [port])
  if (tools.length === 0) return <p className={styles.empty}>Loading tools...</p>
  return (
    <div className={styles.cardList}>
      {tools.map((t) => (
        <div key={t.name} className={styles.toolCard}>
          <code className={styles.toolCardName}>{t.name}</code>
          <span className={styles.toolCardDesc}>{t.description}</span>
        </div>
      ))}
    </div>
  )
}

// ── Context 标签页 ──
function ContextTab({ state, port }: { state: { estimatedTokens: number; windowTokens: number; percent: number } | null; port: UiPort }) {
  React.useEffect(() => { port.post({ type: 'context_request' }) }, [port])
  if (!state) return <p className={styles.empty}>Loading context...</p>
  const threshold = Math.round(state.windowTokens * 0.8)
  return (
    <div className={styles.contextPanel}>
      <div className={styles.contextStatRow}>
        <div className={styles.contextStat}><span className={styles.contextStatValue}>{state.estimatedTokens.toLocaleString()}</span><span className={styles.contextStatLabel}>Used</span></div>
        <div className={styles.contextStat}><span className={styles.contextStatValue}>{state.windowTokens.toLocaleString()}</span><span className={styles.contextStatLabel}>Window</span></div>
        <div className={styles.contextStat}><span className={styles.contextStatValue} data-overload={state.percent > 80}>{state.percent}%</span><span className={styles.contextStatLabel}>Usage</span></div>
      </div>
      <div className={styles.contextBarLarge}><div className={styles.contextFillLarge} style={{ width: `${Math.min(100, state.percent)}%` }} data-overload={state.percent > 80} /></div>
      <p className={styles.hint}>Auto-compaction triggers at 80% ({threshold.toLocaleString()} tokens)</p>
    </div>
  )
}

// ── System Prompt 标签页 ──
function SystemPromptTab({ state, port }: { state: { path: string; content: string } | null; port: UiPort }) {
  React.useEffect(() => { port.post({ type: 'system_request' }) }, [port])
  if (!state) return <p className={styles.empty}>Loading...</p>
  return (
    <div className={styles.codePanel}>
      <div className={styles.codePath}><Terminal size={14} strokeWidth={1.5} /><code>{state.path}</code></div>
      <pre className={styles.codeBlock}>{state.content}</pre>
    </div>
  )
}

// ── Logs 标签页 ──
function LogsTab({ state, port }: { state: { path: string; tail: string } | null; port: UiPort }) {
  React.useEffect(() => { port.post({ type: 'log_request' }) }, [port])
  if (!state) return <p className={styles.empty}>Loading...</p>
  return (
    <div className={styles.codePanel}>
      <div className={styles.codePath}><ScrollText size={14} strokeWidth={1.5} /><code>{state.path}</code></div>
      <pre className={styles.codeBlock}>{state.tail}</pre>
    </div>
  )
}
