import React, { useState } from 'react'
import { ChevronDown, ChevronRight, Trash2, Check, X, Plus, Server, Cpu, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import type { Config, UiPort } from '@dogegg/bridge'
import type { SettingsTab } from '../../app/view-state'
import styles from './settings.module.css'

// 设置弹窗：ChatGPT 卡片堆叠风格。
// 不用左侧 tab 导航——改为全宽垂直滚动的独立卡片，每个卡片是一个设置组。
// 卡片内部可折叠展开。留白多、视觉清爽。
interface SettingsProps {
  tab: SettingsTab
  config: Config | null
  port: UiPort
  onTabChange: (tab: SettingsTab) => void
  onBack: () => void
}

export function Settings(props: SettingsProps) {
  if (!props.config) return <div className={styles.loading}>Loading config...</div>
  return (
    <div className={styles.settings}>
      <div className={styles.scrollBody}>
        {/* General 配置卡片 */}
        <SettingsCard title="General" desc="System prompt, shell, iterations" icon={SlidersHorizontal} defaultOpen>
          <GeneralContent config={props.config} port={props.port} />
        </SettingsCard>

        {/* Provider/Model 卡片 */}
        <SettingsCard title="Providers & Models" desc="API providers and model configuration" icon={Server} defaultOpen>
          <ProvidersContent config={props.config} port={props.port} />
        </SettingsCard>

        {/* Permissions 卡片 */}
        <SettingsCard title="Permissions" desc="Tool allow / reject / ask rules" icon={ShieldCheck} defaultOpen={false}>
          <PermissionsContent config={props.config} port={props.port} />
        </SettingsCard>
      </div>
    </div>
  )
}

// ── 卡片容器（可折叠）──
function SettingsCard({ title, desc, icon: Icon, defaultOpen, children }: {
  title: string; desc: string; icon: typeof Server; defaultOpen: boolean; children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={styles.card}>
      <button className={styles.cardHeader} onClick={() => setOpen(!open)}>
        <Icon size={16} strokeWidth={1.5} className={styles.cardIcon} />
        <div className={styles.cardTitleArea}>
          <span className={styles.cardTitle}>{title}</span>
          <span className={styles.cardDesc}>{desc}</span>
        </div>
        {open ? <ChevronDown size={16} strokeWidth={1.5} /> : <ChevronRight size={16} strokeWidth={1.5} />}
      </button>
      {open && <div className={styles.cardBody}>{children}</div>}
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

function SelectField({ label, desc, value, options, onChange }: {
  label: string; desc?: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void
}) {
  return (
    <div className={styles.fieldRow}>
      <div className={styles.fieldInfo}>
        <label className={styles.fieldLabel}>{label}</label>
        {desc && <span className={styles.fieldDesc}>{desc}</span>}
      </div>
      <div className={styles.selectWrap}>
        <select className={styles.select} value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <ChevronDown size={12} strokeWidth={2} className={styles.selectArrow} />
      </div>
    </div>
  )
}

function EditableField({ label, desc, value, placeholder, onSave, mono, password }: {
  label: string; desc?: string; value: string; placeholder: string; onSave: (v: string) => void; mono?: boolean; password?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const display = password && value ? '••••••••' : (value || placeholder)
  return (
    <div className={styles.fieldRow}>
      <div className={styles.fieldInfo}>
        <label className={styles.fieldLabel}>{label}</label>
        {desc && <span className={styles.fieldDesc}>{desc}</span>}
      </div>
      {editing ? (
        <div className={styles.inputGroup}>
          <input className={`${styles.input} ${mono ? styles.inputMono : ''}`} type={password ? 'password' : 'text'} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={placeholder} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') { onSave(draft); setEditing(false) } if (e.key === 'Escape') setEditing(false) }} />
          <button className={styles.iconSave} onClick={() => { onSave(draft); setEditing(false) }}><Check size={14} strokeWidth={2} /></button>
          <button className={styles.iconCancel} onClick={() => setEditing(false)}><X size={14} strokeWidth={2} /></button>
        </div>
      ) : (
        <button className={`${styles.valueBtn} ${mono ? styles.valueMono : ''}`} onClick={() => { setDraft(value); setEditing(true) }}>{display}</button>
      )}
    </div>
  )
}

// ── General 内容 ──
function GeneralContent({ config, port }: { config: Config; port: UiPort }) {
  const providers = config.providers.map(p => ({ value: p.name, label: p.name || '(unnamed)' }))
  const currentProvider = config.providers.find(p => p.name === config.defaultProvider)
  const modelOptions = (currentProvider?.models ?? []).map(m => ({ value: m.name, label: m.name || '(unnamed)' }))
  return (
    <div className={styles.fieldList}>
      <SelectField label="Default Provider" desc="Which API provider to use" value={config.defaultProvider ?? ''} options={providers.length ? providers : [{ value: '', label: '(none)' }]} onChange={(v) => port.post({ type: 'config_set', path: 'defaultProvider', value: v })} />
      <SelectField label="Default Model" desc="Which model to use for responses" value={config.defaultModel ?? ''} options={modelOptions.length ? modelOptions : [{ value: '', label: '(select provider first)' }]} onChange={(v) => port.post({ type: 'config_set', path: 'defaultModel', value: v })} />
      <div className={styles.divider} />
      <EditableField label="System Prompt" desc="Path to system prompt file (empty = built-in)" value={config.systemPrompt ?? ''} placeholder='(built-in)' onSave={(v) => port.post({ type: 'config_set', path: 'systemPrompt', value: v })} mono />
      <EditableField label="Shell Program" desc="Override shell (empty = auto by platform)" value={config.shellProgram ?? ''} placeholder='(auto)' onSave={(v) => port.post({ type: 'config_set', path: 'shellProgram', value: v })} mono />
      <div className={styles.fieldRow2}>
        <EditableField label="Max Iterations" value={String(config.maxIterations)} placeholder='10' onSave={(v) => port.post({ type: 'config_set', path: 'maxIterations', value: Number(v) || 0 })} mono />
        <EditableField label="Max Retries" value={String(config.maxRetries)} placeholder='3' onSave={(v) => port.post({ type: 'config_set', path: 'maxRetries', value: Number(v) || 0 })} mono />
      </div>
    </div>
  )
}

// ── Providers 内容 ──
function ProvidersContent({ config, port }: { config: Config; port: UiPort }) {
  return (
    <div className={styles.providerList}>
      {config.providers.map((provider, pIdx) => (
        <ProviderCard key={pIdx} provider={provider} pIdx={pIdx} port={port} />
      ))}
      <button className={styles.addBtn} onClick={() => port.post({ type: 'config_add', path: 'providers', value: { name: '', protocol: 'openai', baseURL: '', apiKey: '', models: [] } })}>
        <Plus size={14} strokeWidth={1.5} /><span>Add Provider</span>
      </button>
    </div>
  )
}

function ProviderCard({ provider, pIdx, port }: { provider: Config['providers'][number]; pIdx: number; port: UiPort }) {
  const [expanded, setExpanded] = useState(true)
  const base = `providers.${pIdx}`
  return (
    <div className={styles.subCard}>
      <div className={styles.subCardHeader} onClick={() => setExpanded(!expanded)}>
        <Server size={14} strokeWidth={1.5} className={styles.subCardIcon} />
        <span className={styles.subCardTitle}>{provider.name || '(unnamed)'}</span>
        <span className={styles.subCardMeta}>{provider.models.length} model(s)</span>
        {expanded ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronRight size={14} strokeWidth={2} />}
      </div>
      {expanded && (
        <div className={styles.subCardBody}>
          <EditableField label="Name" value={provider.name} placeholder='(empty)' onSave={(v) => port.post({ type: 'config_set', path: `${base}.name`, value: v })} mono />
          <EditableField label="Base URL" value={provider.baseURL} placeholder='https://api...' onSave={(v) => port.post({ type: 'config_set', path: `${base}.baseURL`, value: v })} mono />
          <EditableField label="API Key" value={provider.apiKey} placeholder='(empty)' onSave={(v) => port.post({ type: 'config_set', path: `${base}.apiKey`, value: v })} mono password />
          <div className={styles.modelSection}>
            <div className={styles.modelSectionHeader}>
              <span className={styles.fieldLabel}>Models</span>
              <button className={styles.addSmallBtn} onClick={() => port.post({ type: 'config_add', path: `${base}.models`, value: { name: '', contextWindow: 128000, maxOutput: 16384, reasoning: false } })}>
                <Plus size={11} strokeWidth={2} /><span>Add</span>
              </button>
            </div>
            {provider.models.map((model, mIdx) => (
              <ModelRow key={mIdx} model={model} pIdx={pIdx} mIdx={mIdx} port={port} />
            ))}
          </div>
          <button className={styles.deleteBtn} onClick={() => port.post({ type: 'config_remove', path: 'providers', index: pIdx })}>
            <Trash2 size={13} strokeWidth={1.5} /><span>Delete Provider</span>
          </button>
        </div>
      )}
    </div>
  )
}

function ModelRow({ model, pIdx, mIdx, port }: { model: Config['providers'][number]['models'][number]; pIdx: number; mIdx: number; port: UiPort }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(model.name)
  const mbase = `providers.${pIdx}.models.${mIdx}`
  return (
    <div className={styles.modelRow}>
      {editing ? (
        <>
          <input className={styles.modelInput} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') { port.post({ type: 'config_set', path: `${mbase}.name`, value: draft }); setEditing(false) } if (e.key === 'Escape') setEditing(false) }} />
          <button className={styles.iconSave} onClick={() => { port.post({ type: 'config_set', path: `${mbase}.name`, value: draft }); setEditing(false) }}><Check size={12} /></button>
          <button className={styles.iconCancel} onClick={() => setEditing(false)}><X size={12} /></button>
        </>
      ) : (
        <>
          <Cpu size={12} strokeWidth={1.5} className={styles.modelIcon} />
          <span className={styles.modelNameText} onClick={() => { setDraft(model.name); setEditing(true) }}>{model.name || '(unnamed)'}</span>
          <span className={styles.modelMeta}>{model.contextWindow.toLocaleString()} ctx</span>
          {model.reasoning && <span className={styles.badge}>reasoning</span>}
          <Toggle on={model.reasoning} onClick={(e) => { e.stopPropagation(); port.post({ type: 'config_set', path: `${mbase}.reasoning`, value: !model.reasoning }) }} />
          <button className={styles.iconDelete} onClick={() => port.post({ type: 'config_remove', path: 'models', index: mIdx, providerIndex: pIdx })}><Trash2 size={11} strokeWidth={1.5} /></button>
        </>
      )}
    </div>
  )
}

// ── Permissions 内容 ──
function PermissionsContent({ config, port }: { config: Config; port: UiPort }) {
  return (
    <div className={styles.permList}>
      {(['allow', 'reject', 'ask'] as const).map(bucket => (
        <div key={bucket} className={styles.permBucket}>
          <div className={styles.permBucketHeader}>
            <span className={styles.permBucketName} data-bucket={bucket}>{bucket}</span>
            <span className={styles.permBucketCount}>{config.permission[bucket].length} tool(s)</span>
          </div>
          <div className={styles.permTools}>
            {config.permission[bucket].map(tool => (
              <div key={tool} className={styles.permToolChip}>
                <code>{tool}</code>
                <button className={styles.permToolRemove} onClick={() => port.post({ type: 'config_set', path: `permission.${bucket}`, value: config.permission[bucket].filter(t => t !== tool) })}><X size={10} strokeWidth={2} /></button>
              </div>
            ))}
            {config.permission[bucket].length === 0 && <span className={styles.permEmpty}>No tools</span>}
          </div>
          <input className={styles.permAddInput} placeholder="Add tool name..." onKeyDown={(e) => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.trim(); if (v && !config.permission[bucket].includes(v)) port.post({ type: 'config_set', path: `permission.${bucket}`, value: [...config.permission[bucket], v] }); (e.target as HTMLInputElement).value = '' } }} />
        </div>
      ))}
    </div>
  )
}
