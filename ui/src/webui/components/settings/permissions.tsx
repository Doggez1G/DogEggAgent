import { useEffect, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import type { Config, UiPort } from '@dogegg/bridge'
import styles from './settings.module.css'

// 权限设置区（v2：桶 → 工具 → 模式数组，空数组 = 整工具）——从 view.tsx 抽出的独立区块组件。
// 所有编辑 = 重算整桶对象 → config_set 桶路径（统一变更原语，天然原子 + 后端 validate/回滚兜底）。
// fail-closed 的编辑器补偿：添加/改名做非空 + 去重校验——模式写错不会报错只会静默不生效。
// 工具清单来自运行时事实（tools_request → tools_list，registry 是活的，未来 MCP 运行期注册的
// 工具自动出现），不用静态镜像清单。

// 单条模式 chip：点击文字 → 就地变输入框（预填原值，Enter/失焦保存、Esc 取消）。
function PatternChip({ pattern, onRename, onDelete }: { pattern: string; onRename: (v: string) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(pattern)
  const commit = (): void => {
    const t = draft.trim()
    if (t && t !== pattern) onRename(t)
    setEditing(false)
  }
  if (editing) {
    return (
      <input
        className={styles.permPatternInput}
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') { setDraft(pattern); setEditing(false) }
        }}
      />
    )
  }
  return (
    <span className={styles.permChip}>
      <code className={styles.permChipEdit} onClick={() => { setDraft(pattern); setEditing(true) }} title="Click to edit">{pattern}</code>
      <button className={styles.permChipX} onClick={onDelete} aria-label={`Remove ${pattern}`}>
        <X size={10} strokeWidth={2} />
      </button>
    </span>
  )
}

// 桶内一个工具的规则组：组头（工具名 + 摘要 + 移除）+ 模式 chips + 添加输入框。
// 删光模式 = 回到整工具（不自动移除工具——用户可能就要整桶生效）；移除按钮才删整个键。
function ToolPermGroup({ tool, patterns, onSetPatterns, onRemove }: {
  tool: string
  patterns: string[]
  onSetPatterns: (next: string[]) => void
  onRemove: () => void
}) {
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState(false)
  const add = (): void => {
    const t = draft.trim()
    if (!t || patterns.includes(t)) { setInvalid(true); return }
    onSetPatterns([...patterns, t])
    setDraft('')
    setInvalid(false)
  }
  return (
    <div className={styles.permTool}>
      <div className={styles.permToolHeader}>
        <span className={styles.permToolName}>{tool}</span>
        <span className={styles.permToolSummary}>{patterns.length === 0 ? 'whole tool' : `${patterns.length} pattern(s)`}</span>
        <button className={styles.permToolRemove} onClick={onRemove} aria-label={`Remove ${tool}`}>
          <X size={11} strokeWidth={2} />
        </button>
      </div>
      {patterns.length > 0 && (
        <div className={styles.permChips}>
          {patterns.map((p, i) => (
            <PatternChip
              key={`${p}-${i}`}
              pattern={p}
              onRename={(v) => onSetPatterns(patterns.map((x, j) => (j === i ? v : x)))}
              onDelete={() => onSetPatterns(patterns.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}
      <div className={styles.permAddWrap}>
        <input
          className={`${styles.permPatternInput} ${invalid ? styles.permPatternInputError : ''}`}
          placeholder={patterns.length === 0 ? '+ Add pattern (switches to pattern-limited)' : '+ Add pattern, press Enter'}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setInvalid(false) }}
          onKeyDown={(e) => { if (e.key === 'Enter') add() }}
          onBlur={() => setInvalid(false)}
        />
      </div>
    </div>
  )
}

// 权限桶 = 可折叠卡片：头部（桶名 + 数量 + 箭头）常显，工具组收在桶体内——
// 三桶默认全收起，摘要先行；工具组是桶体内的嵌套子卡片，从属关系一眼可见。
function BucketCard({ bucket, bucketMap, setBucket, toolsList }: {
  bucket: 'allow' | 'reject' | 'ask'
  bucketMap: Record<string, string[]>
  setBucket: (next: Record<string, string[]>) => void
  toolsList: { name: string; description: string }[]
}) {
  const [open, setOpen] = useState(false)
  const count = Object.keys(bucketMap).length
  return (
    <div className={styles.permCard}>
      <button type="button" className={styles.permCardHeader} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={styles.permName} data-bucket={bucket}>{bucket}</span>
        <span className={styles.permCount}>{count} tool(s)</span>
        <ChevronDown size={13} strokeWidth={2} className={styles.permCardChevron} data-open={open} />
      </button>
      {open && (
        <div className={styles.permCardBody}>
          {Object.entries(bucketMap).map(([tool, patterns]) => (
            <ToolPermGroup
              key={tool}
              tool={tool}
              patterns={patterns}
              onSetPatterns={(next) => setBucket({ ...bucketMap, [tool]: next })}
              onRemove={() => {
                const next = { ...bucketMap }
                delete next[tool]
                setBucket(next)
              }}
            />
          ))}
          {count === 0 && <span className={styles.permEmpty}>No tools — add one below</span>}
          {/* 添加工具下拉：排除已在本桶的（同一工具可出现在多个桶——优先级语义的用途） */}
          <div className={styles.permAddWrap}>
            <select
              className={styles.permAdd}
              value=""
              onChange={(e) => {
                const v = e.target.value
                if (v) setBucket({ ...bucketMap, [v]: [] })
              }}
            >
              <option value="">+ Add tool...</option>
              {toolsList.filter((t) => !(t.name in bucketMap)).map((t) => <option key={t.name} value={t.name}>{t.name} — {t.description}</option>)}
            </select>
            <ChevronDown size={12} strokeWidth={2} className={styles.permAddArrow} />
          </div>
        </div>
      )}
    </div>
  )
}

export function PermissionsSection({ config, port }: { config: Config; port: UiPort }) {
  const buckets = ['allow', 'reject', 'ask'] as const
  const [toolsList, setToolsList] = useState<{ name: string; description: string }[]>([])

  // 工具清单走运行时事实：挂载即请求 tools_request，订阅 tools_list。
  // WebUI 特征各自订阅 port 是既定模式（多订阅合法）；卸载时退订。
  useEffect(() => {
    const off = port.onMessage((m) => {
      if (m.type === 'tools_list') setToolsList(m.tools)
    })
    void port.post({ type: 'tools_request' })
    return off
  }, [port])

  const setBucket = (bucket: 'allow' | 'reject' | 'ask', next: Record<string, string[]>): void => {
    // post 返回 void | Promise<void>（SSE 通道为 async）——发后即忘，块体丢弃返回值。
    void port.post({ type: 'config_set', path: `permission.${bucket}`, value: next })
  }
  return (
    <>
      <div className={styles.sectionTitle}>Permissions</div>
      <div className={styles.sectionDesc}>
        Unlisted tools always ask (fixed safe default). Empty pattern list = whole tool;
        patterns limit the scope (e.g. "git *" for shell commands, "./docs/**" for file paths).
      </div>
      <div className={styles.permList}>
        {buckets.map((bucket) => (
          <BucketCard key={bucket} bucket={bucket} bucketMap={config.permission[bucket]} setBucket={(next) => setBucket(bucket, next)} toolsList={toolsList} />
        ))}
      </div>
    </>
  )
}
