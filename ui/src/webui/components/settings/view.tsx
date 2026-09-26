import { useState, useEffect } from 'react'
import { Trash2, Plus, Server, Cpu, ShieldCheck, SlidersHorizontal, ChevronDown, X, FileText, FolderClosed, FolderUp, ArrowLeft, ChevronRight, Check } from 'lucide-react'
import type { Config, UiPort, UiToAgentMessage } from '@dogegg/bridge'
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

  // P2-35：保存失败反馈——此前 safeSettingsPost 未传 onFail，失败只有 console.warn，
  // 用户以为保存成功。照 skills/mcp 的 inlineError 模式补齐（见下 post 包装）。
  const [inlineError, setInlineError] = useState('')

  // 本区统一提交入口：新提交开始即清上次失败提示、失败时写 inlineError。
  // skills/mcp 靠成功清单广播清除提示；本区无清单广播，用「下一次提交起点」代替清除时机。
  const post = (msg: UiToAgentMessage): void => {
    setInlineError('')
    safeSettingsPost(port, msg, (e) => setInlineError(`保存失败：${e.message}`))
  }

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
      {/* 保存失败的 inline 反馈（P2-35），样式与 skills/mcp 的 inlineError 一致。 */}
      {inlineError && <div style={{ color: 'var(--color-danger)', fontSize: 12, marginBottom: 8 }}>{inlineError}</div>}
      <div className={styles.fieldGroup}>
        {/* 所有 config_set 走 post（safeSettingsPost + onFail）——网络/通道失败 inline 可见。 */}
        <SelectField label="Default Provider" desc="Which API provider to use" value={config.defaultProvider ?? ''} options={providers.length ? providers : [{ value: '', label: '(none)' }]} onChange={(v) => post({ type: 'config_set', path: 'defaultProvider', value: v })} />
        <SelectField label="Default Model" desc="Which model to use for responses" value={config.defaultModel ?? ''} options={modelOptions.length ? modelOptions : [{ value: '', label: currentProvider ? '(no models — add them in Models)' : '(select provider first)' }]} onChange={(v) => post({ type: 'config_set', path: 'defaultModel', value: v })} />

        {/* System Prompt — 原生文件选择对话框 + 清除按钮 */}
        <div className={styles.field}>
          <span className={styles.fieldLabel}>System Prompt</span>
          <span className={styles.fieldDesc}>Path to system prompt file (empty = built-in)</span>
          <div className={styles.filePicker}>
            <input className={`${styles.input} ${styles.mono}`} placeholder="(built-in)" value={config.systemPrompt ?? ''} readOnly />
            {config.systemPrompt && (
              <button className={styles.fileClearBtn} onClick={() => post({ type: 'config_set', path: 'systemPrompt', value: '' })} title="Clear">
                <X size={14} strokeWidth={1.5} />
              </button>
            )}
            <button className={styles.filePickerBtn} onClick={() => setFileBrowserOpen(true)} title="Browse file">
              <FileText size={14} strokeWidth={1.5} />
            </button>
          </div>
        </div>

        {/* Shell Program — 检测到的 shell 下拉框 */}
        <SelectField label="Shell Program" desc="Detected shells available on this system" value={config.shellProgram ?? ''} options={[{ value: '', label: '(auto — platform default)' }, ...shells]} onChange={(v) => post({ type: 'config_set', path: 'shellProgram', value: v })} />

        <div className={styles.twoCol}>
          {/* validate 与后端 zod 校验对齐（config.ts：maxIterations=-1 或 >=1；maxRetries>=0）——前端即时反馈。 */}
          <NumberField label="Max Iterations" value={config.maxIterations} validate={(n) => (n === -1 || n >= 1 ? null : '需为正整数（-1 表示不设限）')} onChange={(v) => post({ type: 'config_set', path: 'maxIterations', value: v })} />
          <NumberField label="Max Retries" value={config.maxRetries} validate={(n) => (n >= 0 ? null : '需为非负整数')} onChange={(v) => post({ type: 'config_set', path: 'maxRetries', value: v })} />
        </div>
      </div>

      {fileBrowserOpen && (
        <FsFilePicker
          onConfirm={(path) => { post({ type: 'config_set', path: 'systemPrompt', value: path }); setFileBrowserOpen(false) }}
          onClose={() => setFileBrowserOpen(false)}
        />
      )}
    </>
  )
}

// ── Models ──
function ModelsSection({ config, port }: { config: Config; port: UiPort }) {
  // P2-35：与 General 同款 inlineError——失败不再只有 console.warn。post 沿组件树下发
  //（ProviderCard/ModelEditor 的全部写操作都走它），失败统一显示在本区标题下方。
  const [inlineError, setInlineError] = useState('')
  const post = (msg: UiToAgentMessage): void => {
    setInlineError('')
    safeSettingsPost(port, msg, (e) => setInlineError(`保存失败：${e.message}`))
  }
  return (
    <>
      <div className={styles.sectionTitle}>Providers & Models</div>
      <div className={styles.sectionDesc}>API providers and their model configurations</div>
      {inlineError && <div style={{ color: 'var(--color-danger)', fontSize: 12, marginBottom: 8 }}>{inlineError}</div>}
      <div className={styles.providerList}>
        {/* P2-34 立法：key 改用数组下标（原用 provider.name，未命名回落下标）。取舍说明——
            name 作 key 的问题：改名保存 → 后端回读 config → name 变化 → key 变化 → 整卡重挂载，
            卡内未 blur 的草稿（BaseURL/APIKey 的 TextField draft）丢失、展开态折叠回默认。
            编辑会话内 providers 数组顺序稳定（本 UI 无拖拽/排序，只有尾部 Add 与显式 Delete），
            下标 key 让卡片跨 name 变化保持实例，草稿与展开态得以保留。
            下标 key 的代价：删除中间项时后续卡片下标前移、React 复用同位置实例——但删除是
            显式破坏性操作，且回读的 config 会经各字段 useEffect 重置草稿、展开态错位影响仅
            一次折叠状态，可接受。 */}
        {config.providers.map((provider, pIdx) => (
          <ProviderCard key={pIdx} provider={provider} pIdx={pIdx} post={post} />
        ))}
        <button className={styles.addBtn} onClick={() => post({ type: 'config_add', path: 'providers', value: { name: '', protocol: 'openai', baseURL: '', apiKey: '', models: [] } })}>
          <Plus size={14} strokeWidth={1.5} /><span>Add Provider</span>
        </button>
      </div>
    </>
  )
}

function ProviderCard({ provider, pIdx, post }: { provider: Config['providers'][number]; pIdx: number; post: (msg: UiToAgentMessage) => void }) {
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
          {/* 卡片内全部写操作走 ModelsSection 下发的 post（P2-35：失败 inline 反馈）。 */}
          <TextField label="Name" value={provider.name} mono clearable onChange={(v) => post({ type: 'config_set', path: `${base}.name`, value: v })} />
          <SelectField label="Protocol" desc="API protocol (currently OpenAI-compatible only)" value={provider.protocol} options={[{ value: 'openai', label: 'openai (OpenAI-compatible)' }]} onChange={(v) => post({ type: 'config_set', path: `${base}.protocol`, value: v })} />
          <TextField label="Base URL" value={provider.baseURL} mono clearable onChange={(v) => post({ type: 'config_set', path: `${base}.baseURL`, value: v })} />
          <TextField label="API Key" value={provider.apiKey} mono password clearable onChange={(v) => post({ type: 'config_set', path: `${base}.apiKey`, value: v })} />

          <div className={styles.modelsLabel}>Models</div>
          {/* P2-34：与 provider 卡同理改下标 key（原用 model.name）——model 改名回读后 name 变化
              会整块重挂载，展开态丢失；删除中间项的错位代价同上可接受。 */}
          {provider.models.map((model, mIdx) => (
            <ModelEditor key={mIdx} model={model} pIdx={pIdx} mIdx={mIdx} post={post} />
          ))}
          <button className={styles.addBtn} onClick={() => post({ type: 'config_add', path: `${base}.models`, value: { name: '', contextWindow: 128000, maxOutput: 16384, reasoning: false } })}>
            <Plus size={14} strokeWidth={1.5} /><span>Add Model</span>
          </button>
          <button className={styles.deleteBtn} onClick={() => post({ type: 'config_remove', path: 'providers', index: pIdx })}>
            <Trash2 size={13} strokeWidth={1.5} /><span>Delete Provider</span>
          </button>
        </div>
      )}
    </div>
  )
}

// Model 编辑器——完整字段：name/contextWindow/maxOutput/reasoning + 删除。可折叠。
function ModelEditor({ model, pIdx, mIdx, post }: { model: Config['providers'][number]['models'][number]; pIdx: number; mIdx: number; post: (msg: UiToAgentMessage) => void }) {
  const mb = `providers.${pIdx}.models.${mIdx}`
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={styles.modelEditor}>
      <div className={styles.modelEditorHeader} onClick={() => setExpanded(!expanded)} style={{ cursor: 'pointer' }}>
        <Cpu size={14} strokeWidth={1.5} className={styles.modelIcon} />
        <span className={styles.modelEditorTitle}>{model.name || '(unnamed)'}</span>
        <ChevronDown size={12} strokeWidth={2} className={styles.providerChevron} style={{ transform: expanded ? 'none' : 'rotate(-90deg)' }} />
        <button className={styles.modelDel} onClick={(e) => { e.stopPropagation(); post({ type: 'config_remove', path: 'models', index: mIdx, providerIndex: pIdx }) }} aria-label="Delete model">
          <Trash2 size={12} strokeWidth={1.5} />
        </button>
      </div>
      {expanded && (
        <div className={styles.modelFields}>
          <TextField label="Model Name" value={model.name} mono onChange={(v) => post({ type: 'config_set', path: `${mb}.name`, value: v })} />
          {/* validate 与后端 zod 对齐（config.ts：contextWindow/maxOutput 为正整数）。 */}
          <NumberField label="Context Window" value={model.contextWindow} validate={(n) => (n > 0 ? null : '需为正整数')} onChange={(v) => post({ type: 'config_set', path: `${mb}.contextWindow`, value: v })} />
          <NumberField label="Max Output" value={model.maxOutput} validate={(n) => (n > 0 ? null : '需为正整数')} onChange={(v) => post({ type: 'config_set', path: `${mb}.maxOutput`, value: v })} />
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Reasoning</span>
            <div className={styles.toggleRow}>
              <span className={styles.toggleDesc}>Enable thinking mode</span>
              <Toggle on={model.reasoning} onChange={() => post({ type: 'config_set', path: `${mb}.reasoning`, value: !model.reasoning })} />
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
