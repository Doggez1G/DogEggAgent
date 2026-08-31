import { useState, useEffect } from 'react'
import { Trash2, Plus, Server, Cpu, ShieldCheck, SlidersHorizontal, ChevronDown, X, FileText, FolderClosed, FolderUp, ArrowLeft, ChevronRight } from 'lucide-react'
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

  // System prompt 文件选择器状态。
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false)

  return (
    <>
      <div className={styles.sectionTitle}>General</div>
      <div className={styles.sectionDesc}>Default provider, model, and runtime configuration</div>
      <div className={styles.fieldGroup}>
        <SelectField label="Default Provider" desc="Which API provider to use" value={config.defaultProvider ?? ''} options={providers.length ? providers : [{ value: '', label: '(none)' }]} onChange={(v) => port.post({ type: 'config_set', path: 'defaultProvider', value: v })} />
        <SelectField label="Default Model" desc="Which model to use for responses" value={config.defaultModel ?? ''} options={modelOptions.length ? modelOptions : [{ value: '', label: '(select provider first)' }]} onChange={(v) => port.post({ type: 'config_set', path: 'defaultModel', value: v })} />

        {/* System Prompt — 文件选择器 */}
        <div className={styles.field}>
          <span className={styles.fieldLabel}>System Prompt</span>
          <span className={styles.fieldDesc}>Path to system prompt file (empty = built-in)</span>
          <div className={styles.filePicker}>
            <input className={`${styles.input} ${styles.mono}`} placeholder="(built-in)" value={config.systemPrompt ?? ''} readOnly />
            <button className={styles.filePickerBtn} onClick={() => setFileBrowserOpen(true)} title="Browse file">
              <FileText size={14} strokeWidth={1.5} />
            </button>
          </div>
        </div>

        {/* Shell Program — 检测到的 shell 下拉框 */}
        <SelectField label="Shell Program" desc="Detected shells available on this system" value={config.shellProgram ?? ''} options={[{ value: '', label: '(auto — platform default)' }, ...shells]} onChange={(v) => port.post({ type: 'config_set', path: 'shellProgram', value: v })} />

        <div className={styles.twoCol}>
          <NumberField label="Max Iterations" value={config.maxIterations} onChange={(v) => port.post({ type: 'config_set', path: 'maxIterations', value: v })} />
          <NumberField label="Max Retries" value={config.maxRetries} onChange={(v) => port.post({ type: 'config_set', path: 'maxRetries', value: v })} />
        </div>
      </div>

      {fileBrowserOpen && (
        <FilePickerModal
          onConfirm={(path) => { port.post({ type: 'config_set', path: 'systemPrompt', value: path }); setFileBrowserOpen(false) }}
          onClose={() => setFileBrowserOpen(false)}
        />
      )}
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
          <TextField label="Name" value={provider.name} mono onChange={(v) => port.post({ type: 'config_set', path: `${base}.name`, value: v })} />
          <TextField label="Base URL" value={provider.baseURL} mono onChange={(v) => port.post({ type: 'config_set', path: `${base}.baseURL`, value: v })} />
          <TextField label="API Key" value={provider.apiKey} mono password onChange={(v) => port.post({ type: 'config_set', path: `${base}.apiKey`, value: v })} />

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

// Model 编辑器——完整字段：name/contextWindow/maxOutput/reasoning + 删除。
function ModelEditor({ model, pIdx, mIdx, port }: { model: Config['providers'][number]['models'][number]; pIdx: number; mIdx: number; port: UiPort }) {
  const mb = `providers.${pIdx}.models.${mIdx}`
  return (
    <div className={styles.modelEditor}>
      <div className={styles.modelEditorHeader}>
        <Cpu size={14} strokeWidth={1.5} className={styles.modelIcon} />
        <span className={styles.modelEditorTitle}>{model.name || '(unnamed)'}</span>
        <button className={styles.modelDel} onClick={() => port.post({ type: 'config_remove', path: 'models', index: mIdx, providerIndex: pIdx })} aria-label="Delete model">
          <Trash2 size={12} strokeWidth={1.5} />
        </button>
      </div>
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

// ── 文件选择器 Modal ──
function FilePickerModal({ onConfirm, onClose }: { onConfirm: (path: string) => void; onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [dirs, setDirs] = useState<string[]>([])
  const [files, setFiles] = useState<string[]>([])
  const [parent, setParent] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [selectedFile, setSelectedFile] = useState('')

  useEffect(() => {
    fetch('/api/fs?files=true').then((r) => r.json()).then((d) => { setCurrent(d.current); setDirs(d.dirs); setFiles(d.files ?? []); setParent(d.parent) })
  }, [])

  const browse = (path: string) => {
    setHistory((h) => [...h, current])
    fetch(`/api/fs?path=${encodeURIComponent(path)}&files=true`).then((r) => r.json()).then((d) => { setCurrent(d.current); setDirs(d.dirs); setFiles(d.files ?? []); setParent(d.parent); setSelectedFile('') })
  }
  const goBack = () => {
    if (history.length === 0) return
    const prev = history[history.length - 1]!
    setHistory((h) => h.slice(0, -1))
    fetch(`/api/fs?path=${encodeURIComponent(prev)}&files=true`).then((r) => r.json()).then((d) => { setCurrent(d.current); setDirs(d.dirs); setFiles(d.files ?? []); setParent(d.parent); setSelectedFile('') })
  }
  const breadcrumbs = current ? current.split(/[/\\]/).filter(Boolean) : []

  return (
    <div className={styles.fileScrim} onClick={onClose}>
      <div className={styles.fileModal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.fileHeader}>
          <span className={styles.fileTitle}>Select System Prompt File</span>
          <button className={styles.fileClose} onClick={onClose}><X size={16} strokeWidth={2} /></button>
        </div>
        <div className={styles.fileBreadcrumb}>
          {history.length > 0 && <button className={styles.fileBack} onClick={goBack}><ArrowLeft size={14} strokeWidth={1.5} /></button>}
          {parent && <button className={styles.fileUp} onClick={() => browse(parent)}><FolderUp size={14} strokeWidth={1.5} /></button>}
          {breadcrumbs.map((seg, i) => (
            <span key={i}>
              {i > 0 && <ChevronRight size={10} strokeWidth={1.5} className={styles.fileCrumbSep} />}
              <span className={i === breadcrumbs.length - 1 ? styles.fileCrumbActive : styles.fileCrumb}>{seg}</span>
            </span>
          ))}
        </div>
        <div className={styles.fileList}>
          {dirs.map((d) => (
            <button key={d} className={styles.fileItem} onClick={() => browse(current + '/' + d)}>
              <FolderClosed size={15} strokeWidth={1.5} className={styles.fileItemDirIcon} />
              <span>{d}</span>
            </button>
          ))}
          {files.map((f) => (
            <button key={f} className={`${styles.fileItem} ${selectedFile === f ? styles.fileItemSelected : ''}`} onClick={() => setSelectedFile(f)}>
              <FileText size={15} strokeWidth={1.5} className={styles.fileItemFileIcon} />
              <span>{f}</span>
            </button>
          ))}
          {dirs.length === 0 && files.length === 0 && <p className={styles.fileEmpty}>No items</p>}
        </div>
        <div className={styles.fileActions}>
          <Button variant="primary" size="sm" disabled={!selectedFile} onClick={() => onConfirm(current + '/' + selectedFile)}>Select File</Button>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
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

function TextField({ label, value, mono, password, onChange }: { label: string; value: string; mono?: boolean; password?: boolean; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <input
        className={`${styles.input} ${mono ? styles.mono : ''}`}
        type={password ? 'password' : 'text'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft !== value) onChange(draft) }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      />
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
