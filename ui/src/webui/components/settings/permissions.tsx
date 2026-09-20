import { useEffect, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import type { Config, ToolListItem, UiPort } from '@dogegg/bridge'
import styles from './settings.module.css'

// 权限设置区（v2：桶 → 键 → 模式数组，空数组 = 整工具/整服务）——从 view.tsx 抽出的独立区块组件。
// 所有编辑 = 重算整桶对象 → config_set 桶路径（统一变更原语，天然原子 + 后端 validate/回滚兜底）。
// fail-closed 的编辑器补偿：添加/改名做非空 + 去重校验——模式写错不会报错只会静默不生效。
// 工具清单来自运行时事实（tools_request → tools_list，registry 是活的，MCP 运行期注册的
// 工具自动出现）。MCP 以服务为权限单元：选择器里是服务条目，服务键组内对运行时工具清单勾选；
// 权限引擎按注册期身份匹配服务键（bridge/permission.ts 服务键立法），与 LLM 可见名无关。

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

// 桶内一个键的规则组：组头（键名 + 摘要 + 移除）+ 模式 chips + 添加输入框。
// MCP 服务键额外渲染勾选 chips（serverTools = 该服务的运行时内部工具名清单）——
// 勾选/取消 = 数组增删内部工具名；手动 chips 只剩通配与遗留条目（含 * 或不在当前清单）。
// 删光模式 = 回到整键生效（不自动移除键——用户可能就要整桶生效）；移除按钮才删整个键。
function ToolPermGroup({ tool, patterns, onSetPatterns, onRemove, serverTools }: {
  tool: string
  patterns: string[]
  onSetPatterns: (next: string[]) => void
  onRemove: () => void
  serverTools?: string[]
}) {
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState(false)
  const isServer = serverTools !== undefined
  const toggleTool = (name: string): void => {
    if (patterns.includes(name)) onSetPatterns(patterns.filter((x) => x !== name))
    else onSetPatterns([...patterns, name])
  }
  const add = (): void => {
    const t = draft.trim()
    if (!t || patterns.includes(t)) { setInvalid(true); return }
    onSetPatterns([...patterns, t])
    setDraft('')
    setInvalid(false)
  }
  // 服务键的手动条目 = 通配（含 *）或运行时清单对不上的遗留条目；其余已在勾选 chips 里呈现。
  const manual = isServer ? patterns.filter((p) => p.includes('*') || !(serverTools ?? []).includes(p)) : patterns
  return (
    <div className={styles.permTool}>
      <div className={styles.permToolHeader}>
        <span className={styles.permToolName}>{tool}</span>
        <span className={styles.permToolSummary}>
          {isServer ? (patterns.length === 0 ? 'whole server' : `${patterns.length} tool rule(s)`) : (patterns.length === 0 ? 'whole tool' : `${patterns.length} pattern(s)`)}
        </span>
        <button className={styles.permToolRemove} onClick={onRemove} aria-label={`Remove ${tool}`}>
          <X size={11} strokeWidth={2} />
        </button>
      </div>
      {isServer && (serverTools ?? []).length > 0 && (
        <div className={styles.permChips}>
          {(serverTools ?? []).map((name) => {
            const checked = patterns.includes(name)
            return (
              <span key={name} className={styles.permChip} style={{ cursor: 'pointer', opacity: checked ? 1 : 0.55 }}
                onClick={() => toggleTool(name)} title={checked ? 'Click to exclude' : 'Click to include'}>
                <code className={styles.permChipEdit}>{checked ? '✓ ' : '· '}{name}</code>
              </span>
            )
          })}
        </div>
      )}
      {manual.length > 0 && (
        <div className={styles.permChips}>
          {manual.map((p) => (
            <PatternChip
              key={p}
              pattern={p}
              // patterns 全链路去重（添加/勾选均查重）——按值改名/删除即精确操作，无需索引映射。
              onRename={(v) => onSetPatterns(patterns.map((x) => (x === p ? v : x)))}
              onDelete={() => onSetPatterns(patterns.filter((x) => x !== p))}
            />
          ))}
        </div>
      )}
      <div className={styles.permAddWrap}>
        <input
          className={`${styles.permPatternInput} ${invalid ? styles.permPatternInputError : ''}`}
          placeholder={isServer
            ? (patterns.length === 0 ? '+ Add rule (switches to selected tools only)' : '+ Add tool name or wildcard, press Enter')
            : (patterns.length === 0 ? '+ Add pattern (switches to pattern-limited)' : '+ Add pattern, press Enter')}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setInvalid(false) }}
          onKeyDown={(e) => { if (e.key === 'Enter') add() }}
          onBlur={() => setInvalid(false)}
        />
      </div>
    </div>
  )
}

// 权限桶 = 可折叠卡片：头部（桶名 + 数量 + 箭头）常显，键组收在桶体内——
// 三桶默认全收起，摘要先行；键组是桶体内的嵌套子卡片，从属关系一眼可见。
// 添加下拉分两组：MCP 服务（服务 = 一个权限单元，整组生效）+ 内建工具逐个。
function BucketCard({ bucket, bucketMap, setBucket, toolsList, mcpServers }: {
  bucket: 'allow' | 'reject' | 'ask'
  bucketMap: Record<string, string[]>
  setBucket: (next: Record<string, string[]>) => void
  toolsList: ToolListItem[]
  mcpServers: { name: string }[]
}) {
  const [open, setOpen] = useState(false)
  const count = Object.keys(bucketMap).length
  // 服务清单 = 配置 mcpServers ⊕ 运行时身份（配置快照只含全局服务，项目级服务从运行时补齐）。
  const serverNames = new Set<string>(mcpServers.map((s) => s.name))
  const serverCounts = new Map<string, number>()
  for (const t of toolsList) {
    if (t.identity.kind !== 'mcp') continue
    serverNames.add(t.identity.server)
    serverCounts.set(t.identity.server, (serverCounts.get(t.identity.server) ?? 0) + 1)
  }
  // 服务键检测与该服务的运行时内部工具名（勾选 chips 的数据源；undefined = 非服务键）。
  const isServerKey = (key: string): boolean =>
    serverNames.has(key) || toolsList.some((t) => t.identity.kind === 'mcp' && t.identity.server === key)
  const serverToolNames = (key: string): string[] | undefined =>
    isServerKey(key)
      ? toolsList.flatMap((t) => (t.identity.kind === 'mcp' && t.identity.server === key ? [t.identity.name] : []))
      : undefined
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
              serverTools={serverToolNames(tool)}
              onSetPatterns={(next) => setBucket({ ...bucketMap, [tool]: next })}
              onRemove={() => {
                const next = { ...bucketMap }
                delete next[tool]
                setBucket(next)
              }}
            />
          ))}
          {count === 0 && <span className={styles.permEmpty}>No tools — add one below</span>}
          {/* 添加下拉：排除已在本桶的键（同一键可出现在多个桶——优先级语义的用途） */}
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
              {[...serverNames].filter((s) => !(s in bucketMap)).map((s) => {
                const n = serverCounts.get(s)
                return <option key={s} value={s}>{s} (MCP · {n === undefined ? 'offline' : `${n} tools`})</option>
              })}
              {toolsList.filter((t) => t.identity.kind === 'builtin' && !(t.name in bucketMap))
                .map((t) => <option key={t.name} value={t.name}>{t.name} — {t.description}</option>)}
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
  const [toolsList, setToolsList] = useState<ToolListItem[]>([])

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
          <BucketCard key={bucket} bucket={bucket} bucketMap={config.permission[bucket]} setBucket={(next) => setBucket(bucket, next)} toolsList={toolsList} mcpServers={config.mcpServers} />
        ))}
      </div>
    </>
  )
}
