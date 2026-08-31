import React, { useState } from 'react'
import { SlidersHorizontal, Cpu, ShieldCheck, ChevronRight, Trash2, Check, X, Plus } from 'lucide-react'
import type { Config, UiPort } from '@dogegg/bridge'
import { buildEntries, parentPath, entryLabel, type ConfigPath, type Entry, type TreeCtx } from '../../../shared/config'
import type { SettingsTab } from '../../app/view-state'
import styles from './settings.module.css'

// 设置弹窗：只放 config 编辑项。信息呈现（Tools/Context/System/Logs/Permissions）
// 移到右侧信息面板，不再作为设置标签页。
// 标签页精简为：General（核心配置）、Models（provider/model 树）、Permissions（权限桶）。
interface SettingsProps {
  tab: SettingsTab
  config: Config | null
  port: UiPort
  onTabChange: (tab: SettingsTab) => void
  onBack: () => void
}

const TABS: { tab: SettingsTab; icon: typeof SlidersHorizontal; label: string; desc: string }[] = [
  { tab: 'general', icon: SlidersHorizontal, label: 'General', desc: 'System prompt, shell, iterations' },
  { tab: 'models', icon: Cpu, label: 'Models', desc: 'Providers and model configuration' },
  { tab: 'permissions', icon: ShieldCheck, label: 'Permissions', desc: 'Tool allow/reject/ask rules' },
]

export function Settings(props: SettingsProps) {
  const activeTab = TABS.find(t => t.tab === props.tab)
  return (
    <div className={styles.settings}>
      <nav className={styles.tabNav}>
        {TABS.map(({ tab, icon: Icon, label }) => (
          <button key={tab} className={`${styles.tabBtn} ${props.tab === tab ? styles.tabActive : ''}`} onClick={() => props.onTabChange(tab)}>
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
          {props.tab === 'permissions' && <PermissionsTab config={props.config} port={props.port} />}
        </div>
      </div>
    </div>
  )
}

// ── 通用 UI 组件 ──

function Toggle({ on, onClick }: { on: boolean; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button className={`${styles.toggle} ${on ? styles.toggleOn : ''}`} onClick={onClick} role="switch" aria-checked={on}>
      <span className={styles.toggleKnob} />
    </button>
  )
}

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

function useTreeCtx(port: UiPort): TreeCtx {
  return {
    set: (path, value) => port.post({ type: 'config_set', path, value }),
    add: (path, value) => port.post({ type: 'config_add', path, value }),
    remove: (path, index, providerIndex) => port.post({ type: 'config_remove', path, index, providerIndex }),
  }
}

// ── General 标签页 ──
function GeneralTab({ config, port }: { config: Config | null; port: UiPort }) {
  if (!config) return <p className={styles.empty}>Loading config...</p>
  const providers = config.providers.map(p => ({ value: p.name, label: p.name || '(unnamed)' }))
  const currentProviderModels = config.providers.find(p => p.name === config.defaultProvider)?.models ?? []
  const modelOptions = currentProviderModels.map(m => ({ value: m.name, label: m.name || '(unnamed)' }))

  return (
    <div className={styles.formList}>
      <div className={styles.formField}>
        <label className={styles.formLabel}>Default Provider</label>
        <Select value={config.defaultProvider ?? ''} options={providers.length ? providers : [{ value: '', label: '(none)' }]} onChange={(v) => port.post({ type: 'config_set', path: 'defaultProvider', value: v })} />
      </div>
      <div className={styles.formField}>
        <label className={styles.formLabel}>Default Model</label>
        <Select value={config.defaultModel ?? ''} options={modelOptions.length ? modelOptions : [{ value: '', label: '(select provider first)' }]} onChange={(v) => port.post({ type: 'config_set', path: 'defaultModel', value: v })} />
      </div>
      <div className={styles.formField}>
        <label className={styles.formLabel}>System Prompt Path</label>
        <EditableInput value={config.systemPrompt ?? ''} placeholder='(built-in default)' onSave={(v) => port.post({ type: 'config_set', path: 'systemPrompt', value: v })} mono />
      </div>
      <div className={styles.formField}>
        <label className={styles.formLabel}>Shell Program</label>
        <EditableInput value={config.shellProgram ?? ''} placeholder='(auto — platform default)' onSave={(v) => port.post({ type: 'config_set', path: 'shellProgram', value: v })} mono />
      </div>
      <div className={styles.formRow}>
        <div className={styles.formField}>
          <label className={styles.formLabel}>Max Iterations</label>
          <EditableInput value={String(config.maxIterations)} placeholder='10' onSave={(v) => port.post({ type: 'config_set', path: 'maxIterations', value: Number(v) || 0 })} mono />
        </div>
        <div className={styles.formField}>
          <label className={styles.formLabel}>Max Retries</label>
          <EditableInput value={String(config.maxRetries)} placeholder='3' onSave={(v) => port.post({ type: 'config_set', path: 'maxRetries', value: Number(v) || 0 })} mono />
        </div>
      </div>
    </div>
  )
}

// ── Models 标签页：树形编辑器 ──
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

// ── Permissions 标签页：config 级权限桶编辑 ──
function PermissionsTab({ config, port }: { config: Config | null; port: UiPort }) {
  const [path, setPath] = useState<ConfigPath>({ kind: 'root' })
  const ctx = useTreeCtx(port)
  if (!config) return <p className={styles.empty}>Loading config...</p>
  // 导航到 permission 根
  if (path.kind === 'root') {
    return (
      <div className={styles.permOverview}>
        <p className={styles.permDesc}>Configure which tools are automatically allowed, rejected, or require asking.</p>
        {(['allow', 'reject', 'ask'] as const).map(bucket => (
          <div key={bucket} className={styles.permBucketCard} onClick={() => setPath({ kind: 'permissionBucket', bucket })}>
            <div className={styles.permBucketInfo}>
              <span className={styles.permBucketName} data-bucket={bucket}>{bucket}</span>
              <span className={styles.permBucketCount}>{config.permission[bucket].length} tool(s)</span>
            </div>
            <ChevronRight size={14} strokeWidth={1.5} className={styles.treeArrow} />
          </div>
        ))}
      </div>
    )
  }
  // 在 permissionBucket 内：编辑工具列表
  const entries = buildEntries(config, path, ctx)
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
          <div key={i} className={styles.treeRow} onClick={() => { if (e.kind === 'action') e.run() }}>
            <span className={styles.treeLabel}>{entryLabel(e)}</span>
            <div className={styles.treeActionsInline}>
              {e.kind === 'action' && e.del && (
                <button className={styles.treeDelBtn} onClick={(ev) => { ev.stopPropagation(); e.del!() }}><Trash2 size={13} strokeWidth={1.5} /></button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
