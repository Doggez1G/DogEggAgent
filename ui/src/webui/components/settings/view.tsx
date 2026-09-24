import { useState, useEffect } from 'react'
import { Trash2, Plus, Server, Cpu, ShieldCheck, SlidersHorizontal, ChevronDown, X, FileText, FolderClosed, FolderUp, ArrowLeft, ChevronRight, Check } from 'lucide-react'
import type { Config, UiPort } from '@dogegg/bridge'
import { PermissionsSection } from './permissions'
import { SkillsSection } from './skills'
import { McpSection } from './mcp'
import { safeSettingsPost } from './safe-post'
import { Toggle, Button } from '../primitives'
import styles from './settings.module.css'

// 设置弹窗：左侧导航 + 右侧内容区（IDE 风格分栏）。
// 三个 section：General / Models / Permissions。
// General: system prompt 用文件选择器，shell 用检测到的 shell 下拉框。
// Models: 每个 model 有完整编辑器（name/contextWindow/maxOutput/reasoning + 删除）。
// Permissions: 从可用工具列表选择添加，不手动输入。
type Section = 'general' | 'models' | 'permissions' | 'skills' | 'mcp'

interface SettingsProps {
  config: Config | null
  port: UiPort
  onClose: () => void
  /** 打开时聚焦的 section（/skills 命令 → skills）——缺省 general。 */
  initialSection?: 'skills' | 'mcp'
}

export function Settings({ config, port, initialSection }: SettingsProps) {
  const [section, setSection] = useState<Section>(initialSection ?? 'general')
  if (!config) return <div className={styles.loading}>Loading config...</div>

  return (
    <div className={styles.settings}>
      <nav className={styles.nav}>
        <NavBtn icon={SlidersHorizontal} label="General" active={section === 'general'} onClick={() => setSection('general')} />
        <NavBtn icon={Cpu} label="Models" active={section === 'models'} onClick={() => setSection('models')} />
        <NavBtn icon={ShieldCheck} label="Permissions" active={section === 'permissions'} onClick={() => setSection('permissions')} />
        <NavBtn icon={FileText} label="Skills" active={section === 'skills'} onClick={() => setSection('skills')} />
        <NavBtn icon={Server} label="MCP Servers" active={section === 'mcp'} onClick={() => setSection('mcp')} />
      </nav>
      <div className={styles.content}>
        {section === 'general' && <GeneralSection config={config} port={port} />}
        {section === 'models' && <ModelsSection config={config} port={port} />}
        {section === 'permissions' && <PermissionsSection config={config} port={port} />}
        {section === 'skills' && <SkillsSection port={port} />}
        {section === 'mcp' && <McpSection port={port} />}
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

  // System prompt 文件选择器——使用 FsBrowserModal（支持文件选择）。
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false)

  return (
    <>
      <div className={styles.sectionTitle}>General</div>
      <div className={styles.sectionDesc}>Default provider, model, and runtime configuration</div>
      <div className={styles.fieldGroup}>
        {/* 所有 config_set 走 safeSettingsPost——网络/通道失败不再静默（console.warn 留痕）。 */}
        <SelectField label="Default Provider" desc="Which API provider to use" value={config.defaultProvider ?? ''} options={providers.length ? providers : [{ value: '', label: '(none)' }]} onChange={(v) => safeSettingsPost(port, { type: 'config_set', path: 'defaultProvider', value: v })} />
        <SelectField label="Default Model" desc="Which model to use for responses" value={config.defaultModel ?? ''} options={modelOptions.length ? modelOptions : [{ value: '', label: currentProvider ? '(no models — add them in Models)' : '(select provider first)' }]} onChange={(v) => safeSettingsPost(port, { type: 'config_set', path: 'defaultModel', value: v })} />

        {/* System Prompt — 原生文件选择对话框 + 清除按钮 */}
        <div className={styles.field}>
          <span className={styles.fieldLabel}>System Prompt</span>
          <span className={styles.fieldDesc}>Path to system prompt file (empty = built-in)</span>
          <div className={styles.filePicker}>
            <input className={`${styles.input} ${styles.mono}`} placeholder="(built-in)" value={config.systemPrompt ?? ''} readOnly />
            {config.systemPrompt && (
              <button className={styles.fileClearBtn} onClick={() => safeSettingsPost(port, { type: 'config_set', path: 'systemPrompt', value: '' })} title="Clear">
                <X size={14} strokeWidth={1.5} />
              </button>
            )}
            <button className={styles.filePickerBtn} onClick={() => setFileBrowserOpen(true)} title="Browse file">
              <FileText size={14} strokeWidth={1.5} />
            </button>
          </div>
        </div>

        {/* Shell Program — 检测到的 shell 下拉框 */}
        <SelectField label="Shell Program" desc="Detected shells available on this system" value={config.shellProgram ?? ''} options={[{ value: '', label: '(auto — platform default)' }, ...shells]} onChange={(v) => safeSettingsPost(port, { type: 'config_set', path: 'shellProgram', value: v })} />

        <div className={styles.twoCol}>
          {/* validate 与后端 zod 校验对齐（config.ts：maxIterations=-1 或 >=1；maxRetries>=0）——前端即时反馈。 */}
          <NumberField label="Max Iterations" value={config.maxIterations} validate={(n) => (n === -1 || n >= 1 ? null : '需为正整数（-1 表示不设限）')} onChange={(v) => safeSettingsPost(port, { type: 'config_set', path: 'maxIterations', value: v })} />
          <NumberField label="Max Retries" value={config.maxRetries} validate={(n) => (n >= 0 ? null : '需为非负整数')} onChange={(v) => safeSettingsPost(port, { type: 'config_set', path: 'maxRetries', value: v })} />
        </div>
      </div>

      {fileBrowserOpen && (
        <FsFilePicker
          onConfirm={(path) => { safeSettingsPost(port, { type: 'config_set', path: 'systemPrompt', value: path }); setFileBrowserOpen(false) }}
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
        {/* key 用 provider 名（稳定标识）而非数组下标——删除中间项时下标 key 会让后续卡片整体
            前移复用，折叠/展开等组件内部状态错位到错误的 provider 上；未命名 provider 回落下标。 */}
        {config.providers.map((provider, pIdx) => (
          <ProviderCard key={provider.name || `__idx_${pIdx}`} provider={provider} pIdx={pIdx} port={port} />
        ))}
        <button className={styles.addBtn} onClick={() => safeSettingsPost(port, { type: 'config_add', path: 'providers', value: { name: '', protocol: 'openai', baseURL: '', apiKey: '', models: [] } })}>
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
          <TextField label="Name" value={provider.name} mono clearable onChange={(v) => safeSettingsPost(port, { type: 'config_set', path: `${base}.name`, value: v })} />
          <SelectField label="Protocol" desc="API protocol (currently OpenAI-compatible only)" value={provider.protocol} options={[{ value: 'openai', label: 'openai (OpenAI-compatible)' }]} onChange={(v) => safeSettingsPost(port, { type: 'config_set', path: `${base}.protocol`, value: v })} />
          <TextField label="Base URL" value={provider.baseURL} mono clearable onChange={(v) => safeSettingsPost(port, { type: 'config_set', path: `${base}.baseURL`, value: v })} />
          <TextField label="API Key" value={provider.apiKey} mono password clearable onChange={(v) => safeSettingsPost(port, { type: 'config_set', path: `${base}.apiKey`, value: v })} />

          <div className={styles.modelsLabel}>Models</div>
          {/* key 用 model 名（稳定标识）而非下标——删除中间 model 时下标 key 会让后续编辑器的
              展开/草稿状态错位到相邻项；未命名 model 回落下标。 */}
          {provider.models.map((model, mIdx) => (
            <ModelEditor key={model.name || `__idx_${mIdx}`} model={model} pIdx={pIdx} mIdx={mIdx} port={port} />
          ))}
          <button className={styles.addBtn} onClick={() => safeSettingsPost(port, { type: 'config_add', path: `${base}.models`, value: { name: '', contextWindow: 128000, maxOutput: 16384, reasoning: false } })}>
            <Plus size={14} strokeWidth={1.5} /><span>Add Model</span>
          </button>
          <button className={styles.deleteBtn} onClick={() => safeSettingsPost(port, { type: 'config_remove', path: 'providers', index: pIdx })}>
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
        <button className={styles.modelDel} onClick={(e) => { e.stopPropagation(); safeSettingsPost(port, { type: 'config_remove', path: 'models', index: mIdx, providerIndex: pIdx }) }} aria-label="Delete model">
          <Trash2 size={12} strokeWidth={1.5} />
        </button>
      </div>
      {expanded && (
        <div className={styles.modelFields}>
          <TextField label="Model Name" value={model.name} mono onChange={(v) => safeSettingsPost(port, { type: 'config_set', path: `${mb}.name`, value: v })} />
          {/* validate 与后端 zod 对齐（config.ts：contextWindow/maxOutput 为正整数）。 */}
          <NumberField label="Context Window" value={model.contextWindow} validate={(n) => (n > 0 ? null : '需为正整数')} onChange={(v) => safeSettingsPost(port, { type: 'config_set', path: `${mb}.contextWindow`, value: v })} />
          <NumberField label="Max Output" value={model.maxOutput} validate={(n) => (n > 0 ? null : '需为正整数')} onChange={(v) => safeSettingsPost(port, { type: 'config_set', path: `${mb}.maxOutput`, value: v })} />
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Reasoning</span>
            <div className={styles.toggleRow}>
              <span className={styles.toggleDesc}>Enable thinking mode</span>
              <Toggle on={model.reasoning} onChange={() => safeSettingsPost(port, { type: 'config_set', path: `${mb}.reasoning`, value: !model.reasoning })} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 文件选择器（目录+文件浏览，复用 /api/fs?files=true）──
function FsFilePicker({ onConfirm, onClose }: { onConfirm: (path: string) => void; onClose: () => void }) {
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
              {selectedFile === f && <Check size={12} strokeWidth={2} style={{ marginLeft: 'auto', color: 'var(--color-accent)' }} />}
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
  // 健壮性：当前值不在选项中（如 provider 的模型清单尚未同步到前端）时，补显「当前值」——
  // 避免 select 静默回落到第一个选项，造成「配置看似丢失」的错觉。
  const opts = value && !options.some((o) => o.value === value)
    ? [{ value, label: `${value}（当前值）` }, ...options]
    : options
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {desc && <span className={styles.fieldDesc}>{desc}</span>}
      <div className={styles.selectWrap}>
        <select className={styles.select} value={value} onChange={(e) => onChange(e.target.value)}>
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
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

// 数值输入框：失焦/回车提交。
// 前端失焦校验（修复静默失败）：空串 / 非有限数 / 非整数一律不发请求——Number('')=0 之类
// 会被后端 zod 拒绝而用户毫无感知；改为输入框标红 + 旁注错误文案。字段级语义（如
// maxIterations 允许 -1）由调用方通过 validate 提供（与 bridge/contract/config.ts 的 zod 对齐）。
function NumberField({ label, value, onChange, validate }: { label: string; value: number; onChange: (v: number) => void; validate?: (n: number) => string | null }) {
  const [draft, setDraft] = useState(String(value))
  const [error, setError] = useState('')
  useEffect(() => { setDraft(String(value)); setError('') }, [value])
  const commit = (): void => {
    const t = draft.trim()
    if (t === '') { setError('不能为空——需填写整数'); return }
    const n = Number(t)
    if (!Number.isFinite(n) || !Number.isInteger(n)) { setError('需为整数'); return }
    const invalid = validate?.(n)
    if (invalid) { setError(invalid); return }
    setError('')
    if (n !== value) onChange(n)
  }
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <input
        className={`${styles.input} ${styles.mono} ${error ? styles.inputError : ''}`}
        value={draft}
        aria-invalid={!!error}
        onChange={(e) => { setDraft(e.target.value); setError('') }}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      />
      {error && <span className={styles.fieldError}>{error}</span>}
    </div>
  )
}
