import React, { useState } from 'react'
import { SlidersHorizontal, Cpu, ShieldCheck, Wrench, Gauge, Terminal, ScrollText, ArrowLeft, ChevronRight, Plus, Trash2, Check } from 'lucide-react'
import type { Config, UiPort } from '@dogegg/bridge'
import { buildEntries, parentPath, entryLabel, type ConfigPath, type Entry, type TreeCtx } from '../../../shared/config'
import type { SettingsTab } from '../../app/view-state'
import styles from './settings.module.css'

// 设置面板：面板头（标题 + 返回按钮）+ 二级导航（7 个标签页）+ 内容区。
// 每个标签页有独立的 header（标题 + 描述），内容区根据消息响应渲染。
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
      {/* 面板头：返回按钮 + 标题 */}
      <header className={styles.panelHeader}>
        <button className={styles.backBtn} onClick={props.onBack} aria-label="Back to chat">
          <ArrowLeft size={18} strokeWidth={1.5} />
        </button>
        <div className={styles.panelTitle}>
          <span className={styles.panelTitleText}>Settings</span>
          {activeTab && <span className={styles.panelSubtitle}>{activeTab.desc}</span>}
        </div>
      </header>

      <div className={styles.settingsBody}>
        {/* 二级导航 */}
        <nav className={styles.tabNav}>
          {TABS.map(({ tab, icon: Icon, label }) => (
            <button
              key={tab}
              className={`${styles.tabBtn} ${props.tab === tab ? styles.tabActive : ''} sidebar-item`}
              onClick={() => props.onTabChange(tab)}
            >
              <Icon size={16} strokeWidth={1.5} />
              <span>{label}</span>
              {props.tab === tab && <ChevronRight size={14} strokeWidth={1.5} className={styles.tabChevron} />}
            </button>
          ))}
        </nav>

        {/* 内容区 */}
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

// ── General 标签页：表单式编辑 ──
function GeneralTab({ config, port }: { config: Config | null; port: UiPort }) {
  const [editing, setEditing] = useState<string | null>(null)
  const [value, setValue] = useState('')
  if (!config) return <p className={styles.empty}>Loading config...</p>

  const fields = [
    { key: 'systemPrompt', label: 'System Prompt', value: config.systemPrompt ?? '', placeholder: 'Path to system prompt file', isPath: true },
    { key: 'maxIterations', label: 'Max Iterations', value: String(config.maxIterations), placeholder: '10', isNum: true },
    { key: 'maxRetries', label: 'Max Retries', value: String(config.maxRetries), placeholder: '3', isNum: true },
    { key: 'shellProgram', label: 'Shell Program', value: config.shellProgram ?? '', placeholder: 'Auto (platform default)', isPath: false },
  ]

  const save = (key: string) => {
    const isNum = fields.find(f => f.key === key)?.isNum
    port.post({ type: 'config_set', path: key, value: isNum ? Number(value) || 0 : value })
    setEditing(null)
  }

  return (
    <div className={styles.formList}>
      {fields.map((f) => (
        <div key={f.key} className={styles.formField}>
          <label className={styles.formLabel}>{f.label}</label>
          {editing === f.key ? (
            <div className={styles.formEditRow}>
              <input
                className={styles.formInput}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={f.placeholder}
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') save(f.key); if (e.key === 'Escape') setEditing(null) }}
              />
              <button className={styles.iconBtnSave} onClick={() => save(f.key)} aria-label="Save">
                <Check size={16} strokeWidth={2} />
              </button>
              <button className={styles.iconBtnCancel} onClick={() => setEditing(null)} aria-label="Cancel">
                <span style={{ fontSize: 16 }}>×</span>
              </button>
            </div>
          ) : (
            <button className={styles.formValue} onClick={() => { setEditing(f.key); setValue(f.value) }}>
              {f.value || f.placeholder}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Models 标签页：可点击树形编辑器（不再需要键盘上下导航）──
function ModelsTab({ config, port }: { config: Config | null; port: UiPort }) {
  const [path, setPath] = useState<ConfigPath>({ kind: 'root' })
  const ctx = useTreeCtx(port)
  if (!config) return <p className={styles.empty}>Loading config...</p>

  const entries = buildEntries(config, path, ctx)

  const handleEntryClick = (entry: Entry) => {
    if (entry.kind === 'goto') { setPath(entry.subPath) }
    else if (entry.kind === 'action') { entry.run() }
    else if (entry.kind === 'bool') { entry.save(!entry.value) }
  }

  // 面包屑路径
  const breadcrumbs: ConfigPath[] = []
  let p: ConfigPath | null = path
  while (p) { breadcrumbs.unshift(p); p = parentPath(p) }

  return (
    <div className={styles.treeEditor}>
      {/* 面包屑导航 */}
      <div className={styles.breadcrumb}>
        {breadcrumbs.map((bp, i) => (
          <React.Fragment key={i}>
            {i > 0 && <ChevronRight size={12} strokeWidth={1.5} className={styles.crumbSep} />}
            <button
              className={i === breadcrumbs.length - 1 ? styles.crumbActive : styles.crumbItem}
              onClick={() => i < breadcrumbs.length - 1 && setPath(bp)}
            >
              {bp.kind === 'permissionBucket' ? `permission/${bp.bucket}` : bp.kind}
            </button>
          </React.Fragment>
        ))}
      </div>

      {/* 树列表 */}
      <div className={styles.treeList}>
        {entries.map((e, i) => (
          <div key={i} className={`${styles.treeRow} sidebar-item`} onClick={() => handleEntryClick(e)}>
            <span className={styles.treeLabel}>{entryLabel(e)}</span>
            <div className={styles.treeActionsInline}>
              {e.kind === 'goto' && <ChevronRight size={14} strokeWidth={1.5} className={styles.treeArrow} />}
              {e.kind === 'bool' && (
                <span className={styles.boolBadge} data-on={e.value}>{e.value ? 'ON' : 'OFF'}</span>
              )}
              {(e.kind === 'goto' || e.kind === 'action') && e.del && (
                <button className={styles.treeDelBtn} onClick={(ev) => { ev.stopPropagation(); e.del!() }} aria-label="Delete">
                  <Trash2 size={13} strokeWidth={1.5} />
                </button>
              )}
            </div>
          </div>
        ))}
        {entries.length === 0 && <p className={styles.empty}>No items here</p>}
      </div>

      {/* 添加按钮（如果当前层级有 prompt/action 类型的"添加"项） */}
      {entries.some(e => e.kind === 'prompt' || (e.kind === 'action' && e.label.startsWith('＋'))) && (
        <div className={styles.treeAddHint}>
          Click an item above with ＋ to add a new entry.
        </div>
      )}
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
          <p className={styles.emptyDesc}>When a tool requests permission, choose "Allow Always" to add it here. You can revoke at any time.</p>
        </div>
      ) : (
        tools.map((t) => (
          <div key={t} className={styles.permCard}>
            <div className={styles.permInfo}>
              <Wrench size={16} strokeWidth={1.5} className={styles.permIcon} />
              <code className={styles.permName}>{t}</code>
            </div>
            <button className={styles.revokeBtn} onClick={() => port.post({ type: 'permission_revoke', tool: t })}>
              Revoke
            </button>
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
        <div className={styles.contextStat}>
          <span className={styles.contextStatValue}>{state.estimatedTokens.toLocaleString()}</span>
          <span className={styles.contextStatLabel}>Used</span>
        </div>
        <div className={styles.contextStat}>
          <span className={styles.contextStatValue}>{state.windowTokens.toLocaleString()}</span>
          <span className={styles.contextStatLabel}>Window</span>
        </div>
        <div className={styles.contextStat}>
          <span className={styles.contextStatValue} data-overload={state.percent > 80}>{state.percent}%</span>
          <span className={styles.contextStatLabel}>Usage</span>
        </div>
      </div>
      <div className={styles.contextBarLarge}>
        <div className={styles.contextFillLarge} style={{ width: `${Math.min(100, state.percent)}%` }} data-overload={state.percent > 80} />
      </div>
      <p className={styles.hint}>Auto-compaction triggers at 80% ({threshold.toLocaleString()} tokens)</p>
    </div>
  )
}

// ── System Prompt 标签页 ──
function SystemPromptTab({ state, port }: { state: { path: string; content: string } | null; port: UiPort }) {
  React.useEffect(() => { port.post({ type: 'system_request' }) }, [port])
  if (!state) return <p className={styles.empty}>Loading system prompt...</p>
  return (
    <div className={styles.codePanel}>
      <div className={styles.codePath}>
        <Terminal size={14} strokeWidth={1.5} />
        <code>{state.path}</code>
      </div>
      <pre className={styles.codeBlock}>{state.content}</pre>
    </div>
  )
}

// ── Logs 标签页 ──
function LogsTab({ state, port }: { state: { path: string; tail: string } | null; port: UiPort }) {
  React.useEffect(() => { port.post({ type: 'log_request' }) }, [port])
  if (!state) return <p className={styles.empty}>Loading logs...</p>
  return (
    <div className={styles.codePanel}>
      <div className={styles.codePath}>
        <ScrollText size={14} strokeWidth={1.5} />
        <code>{state.path}</code>
      </div>
      <pre className={styles.codeBlock}>{state.tail}</pre>
    </div>
  )
}
