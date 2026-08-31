import React, { useState } from 'react'
import { SlidersHorizontal, Cpu, ShieldCheck, ChevronRight, ChevronDown, Trash2, Check, X, Plus, Server } from 'lucide-react'
import type { Config, UiPort } from '@dogegg/bridge'
import type { SettingsTab } from '../../app/view-state'
import styles from './settings.module.css'

// 设置弹窗：只放 config 编辑项。
// General: 核心配置（provider/model 选择 + system prompt + shell + iterations/retries）
// Models: Provider/Model 列表管理（添加/删除/编辑）—— 只显示 providers 树，不混入 general
// Permissions: 权限桶（allow/reject/ask 工具列表）
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
  { tab: 'permissions', icon: ShieldCheck, label: 'Permissions', desc: 'Tool allow / reject / ask rules' },
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

// ── General 标签页 ──
function GeneralTab({ config, port }: { config: Config | null; port: UiPort }) {
  if (!config) return <p className={styles.empty}>Loading config...</p>
  const providers = config.providers.map(p => ({ value: p.name, label: p.name || '(unnamed)' }))
  const currentProvider = config.providers.find(p => p.name === config.defaultProvider)
  const modelOptions = (currentProvider?.models ?? []).map(m => ({ value: m.name, label: m.name || '(unnamed)' }))

  return (
    <div className={styles.formList}>
      <div className={styles.formField}>
        <label className={styles.formLabel}>Default Provider</label>
        <Select value={config.defaultProvider ?? ''} options={providers.length ? providers : [{ value: '', label: '(none — add in Models tab)' }]} onChange={(v) => port.post({ type: 'config_set', path: 'defaultProvider', value: v })} />
      </div>
      <div className={styles.formField}>
        <label className={styles.formLabel}>Default Model</label>
        <Select value={config.defaultModel ?? ''} options={modelOptions.length ? modelOptions : [{ value: '', label: '(select provider first)' }]} onChange={(v) => port.post({ type: 'config_set', path: 'defaultModel', value: v })} />
      </div>
      <div className={styles.sectionDivider} />
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

// ── Models 标签页：Provider/Model 列表管理 ──
// 直接操作 config.providers 数组，不使用 buildEntries 的 root 路径（避免混入 general 字段）。
function ModelsTab({ config, port }: { config: Config | null; port: UiPort }) {
  if (!config) return <p className={styles.empty}>Loading config...</p>

  const addProvider = () => port.post({ type: 'config_add', path: 'providers', value: { name: '', protocol: 'openai', baseURL: '', apiKey: '', models: [] } })

  return (
    <div className={styles.providerList}>
      {config.providers.map((provider, pIdx) => (
        <ProviderCard key={pIdx} provider={provider} pIdx={pIdx} port={port} />
      ))}
      <button className={styles.addCardBtn} onClick={addProvider}>
        <Plus size={14} strokeWidth={1.5} />
        <span>Add Provider</span>
      </button>
    </div>
  )
}

function ProviderCard({ provider, pIdx, port }: { provider: Config['providers'][number]; pIdx: number; port: UiPort }) {
  const [expanded, setExpanded] = useState(true)
  const [editingField, setEditingField] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const base = `providers.${pIdx}`

  const saveField = (field: string, value: string) => {
    port.post({ type: 'config_set', path: `${base}.${field}`, value })
    setEditingField(null)
  }

  const addModel = () => port.post({ type: 'config_add', path: `${base}.models`, value: { name: '', contextWindow: 128000, maxOutput: 16384, reasoning: false } })

  return (
    <div className={styles.providerCard}>
      {/* Provider header */}
      <div className={styles.providerHeader} onClick={() => setExpanded(!expanded)}>
        <button className={styles.chevronBtn}>{expanded ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronRight size={14} strokeWidth={2} />}</button>
        <Server size={15} strokeWidth={1.5} className={styles.providerIcon} />
        <span className={styles.providerName}>{provider.name || '(unnamed)'}</span>
        <span className={styles.providerUrl}>{provider.baseURL || '(no URL)'}</span>
        <button className={styles.delBtn} onClick={(e) => { e.stopPropagation(); port.post({ type: 'config_remove', path: 'providers', index: pIdx }) }}>
          <Trash2 size={13} strokeWidth={1.5} />
        </button>
      </div>

      {/* Provider fields */}
      {expanded && (
        <div className={styles.providerBody}>
          <div className={styles.formField}>
            <label className={styles.formLabel}>Name</label>
            {editingField === 'name' ? (
              <div className={styles.inputRow}>
                <input className={styles.inputMono} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') saveField('name', draft); if (e.key === 'Escape') setEditingField(null) }} />
                <button className={styles.inputSave} onClick={() => saveField('name', draft)}><Check size={14} /></button>
                <button className={styles.inputCancel} onClick={() => setEditingField(null)}><X size={14} /></button>
              </div>
            ) : (
              <button className={styles.editBtnMono} onClick={() => { setDraft(provider.name); setEditingField('name') }}>{provider.name || '(empty)'}</button>
            )}
          </div>
          <div className={styles.formField}>
            <label className={styles.formLabel}>Base URL</label>
            {editingField === 'baseURL' ? (
              <div className={styles.inputRow}>
                <input className={styles.inputMono} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') saveField('baseURL', draft); if (e.key === 'Escape') setEditingField(null) }} />
                <button className={styles.inputSave} onClick={() => saveField('baseURL', draft)}><Check size={14} /></button>
                <button className={styles.inputCancel} onClick={() => setEditingField(null)}><X size={14} /></button>
              </div>
            ) : (
              <button className={styles.editBtnMono} onClick={() => { setDraft(provider.baseURL); setEditingField('baseURL') }}>{provider.baseURL || '(empty)'}</button>
            )}
          </div>
          <div className={styles.formField}>
            <label className={styles.formLabel}>API Key</label>
            {editingField === 'apiKey' ? (
              <div className={styles.inputRow}>
                <input className={styles.inputMono} value={draft} type="password" onChange={(e) => setDraft(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') saveField('apiKey', draft); if (e.key === 'Escape') setEditingField(null) }} />
                <button className={styles.inputSave} onClick={() => saveField('apiKey', draft)}><Check size={14} /></button>
                <button className={styles.inputCancel} onClick={() => setEditingField(null)}><X size={14} /></button>
              </div>
            ) : (
              <button className={styles.editBtnMono} onClick={() => { setDraft(provider.apiKey); setEditingField('apiKey') }}>{provider.apiKey ? '••••••••' : '(empty)'}</button>
            )}
          </div>

          {/* Models list */}
          <div className={styles.modelSection}>
            <div className={styles.modelSectionHeader}>
              <label className={styles.formLabel}>Models ({provider.models.length})</label>
              <button className={styles.addModelBtn} onClick={addModel}><Plus size={12} strokeWidth={2} /><span>Add</span></button>
            </div>
            {provider.models.map((model, mIdx) => (
              <ModelRow key={mIdx} model={model} pIdx={pIdx} mIdx={mIdx} port={port} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ModelRow({ model, pIdx, mIdx, port }: { model: Config['providers'][number]['models'][number]; pIdx: number; mIdx: number; port: UiPort }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(model.name)
  const base = `providers.${pIdx}.models.${mIdx}`

  return (
    <div className={styles.modelRow}>
      {editing ? (
        <>
          <input className={styles.modelInput} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') { port.post({ type: 'config_set', path: `${base}.name`, value: draft }); setEditing(false) } if (e.key === 'Escape') setEditing(false) }} />
          <button className={styles.inputSave} onClick={() => { port.post({ type: 'config_set', path: `${base}.name`, value: draft }); setEditing(false) }}><Check size={12} /></button>
          <button className={styles.inputCancel} onClick={() => setEditing(false)}><X size={12} /></button>
        </>
      ) : (
        <>
          <Cpu size={13} strokeWidth={1.5} className={styles.modelIcon} />
          <span className={styles.modelNameText} onClick={() => { setDraft(model.name); setEditing(true) }}>{model.name || '(unnamed)'}</span>
          <span className={styles.modelMeta}>{model.contextWindow.toLocaleString()} ctx</span>
          {model.reasoning && <span className={styles.reasoningBadge}>reasoning</span>}
          <Toggle on={model.reasoning} onClick={(e) => { e.stopPropagation(); port.post({ type: 'config_set', path: `${base}.reasoning`, value: !model.reasoning }) }} />
          <button className={styles.delBtn} onClick={(e) => { e.stopPropagation(); port.post({ type: 'config_remove', path: 'models', index: mIdx, providerIndex: pIdx }) }}><Trash2 size={12} strokeWidth={1.5} /></button>
        </>
      )}
    </div>
  )
}

// ── Permissions 标签页：权限桶 ──
function PermissionsTab({ config, port }: { config: Config | null; port: UiPort }) {
  if (!config) return <p className={styles.empty}>Loading config...</p>
  const [editingBucket, setEditingBucket] = useState<string | null>(null)

  if (editingBucket) {
    const bucket = editingBucket as 'allow' | 'reject' | 'ask'
    const tools = config.permission[bucket]
    return (
      <div className={styles.permBucketEditor}>
        <div className={styles.breadcrumb}>
          <button className={styles.crumbItem} onClick={() => setEditingBucket(null)}>Permissions</button>
          <ChevronRight size={12} strokeWidth={1.5} className={styles.crumbSep} />
          <span className={styles.crumbActive}>{bucket}</span>
        </div>
        <div className={styles.treeList}>
          {tools.map((tool) => (
            <div key={tool} className={styles.treeRow}>
              <span className={styles.treeLabel}>{tool}</span>
              <button className={styles.delBtn} onClick={() => port.post({ type: 'config_set', path: `permission.${bucket}`, value: tools.filter(t => t !== tool) })}><Trash2 size={13} strokeWidth={1.5} /></button>
            </div>
          ))}
          {tools.length === 0 && <p className={styles.empty}>No tools in this bucket</p>}
        </div>
        <div className={styles.inputRow}>
          <input className={styles.inputMono} placeholder="Add tool name..." onKeyDown={(e) => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.trim(); if (v && !tools.includes(v)) port.post({ type: 'config_set', path: `permission.${bucket}`, value: [...tools, v] }); (e.target as HTMLInputElement).value = '' } }} />
        </div>
      </div>
    )
  }

  return (
    <div className={styles.permOverview}>
      <p className={styles.permDesc}>Configure which tools are automatically allowed, rejected, or require asking.</p>
      {(['allow', 'reject', 'ask'] as const).map(bucket => (
        <div key={bucket} className={styles.permBucketCard} onClick={() => setEditingBucket(bucket)}>
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
