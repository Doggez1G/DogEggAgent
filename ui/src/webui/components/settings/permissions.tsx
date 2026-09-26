import { useEffect, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import type { Config, PermissionRule, ToolListItem, UiPort } from '@dogegg/bridge'
import { safeSettingsPost } from './safe-post'
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

// 桶内一个键的规则组：组头（键名 + 摘要 + 移除）+ 整选开关 + 模式 chips + 添加输入框。
// 整选开关（v3 立法，与 TUI 同构）：whole 是显式字段——空选（whole:false + 无模式）可表达，
// 开关恒可用、状态恒与引擎一致；切回整选保留全部规则，取消整选原样恢复（引擎零特判）。
// MCP 服务键额外渲染勾选 chips（serverTools = 该服务的运行时内部工具名清单）——
// 勾选/取消 = 增删内部工具名；手动 chips 只剩通配与遗留条目（含 * 或不在当前清单）。
function ToolPermGroup({ tool, rule, onSetRule, onRemove, serverTools }: {
  tool: string
  rule: PermissionRule
  onSetRule: (next: PermissionRule) => void
  onRemove: () => void
  serverTools?: string[]
}) {
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState(false)
  const patterns = rule.patterns
  const isServer = serverTools !== undefined
  const toggleWhole = (): void => onSetRule({ ...rule, whole: !rule.whole })
  const toggleTool = (name: string): void => {
    if (patterns.includes(name)) onSetRule({ ...rule, patterns: patterns.filter((x) => x !== name) })
    else onSetRule({ ...rule, patterns: [...patterns, name] })
  }
  const add = (): void => {
    const t = draft.trim()
    if (!t || patterns.includes(t)) { setInvalid(true); return }
    onSetRule({ ...rule, patterns: [...patterns, t] })
    setDraft('')
    setInvalid(false)
  }
  // 服务键的手动条目 = 通配（含 *）或运行时清单对不上的遗留条目；其余已在勾选 chips 里呈现。
  const manual = isServer ? patterns.filter((p) => p.includes('*') || !(serverTools ?? []).includes(p)) : patterns
  return (
    <div className={styles.permTool}>
      <div className={styles.permToolHeader}>
        <span className={styles.permToolName}>{tool.startsWith('mcp:') ? tool.slice(4) : tool}</span>
        <span className={styles.permToolSummary}>
          {rule.whole
            ? (isServer ? 'whole server' : 'whole tool')
            : (patterns.length === 0 ? 'no rules selected' : (isServer ? `${patterns.length} tool rule(s)` : `${patterns.length} pattern(s)`))}
        </span>
        <button className={styles.permToolRemove} onClick={onRemove} aria-label={`Remove ${tool}`}>
          <X size={11} strokeWidth={2} />
        </button>
      </div>
      <div className={styles.permChips}>
        <span className={styles.permChip} style={{ cursor: 'pointer' }} onClick={toggleWhole}
          title={rule.whole ? 'Click to uncheck — edit rules below' : 'Click to check — current rules are kept'}>
          <code className={styles.permChipEdit}>{rule.whole ? '✓ ' : '· '}{isServer ? 'Whole server' : 'Whole tool'}</code>
        </span>
      </div>
      {isServer && (serverTools ?? []).length > 0 && (
        <div className={styles.permChips}>
          {(serverTools ?? []).map((name) => {
            const checked = patterns.includes(name)
            return (
              <span key={name} className={styles.permChip} style={{ cursor: rule.whole ? 'default' : 'pointer', opacity: rule.whole ? 0.5 : checked ? 1 : 0.55 }}
                onClick={() => { if (!rule.whole) toggleTool(name) }} title={rule.whole ? 'Whole server is checked — uncheck it to edit' : checked ? 'Click to exclude' : 'Click to include'}>
                <code className={styles.permChipEdit}>{checked ? '✓ ' : '· '}{name}</code>
              </span>
            )
          })}
        </div>
      )}
      {manual.length > 0 && (
        <div className={styles.permChips} style={{ opacity: rule.whole ? 0.5 : 1 }}>
          {manual.map((p) => (
            <PatternChip
              key={p}
              pattern={p}
              // patterns 全链路去重（添加/勾选均查重）——按值改名/删除即精确操作，无需索引映射。
              onRename={(v) => { if (!rule.whole) onSetRule({ ...rule, patterns: patterns.map((x) => (x === p ? v : x)) }) }}
              onDelete={() => { if (!rule.whole) onSetRule({ ...rule, patterns: patterns.filter((x) => x !== p) }) }}
            />
          ))}
        </div>
      )}
      {!rule.whole && (
        <div className={styles.permAddWrap}>
          <input
            className={`${styles.permPatternInput} ${invalid ? styles.permPatternInputError : ''}`}
            placeholder={isServer
              ? '+ Add tool name or wildcard, press Enter'
              : '+ Add pattern, press Enter'}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setInvalid(false) }}
            onKeyDown={(e) => { if (e.key === 'Enter') add() }}
            onBlur={() => setInvalid(false)}
          />
        </div>
      )}
    </div>
  )
}

// 权限桶 = 可折叠卡片：头部（桶名 + 数量 + 箭头）常显，键组收在桶体内——
// 三桶默认全收起，摘要先行；键组是桶体内的嵌套子卡片，从属关系一眼可见。
// 添加下拉分两组：MCP 服务（服务 = 一个权限单元，整组生效）+ 内建工具逐个。
function BucketCard({ bucket, bucketMap, setBucket, toolsList, mcpServers }: {
  bucket: 'allow' | 'reject' | 'ask'
  bucketMap: Record<string, PermissionRule>
  setBucket: (next: Record<string, PermissionRule>) => void
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
  // 服务键检测（v3 立法：服务键一律带 `mcp:` 前缀，语法自明）。
  const isServerKey = (key: string): boolean => key.startsWith('mcp:')
  const serverToolNames = (key: string): string[] | undefined => {
    if (!isServerKey(key)) return undefined
    const server = key.slice(4)
    return toolsList.flatMap((t) => (t.identity.kind === 'mcp' && t.identity.server === server ? [t.identity.name] : []))
  }
  return (
    <div className={styles.permCard}>
      <button type="button" className={styles.permCardHeader} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={styles.permName} data-bucket={bucket}>{bucket}</span>
        <span className={styles.permCount}>{count} tool(s)</span>
        <ChevronDown size={13} strokeWidth={2} className={styles.permCardChevron} data-open={open} />
      </button>
      {open && (
        <div className={styles.permCardBody}>
          {Object.entries(bucketMap).map(([tool, rule]) => (
            <ToolPermGroup
              key={tool}
              tool={tool}
              rule={rule}
              serverTools={serverToolNames(tool)}
              onSetRule={(next) => setBucket({ ...bucketMap, [tool]: next })}
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
                if (v) setBucket({ ...bucketMap, [v]: { whole: true, patterns: [] } })
              }}
            >
              <option value="">+ Add tool...</option>
              {[...serverNames].map((s) => {
                const key = `mcp:${s}` // v3 立法：服务键带 mcp: 前缀（键空间与内建工具名正交）
                if (key in bucketMap) return null
                const n = serverCounts.get(s)
                return <option key={key} value={key}>{s} (MCP · {n === undefined ? 'offline' : `${n} tools`})</option>
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
  // P2-35：与 General/Models 同款 inlineError——此前 safeSettingsPost 未传 onFail，
  // 权限桶提交失败只有 console.warn，用户以为已生效（fail-closed 下后果更重）。
  const [inlineError, setInlineError] = useState('')
  const post = (msg: Parameters<typeof safeSettingsPost>[1]): void => {
    setInlineError('')
    safeSettingsPost(port, msg, (e) => setInlineError(`保存失败：${e.message}`))
  }

  // 工具清单走运行时事实：挂载即请求 tools_request，订阅 tools_list。
  // WebUI 特征各自订阅 port 是既定模式（多订阅合法）；卸载时退订。
  useEffect(() => {
    const off = port.onMessage((m) => {
      if (m.type === 'tools_list') setToolsList(m.tools)
    })
    void port.post({ type: 'tools_request' })
    return off
  }, [port])

  const setBucket = (bucket: 'allow' | 'reject' | 'ask', next: Record<string, PermissionRule>): void => {
    // 安全提交走 post（safeSettingsPost + onFail → inlineError，P2-35）；后端 zod 校验仍兜底非法值。
    post({ type: 'config_set', path: `permission.${bucket}`, value: next })
  }
  return (
    <>
      <div className={styles.sectionTitle}>Permissions</div>
      <div className={styles.sectionDesc}>
        Unlisted tools always ask (fixed safe default). "Whole tool/server" matches everything;
        unchecking it limits the rule to selected tools / patterns (e.g. "git *" for shell,
        "./docs/**" for file paths, "browser_*" for MCP internal tool names).
      </div>
      {inlineError && <div style={{ color: 'var(--color-danger)', fontSize: 12, marginBottom: 8 }}>{inlineError}</div>}
      <div className={styles.permList}>
        {buckets.map((bucket) => (
          <BucketCard key={bucket} bucket={bucket} bucketMap={config.permission[bucket]} setBucket={(next) => setBucket(bucket, next)} toolsList={toolsList} mcpServers={config.mcpServers} />
        ))}
      </div>
    </>
  )
}
