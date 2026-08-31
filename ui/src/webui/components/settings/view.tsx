import { useState } from 'react'
import { Trash2, Check, X, Plus, Server, Cpu, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import type { Config, UiPort } from '@dogegg/bridge'
import { Card, SelectField, EditableField, Toggle, Badge, Button } from '../primitives'
import styles from './settings.module.css'

// 设置弹窗：卡片堆叠风格。
// 顶层分组用 primitives Card（带边框、可折叠）；卡片内部字段用 SelectField/EditableField 等表单元件。
// 不再有 tab 导航——全宽垂直滚动，每个 Card 是一个设置组。
interface SettingsProps {
  config: Config | null
  port: UiPort
  onClose: () => void
}

export function Settings({ config, port }: SettingsProps) {
  if (!config) return <div className={styles.loading}>Loading config...</div>
  return (
    <div className={styles.settings}>
      <div className={styles.scrollBody}>
        <Card title="General" desc="System prompt, shell, iterations" icon={SlidersHorizontal} defaultOpen>
          <GeneralContent config={config} port={port} />
        </Card>

        <Card title="Providers & Models" desc="API providers and model configuration" icon={Server} defaultOpen>
          <ProvidersContent config={config} port={port} />
        </Card>

        <Card title="Permissions" desc="Tool allow / reject / ask rules" icon={ShieldCheck} defaultOpen={false}>
          <PermissionsContent config={config} port={port} />
        </Card>
      </div>
    </div>
  )
}

// ── General 内容 ──
function GeneralContent({ config, port }: { config: Config; port: UiPort }) {
  const providers = config.providers.map((p) => ({ value: p.name, label: p.name || '(unnamed)' }))
  const currentProvider = config.providers.find((p) => p.name === config.defaultProvider)
  const modelOptions = (currentProvider?.models ?? []).map((m) => ({ value: m.name, label: m.name || '(unnamed)' }))
  return (
    <>
      <SelectField
        label="Default Provider"
        desc="Which API provider to use"
        value={config.defaultProvider ?? ''}
        options={providers.length ? providers : [{ value: '', label: '(none)' }]}
        onChange={(v) => port.post({ type: 'config_set', path: 'defaultProvider', value: v })}
      />
      <SelectField
        label="Default Model"
        desc="Which model to use for responses"
        value={config.defaultModel ?? ''}
        options={modelOptions.length ? modelOptions : [{ value: '', label: '(select provider first)' }]}
        onChange={(v) => port.post({ type: 'config_set', path: 'defaultModel', value: v })}
      />
      <div className={styles.divider} />
      <EditableField
        label="System Prompt"
        desc="Path to system prompt file (empty = built-in)"
        value={config.systemPrompt ?? ''}
        placeholder="(built-in)"
        onSave={(v) => port.post({ type: 'config_set', path: 'systemPrompt', value: v })}
        mono
      />
      <EditableField
        label="Shell Program"
        desc="Override shell (empty = auto by platform)"
        value={config.shellProgram ?? ''}
        placeholder="(auto)"
        onSave={(v) => port.post({ type: 'config_set', path: 'shellProgram', value: v })}
        mono
      />
      <div className={styles.fieldRow2}>
        <EditableField
          label="Max Iterations"
          value={String(config.maxIterations)}
          placeholder="10"
          onSave={(v) => port.post({ type: 'config_set', path: 'maxIterations', value: Number(v) || 0 })}
          mono
        />
        <EditableField
          label="Max Retries"
          value={String(config.maxRetries)}
          placeholder="3"
          onSave={(v) => port.post({ type: 'config_set', path: 'maxRetries', value: Number(v) || 0 })}
          mono
        />
      </div>
    </>
  )
}

// ── Providers 内容 ──
function ProvidersContent({ config, port }: { config: Config; port: UiPort }) {
  return (
    <div className={styles.providerList}>
      {config.providers.map((provider, pIdx) => (
        <div key={pIdx} className={styles.subCard}>
          <ProviderCard provider={provider} pIdx={pIdx} port={port} />
        </div>
      ))}
      <button
        className={styles.addBtn}
        onClick={() => port.post({ type: 'config_add', path: 'providers', value: { name: '', protocol: 'openai', baseURL: '', apiKey: '', models: [] } })}
      >
        <Plus size={14} strokeWidth={1.5} /><span>Add Provider</span>
      </button>
    </div>
  )
}

function ProviderCard({ provider, pIdx, port }: { provider: Config['providers'][number]; pIdx: number; port: UiPort }) {
  const base = `providers.${pIdx}`
  return (
    <Card title={provider.name || '(unnamed)'} desc={`${provider.models.length} model(s)`} icon={Server} defaultOpen>
      <EditableField label="Name" value={provider.name} placeholder="(empty)" onSave={(v) => port.post({ type: 'config_set', path: `${base}.name`, value: v })} mono />
      <EditableField label="Base URL" value={provider.baseURL} placeholder="https://api..." onSave={(v) => port.post({ type: 'config_set', path: `${base}.baseURL`, value: v })} mono />
      <EditableField label="API Key" value={provider.apiKey} placeholder="(empty)" onSave={(v) => port.post({ type: 'config_set', path: `${base}.apiKey`, value: v })} mono password />
      <div className={styles.divider} />
      {provider.models.map((model, mIdx) => (
        <ModelRow key={mIdx} model={model} pIdx={pIdx} mIdx={mIdx} port={port} />
      ))}
      <Button
        variant="secondary"
        size="sm"
        icon={Plus}
        onClick={() => port.post({ type: 'config_add', path: `${base}.models`, value: { name: '', contextWindow: 128000, maxOutput: 16384, reasoning: false } })}
      >
        Add Model
      </Button>
      <div className={styles.divider} />
      <button className={styles.deleteBtn} onClick={() => port.post({ type: 'config_remove', path: 'providers', index: pIdx })}>
        <Trash2 size={13} strokeWidth={1.5} /><span>Delete Provider</span>
      </button>
    </Card>
  )
}

// ModelRow — 两行布局，避免旧版 6 元素挤在一行。
// 上行：Cpu 图标 + 模型名（点击编辑）/ 编辑输入框 + 保存/取消；下行：上下文 + reasoning 徽标 + 开关。
function ModelRow({ model, pIdx, mIdx, port }: { model: Config['providers'][number]['models'][number]; pIdx: number; mIdx: number; port: UiPort }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(model.name)
  const mbase = `providers.${pIdx}.models.${mIdx}`
  const save = () => { port.post({ type: 'config_set', path: `${mbase}.name`, value: draft }); setEditing(false) }
  return (
    <div className={styles.modelRow}>
      <div className={styles.modelRowTop}>
        <Cpu size={12} strokeWidth={1.5} className={styles.modelIcon} />
        {editing ? (
          <>
            <input
              className={styles.modelInput}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
            />
            <Button variant="primary" size="sm" icon={Check} onClick={save} aria-label="Save model name" />
            <Button variant="secondary" size="sm" icon={X} onClick={() => setEditing(false)} aria-label="Cancel" />
          </>
        ) : (
          <>
            <span className={styles.modelNameText} onClick={() => { setDraft(model.name); setEditing(true) }}>{model.name || '(unnamed)'}</span>
            <button
              className={styles.iconDelete}
              onClick={() => port.post({ type: 'config_remove', path: 'models', index: mIdx, providerIndex: pIdx })}
              aria-label="Delete model"
            >
              <Trash2 size={11} strokeWidth={1.5} />
            </button>
          </>
        )}
      </div>
      <div className={styles.modelRowBottom}>
        <span className={styles.modelMeta}>{model.contextWindow.toLocaleString()} ctx</span>
        <Badge variant={model.reasoning ? 'accent' : 'neutral'}>reasoning</Badge>
        <Toggle on={model.reasoning} onChange={() => port.post({ type: 'config_set', path: `${mbase}.reasoning`, value: !model.reasoning })} />
      </div>
    </div>
  )
}

// ── Permissions 内容 ──
function PermissionsContent({ config, port }: { config: Config; port: UiPort }) {
  const buckets = ['allow', 'reject', 'ask'] as const
  return (
    <div className={styles.permList}>
      {buckets.map((bucket) => (
        <div key={bucket} className={styles.permBucket}>
          <div className={styles.permBucketHeader}>
            <span className={styles.permBucketName} data-bucket={bucket}>{bucket}</span>
            <span className={styles.permBucketCount}>{config.permission[bucket].length} tool(s)</span>
          </div>
          <div className={styles.permTools}>
            {config.permission[bucket].map((tool) => (
              <div key={tool} className={styles.permToolChip}>
                <code>{tool}</code>
                <button
                  className={styles.permToolRemove}
                  onClick={() => port.post({ type: 'config_set', path: `permission.${bucket}`, value: config.permission[bucket].filter((t) => t !== tool) })}
                  aria-label={`Remove ${tool}`}
                >
                  <X size={10} strokeWidth={2} />
                </button>
              </div>
            ))}
            {config.permission[bucket].length === 0 && <span className={styles.permEmpty}>No tools</span>}
          </div>
          <input
            className={styles.permAddInput}
            placeholder="Add tool name..."
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const v = (e.target as HTMLInputElement).value.trim()
                if (v && !config.permission[bucket].includes(v)) {
                  port.post({ type: 'config_set', path: `permission.${bucket}`, value: [...config.permission[bucket], v] })
                }
                ;(e.target as HTMLInputElement).value = ''
              }
            }}
          />
        </div>
      ))}
    </div>
  )
}
