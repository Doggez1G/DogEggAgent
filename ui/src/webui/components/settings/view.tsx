import { useState, useEffect, useRef } from 'react'
import { Trash2, Plus, Server, Cpu, ShieldCheck, SlidersHorizontal, ChevronDown, X, FileText } from 'lucide-react'
import type { Config, UiPort } from '@dogegg/bridge'
import { Toggle, Button } from '../primitives'
import styles from './settings.module.css'

// 设置弹窗：左侧导航 + 右侧内容区（IDE 风格分栏）。
// 三个 section：General / Models / Permissions。
// General: system prompt 用文件选择器，shell 用检测到的 shell 下拉框。
// Models: 每个 model 有完整编辑器（name/contextWindow/maxOutput/reasoning + 删除）。
// Permissions: 从可用工具列表选择添加，不手动输入。
type Section = 'general' | 'models' | 'permissions'

interface SettingsProps {
  config: Config | null
  port: UiPort
  onClose: () => void
}

export function Settings({ config, port }: SettingsProps) {
  const [section, setSection] = useState<Section>('general')
  if (!config) return <div className={styles.loading}>Loading config...</div>

  return (
    <div className={styles.settings}>
      <nav className={styles.nav}>
        <NavBtn icon={SlidersHorizontal} label="General" active={section === 'general'} onClick={() => setSection('general')} />
        <NavBtn icon={Cpu} label="Models" active={section === 'models'} onClick={() => setSection('models')} />
        <NavBtn icon={ShieldCheck} label="Permissions" active={section === 'permissions'} onClick={() => setSection('permissions')} />
      </nav>
      <div className={styles.content}>
        {section === 'general' && <GeneralSection config={config} port={port} />}
        {section === 'models' && <ModelsSection config={config} port={port} />}
        {section === 'permissions' && <PermissionsSection config={config} port={port} />}
      </div>
    </div>
  )
}

function NavBtn({ icon: Icon, label, active, onClick }: { icon: typeof SlidersHorizontal; label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={`${styles.navItem} ${active ? styles.navActive : ''}`} onClick={onClick}>
      <Icon size={16} strokeWidth={1.5} />
      <span>{label}</span>
    </button>
  )
}

// ── General ──
function GeneralSection({ config, port }: { config: Config; port: UiPort }) {
  const providers = config.providers.map((p) => ({ value: p.name, label: p.name || '(unnamed)' }))
  const currentProvider = config.providers.find((p) => p.name === config.defaultProvider)
  const modelOptions = (currentProvider?.models ?? []).map((m) => ({ value: m.name, label: m.name || '(unnamed)' }))

  // Shell 检测——从 /api/shells 获取可用 shell 列表。
  const [shells, setShells] = useState<{ value: string; label: string }[]>([])
  useEffect(() => {
    fetch('/api/shells').then((r) => r.json()).then(setShells).catch(() => setShells([]))
  }, [])

  // System prompt 文件选择器——使用原生文件对话框。
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) { e.target.value = ''; return }
    // 浏览器安全限制：无法直接获取完整路径。
    // 尝试 file.path（Electron 环境），否则通过后端 API 解析。
    const filePath = (file as unknown as { path?: string }).path
    if (filePath) {
      port.post({ type: 'config_set', path: 'systemPrompt', value: filePath })
    } else {
      // 通过后端在常见位置搜索同名文件。
      try {
        const resp = await fetch('/api/resolve-path', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: file.name, isFile: true }),
        })
        const data = await resp.json()
        const paths: string[] = data.paths ?? []
        if (paths.length >= 1) {
          port.post({ type: 'config_set', path: 'systemPrompt', value: paths[0] })
        } else {
          // 未找到——让用户手动输入。
          const manual = window.prompt('File path not found automatically. Please enter the full path:', file.name)
          if (manual) port.post({ type: 'config_set', path: 'systemPrompt', value: manual })
        }
      } catch {
        const manual = window.prompt('Enter the full path to the system prompt file:', file.name)
        if (manual) port.post({ type: 'config_set', path: 'systemPrompt', value: manual })
      }
    }
    e.target.value = '' // reset for re-selection
  }

  return (
    <>
      <div className={styles.sectionTitle}>General</div>
      <div className={styles.sectionDesc}>Default provider, model, and runtime configuration</div>
      <div className={styles.fieldGroup}>
        <SelectField label="Default Provider" desc="Which API provider to use" value={config.defaultProvider ?? ''} options={providers.length ? providers : [{ value: '', label: '(none)' }]} onChange={(v) => port.post({ type: 'config_set', path: 'defaultProvider', value: v })} />
        <SelectField label="Default Model" desc="Which model to use for responses" value={config.defaultModel ?? ''} options={modelOptions.length ? modelOptions : [{ value: '', label: '(select provider first)' }]} onChange={(v) => port.post({ type: 'config_set', path: 'defaultModel', value: v })} />

        {/* System Prompt — 原生文件选择对话框 + 清除按钮 */}
        <div className={styles.field}>
          <span className={styles.fieldLabel}>System Prompt</span>
          <span className={styles.fieldDesc}>Path to system prompt file (empty = built-in)</span>
          <div className={styles.filePicker}>
            <input className={`${styles.input} ${styles.mono}`} placeholder="(built-in)" value={config.systemPrompt ?? ''} readOnly />
            {config.systemPrompt && (
              <button className={styles.fileClearBtn} onClick={() => port.post({ type: 'config_set', path: 'systemPrompt', value: '' })} title="Clear">
                <X size={14} strokeWidth={1.5} />
              </button>
            )}
            <button className={styles.filePickerBtn} onClick={() => fileInputRef.current?.click()} title="Browse file">
              <FileText size={14} strokeWidth={1.5} />
            </button>
            <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={handleFileSelect} accept=".txt,.md,.text,.markdown" />
          </div>
        </div>

        {/* Shell Program — 检测到的 shell 下拉框 */}
        <SelectField label="Shell Program" desc="Detected shells available on this system" value={config.shellProgram ?? ''} options={[{ value: '', label: '(auto — platform default)' }, ...shells]} onChange={(v) => port.post({ type: 'config_set', path: 'shellProgram', value: v })} />

        <div className={styles.twoCol}>
          <NumberField label="Max Iterations" value={config.maxIterations} onChange={(v) => port.post({ type: 'config_set', path: 'maxIterations', value: v })} />
          <NumberField label="Max Retries" value={config.maxRetries} onChange={(v) => port.post({ type: 'config_set', path: 'maxRetries', value: v })} />
        </div>
      </div>
    </>
  )
}

// ── Models ──
function ModelsSection({ config, port }: { config: Config; port: UiPort }) {
  return (
    <>
      <div className={styles.sectionTitle}>Providers & Models</div>
      <div className={styles.sectionDesc}>API providers and their model configurations</div>
      <div className={styles.providerList}>
        {config.providers.map((provider, pIdx) => (
          <ProviderCard key={pIdx} provider={provider} pIdx={pIdx} port={port} />
        ))}
        <button className={styles.addBtn} onClick={() => port.post({ type: 'config_add', path: 'providers', value: { name: '', protocol: 'openai', baseURL: '', apiKey: '', models: [] } })}>
          <Plus size={14} strokeWidth={1.5} /><span>Add Provider</span>
        </button>
      </div>
    </>
  )
}

function ProviderCard({ provider, pIdx, port }: { provider: Config['providers'][number]; pIdx: number; port: UiPort }) {
  const [expanded, setExpanded] = useState(true)
  const base = `providers.${pIdx}`
  return (
    <div className={`${styles.providerCard} ${expanded ? '' : styles.collapsedCard}`}>
      <div className={styles.providerHeader} onClick={() => setExpanded(!expanded)}>
        <div className={styles.providerIcon}><Server size={14} strokeWidth={1.5} /></div>
        <span className={styles.providerName}>{provider.name || '(unnamed)'}</span>
        <span className={styles.providerMeta}>{provider.models.length} model(s)</span>
        <ChevronDown size={14} strokeWidth={2} className={styles.providerChevron} />
      </div>
      {expanded && (
        <div className={styles.providerBody}>
          <TextField label="Name" value={provider.name} mono clearable onChange={(v) => port.post({ type: 'config_set', path: `${base}.name`, value: v })} />
          <TextField label="Base URL" value={provider.baseURL} mono clearable onChange={(v) => port.post({ type: 'config_set', path: `${base}.baseURL`, value: v })} />
          <TextField label="API Key" value={provider.apiKey} mono password clearable onChange={(v) => port.post({ type: 'config_set', path: `${base}.apiKey`, value: v })} />

          <div className={styles.modelsLabel}>Models</div>
          {provider.models.map((model, mIdx) => (
            <ModelEditor key={mIdx} model={model} pIdx={pIdx} mIdx={mIdx} port={port} />
          ))}
          <button className={styles.addBtn} onClick={() => port.post({ type: 'config_add', path: `${base}.models`, value: { name: '', contextWindow: 128000, maxOutput: 16384, reasoning: false } })}>
            <Plus size={14} strokeWidth={1.5} /><span>Add Model</span>
          </button>
          <button className={styles.deleteBtn} onClick={() => port.post({ type: 'config_remove', path: 'providers', index: pIdx })}>
            <Trash2 size={13} strokeWidth={1.5} /><span>Delete Provider</span>
          </button>
        </div>
      )}
    </div>
  )
}

// Model 编辑器——完整字段：name/contextWindow/maxOutput/reasoning + 删除。可折叠。
function ModelEditor({ model, pIdx, mIdx, port }: { model: Config['providers'][number]['models'][number]; pIdx: number; mIdx: number; port: UiPort }) {
  const mb = `providers.${pIdx}.models.${mIdx}`
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={styles.modelEditor}>
      <div className={styles.modelEditorHeader} onClick={() => setExpanded(!expanded)} style={{ cursor: 'pointer' }}>
        <Cpu size={14} strokeWidth={1.5} className={styles.modelIcon} />
        <span className={styles.modelEditorTitle}>{model.name || '(unnamed)'}</span>
        <ChevronDown size={12} strokeWidth={2} className={styles.providerChevron} style={{ transform: expanded ? 'none' : 'rotate(-90deg)' }} />
        <button className={styles.modelDel} onClick={(e) => { e.stopPropagation(); port.post({ type: 'config_remove', path: 'models', index: mIdx, providerIndex: pIdx }) }} aria-label="Delete model">
          <Trash2 size={12} strokeWidth={1.5} />
        </button>
      </div>
      {expanded && (
        <div className={styles.modelFields}>
          <TextField label="Model Name" value={model.name} mono onChange={(v) => port.post({ type: 'config_set', path: `${mb}.name`, value: v })} />
          <NumberField label="Context Window" value={model.contextWindow} onChange={(v) => port.post({ type: 'config_set', path: `${mb}.contextWindow`, value: v })} />
          <NumberField label="Max Output" value={model.maxOutput} onChange={(v) => port.post({ type: 'config_set', path: `${mb}.maxOutput`, value: v })} />
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Reasoning</span>
            <div className={styles.toggleRow}>
              <span className={styles.toggleDesc}>Enable thinking mode</span>
              <Toggle on={model.reasoning} onChange={() => port.post({ type: 'config_set', path: `${mb}.reasoning`, value: !model.reasoning })} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Permissions ──
function PermissionsSection({ config, port }: { config: Config; port: UiPort }) {
  // 获取可用工具列表。
  const [toolsList, setToolsList] = useState<{ name: string; description: string }[]>([])
  useEffect(() => {
    // 请求工具列表——通过 port 发送，但这里是 settings 组件没有 port 的 onMessage。
    // 直接用 fetch 不可行（工具列表通过 SSE 返回）。改用一个简单方案：硬编码已知工具 + 从 config 推断。
    // 后端有 4 个固定工具：read_file, write_file, edit_file, shell。
    setToolsList([
      { name: 'read_file', description: 'Read file contents' },
      { name: 'write_file', description: 'Write file contents' },
      { name: 'edit_file', description: 'Edit file with old/new strings' },
      { name: 'shell', description: 'Execute shell commands' },
    ])
  }, [])

  const buckets = ['allow', 'reject', 'ask'] as const
  const allAddedTools = new Set(buckets.flatMap((b) => config.permission[b]))

  return (
    <>
      <div className={styles.sectionTitle}>Permissions</div>
      <div className={styles.sectionDesc}>Tool execution rules. Select from available tools to add to each bucket.</div>
      <div className={styles.permList}>
        {buckets.map((bucket) => {
          const tools = config.permission[bucket]
          const availableToAdd = toolsList.filter((t) => !allAddedTools.has(t.name) || tools.includes(t.name))
          return (
            <div key={bucket} className={styles.permSection}>
              <div className={styles.permHeader}>
                <span className={styles.permName} data-bucket={bucket}>{bucket}</span>
                <span className={styles.permCount}>{tools.length} tool(s)</span>
              </div>
              <div className={styles.permChips}>
                {tools.map((tool) => (
                  <span key={tool} className={styles.permChip}>
                    <code>{tool}</code>
                    <button className={styles.permChipX} onClick={() => port.post({ type: 'config_set', path: `permission.${bucket}`, value: tools.filter((t) => t !== tool) })} aria-label={`Remove ${tool}`}>
                      <X size={10} strokeWidth={2} />
                    </button>
                  </span>
                ))}
                {tools.length === 0 && <span className={styles.permEmpty}>No tools</span>}
              </div>
              {/* 工具选择下拉框——只显示未添加到任何桶的工具 */}
              <div className={styles.permAddWrap}>
                <select
                  className={styles.permAdd}
                  value=""
                  onChange={(e) => {
                    const v = e.target.value
                    if (v) port.post({ type: 'config_set', path: `permission.${bucket}`, value: [...tools, v] })
                  }}
                >
                  <option value="">+ Add tool...</option>
                  {toolsList
                    .filter((t) => !allAddedTools.has(t.name))
                    .map((t) => <option key={t.name} value={t.name}>{t.name} — {t.description}</option>)}
                </select>
                <ChevronDown size={12} strokeWidth={2} className={styles.permAddArrow} />
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

// ── 通用表单组件 ──
function SelectField({ label, desc, value, options, onChange }: { label: string; desc?: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {desc && <span className={styles.fieldDesc}>{desc}</span>}
      <div className={styles.selectWrap}>
        <select className={styles.select} value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <ChevronDown size={12} strokeWidth={2} className={styles.selectArrow} />
      </div>
    </div>
  )
}

function TextField({ label, value, mono, password, clearable, onChange }: { label: string; value: string; mono?: boolean; password?: boolean; clearable?: boolean; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <div className={styles.inputRow}>
        <input
          className={`${styles.input} ${mono ? styles.mono : ''}`}
          type={password ? 'password' : 'text'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { if (draft !== value) onChange(draft) }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        />
        {clearable && value && (
          <button className={styles.inputClearBtn} onClick={() => { setDraft(''); onChange('') }} title="Clear">
            <X size={12} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  )
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <input
        className={`${styles.input} ${styles.mono}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { const n = Number(draft); if (Number.isFinite(n) && n !== value) onChange(n) }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      />
    </div>
  )
}
