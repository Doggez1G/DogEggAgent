import type { Config, ToolListItem } from '@dogegg/bridge'
import type { ConfigPath } from './navigation'
import type { Entry, TreeCtx } from './entries'
import { nan } from './label'
import { detectShells } from './shells'
import { THEMES, themeRegistry } from '../../theme'
import { KNOWN_TOOLS, describeBucketTool } from '../../../shared'

// 生成给定路径下的一层字段列表。依据 config + path 决定展示哪些字段、它们的交互形态。
// tools：运行时工具清单（tools_list 消息的镜像，身份随行）——权限桶选择器用它；缺省回退静态 KNOWN_TOOLS。
export function buildEntries(config: Config, path: ConfigPath, ctx: TreeCtx, tools?: ToolListItem[]): Entry[] {
  switch (path.kind) {
    case 'root':
      return [
        { label: 'systemPrompt', kind: 'scalar', value: config.systemPrompt ?? '', save: (v) => ctx.set('systemPrompt', v) },
        { label: 'defaultProvider', kind: 'goto', value: config.defaultProvider ?? '（未选择）', subPath: { kind: 'selectProvider' } },
        { label: 'defaultModel', kind: 'goto', value: config.defaultModel ?? '（未选择）', subPath: { kind: 'selectModel' } },
        { label: 'maxIterations', kind: 'scalar', value: config.maxIterations === -1 ? '-1（无限）' : String(config.maxIterations), save: (v) => ctx.set('maxIterations', nan(v)) },
        { label: 'maxRetries', kind: 'scalar', value: String(config.maxRetries), save: (v) => ctx.set('maxRetries', nan(v)) },
        { label: 'shellProgram', kind: 'goto', value: config.shellProgram || '（未选择）', subPath: { kind: 'selectShell' } },
        { label: 'theme', kind: 'goto', value: THEMES[themeRegistry.name]?.label ?? '默认', subPath: { kind: 'selectTheme' } },
        { label: 'permission', kind: 'goto', value: 'allow/reject/ask', subPath: { kind: 'permission' } },
        { label: 'providers', kind: 'goto', value: `${config.providers.length} 个`, subPath: { kind: 'providers' } },
        { label: 'skills', kind: 'action', value: '→ 管理面板（/skills）', run: () => ctx.openSkills?.() },
        { label: 'mcpServers', kind: 'action', value: '→ 管理面板（/mcp）', run: () => ctx.openMcp?.() },
      ]

    case 'permission':
      return [
        ...(['allow', 'reject', 'ask'] as const).map((b) => ({
          label: b,
          kind: 'goto' as const,
          value: `${Object.keys(config.permission[b]).length} 个工具`,
          subPath: { kind: 'permissionBucket', bucket: b } as ConfigPath,
        })),
        // 固定安全默认的只读说明行——不可编辑（default 不可配置是立法：防线不能被一行配置拆掉）。
        { label: '（未列出的工具一律询问——固定安全默认）', kind: 'action', value: '', run: () => {} },
      ]

    case 'permissionBucket': {
      // 桶内按键分组（v2：键 → 模式数组，空数组 = 整工具/整服务）。MCP 服务键带来源标注。
      const bucketName = path.bucket
      const bucket = config.permission[bucketName]
      const entries: Entry[] = Object.entries(bucket).map(([tool, patterns]) => {
        const isServer = isMcpServerKey(tool, config, tools)
        return {
          label: isServer ? `${tool}（MCP 服务）` : tool,
          kind: 'goto' as const,
          value: describeBucketEntry(patterns, isServer) + crossBucketHint(config, bucketName, tool),
          subPath: { kind: 'permissionTool', bucket: bucketName, tool } as ConfigPath,
          del: () => ctx.set(`permission.${bucketName}`, omitKey(bucket, tool)),
        }
      })
      entries.push({ label: '＋ 添加工具', kind: 'goto', value: '', subPath: { kind: 'selectTool', bucket: bucketName } })
      return entries
    }

    case 'permissionTool': {
      const bucket = config.permission[path.bucket]
      const patterns = bucket[path.tool] ?? []
      const setPatterns = (next: string[]): void =>
        ctx.set(`permission.${path.bucket}`, { ...bucket, [path.tool]: next })

      // MCP 服务键：勾选式细化——运行时身份枚举该服务的工具清单，回车勾选/取消（= 数组增删内部
      // 工具名）；通配与遗留条目（含 * 或不在当前清单，如服务下线前的精确名）渲染为可编辑行。
      // 参数模式对服务键不适用（MCP 无主参数概念——立法见 bridge/permission.ts）。
      if (isMcpServerKey(path.tool, config, tools)) {
        const runtimeTools = (tools ?? []).flatMap((t) =>
          t.identity.kind === 'mcp' && t.identity.server === path.tool ? [t.identity.name] : [])
        const entries: Entry[] = []
        if (runtimeTools.length === 0) {
          entries.push({ label: '（服务未运行或无工具清单——已保存规则按保存内容生效）', kind: 'action', value: '', run: () => {} })
        }
        // 两态提示：空数组 = 整组生效（所有工具都命中，与勾选行无关）；勾选任一工具即切换为按勾选生效。
        if (patterns.length === 0 && runtimeTools.length > 0) {
          entries.push({ label: '（当前整组生效——勾选任一工具将改为仅勾选项生效）', kind: 'action', value: '', run: () => {} })
        }
        for (const name of runtimeTools) {
          const checked = patterns.includes(name)
          entries.push({
            label: `${checked ? '✓' : '·'} ${name}`,
            kind: 'action',
            value: '',
            run: () => setPatterns(checked ? patterns.filter((x) => x !== name) : [...patterns, name]),
          })
        }
        for (const w of patterns.filter((p) => p.includes('*') || !runtimeTools.includes(p))) {
          entries.push({
            label: `＊ ${w}`,
            kind: 'scalar',
            value: w,
            save: (v) => {
              const t = v.trim()
              if (!t || t === w || patterns.includes(t)) return // 非空 + 去重（fail-closed 的编辑器补偿）
              setPatterns(patterns.map((x) => (x === w ? t : x)))
            },
            del: () => setPatterns(patterns.filter((x) => x !== w)),
          })
        }
        entries.push({ label: '＋ 添加通配（匹配该服务的内部工具名，如 browser_*）', kind: 'prompt', title: '输入精确工具名或通配（对内部工具名匹配，不涉参数）', save: (v) => {
          const t = v.trim()
          if (t && !patterns.includes(t)) setPatterns([...patterns, t])
        } })
        return entries
      }

      // 内建工具键：模式列表——空数组 = 整工具（显示两态转换提示），有模式 = 逐条就地编辑/删除。
      // 变更原语统一为「重算整桶对象 → config_set 桶路径」（设计 §3）。
      const entries: Entry[] = patterns.length === 0
        ? [{ label: '（整工具生效——添加模式后将改为按模式限定）', kind: 'action', value: '', run: () => {} }]
        : patterns.map((p, i) => ({
            label: p,
            kind: 'scalar' as const,
            value: p,
            save: (v) => {
              const t = v.trim()
              if (!t || t === p || patterns.includes(t)) return // 非空 + 去重（fail-closed 的编辑器补偿）
              setPatterns(patterns.map((x, j) => (j === i ? t : x)))
            },
            del: () => setPatterns(patterns.filter((_, j) => j !== i)), // 删光即回整工具
          }))
      entries.push({ label: '＋ 添加模式', kind: 'prompt', title: `输入模式（${path.tool} 主参数，支持 * ? **）`, save: (v) => {
        const t = v.trim()
        if (t && !patterns.includes(t)) setPatterns([...patterns, t])
      } })
      return entries
    }

    case 'providers': {
      const entries: Entry[] = config.providers.map((p, i) => ({
        label: p.name || '（未命名）',
        kind: 'goto' as const,
        value: p.baseURL || '（未填 baseURL）',
        subPath: { kind: 'provider', index: i } as ConfigPath,
        del: () => ctx.remove('providers', i),
      }))
      entries.push({ label: '＋ 添加 provider', kind: 'action', value: '', run: () => ctx.add('providers', { name: '', protocol: 'openai', baseURL: '', apiKey: '', models: [] }) })
      return entries
    }

    case 'provider': {
      const p = config.providers[path.index]
      if (!p) return []
      return [
        { label: 'name', kind: 'scalar', value: p.name, save: (v) => ctx.set(`providers.${path.index}.name`, v) },
        { label: 'protocol', kind: 'goto', value: `${p.protocol}（当前仅支持 openai）`, subPath: { kind: 'selectProtocol', index: path.index } as ConfigPath },
        { label: 'baseURL', kind: 'scalar', value: p.baseURL, save: (v) => ctx.set(`providers.${path.index}.baseURL`, v) },
        { label: 'apiKey', kind: 'scalar', value: p.apiKey, save: (v) => ctx.set(`providers.${path.index}.apiKey`, v) },
        { label: 'models', kind: 'goto', value: `${p.models.length} 个`, subPath: { kind: 'models', providerIndex: path.index } },
        { label: '删除此 provider', kind: 'action', value: '', run: () => ctx.remove('providers', path.index), del: () => ctx.remove('providers', path.index) },
      ]
    }

    case 'selectProtocol': {
      // 协议选择：当前仅支持 OpenAI 兼容协议——选项列表即支持矩阵的 UI 面，
      // 新增协议时在此扩展选项并注册对应 LLM client（schema enum 同步）。
      const supported = ['openai']
      const p = config.providers[path.index]
      return supported.map((proto) => ({
        label: proto,
        kind: 'action' as const,
        value: (p?.protocol ?? 'openai') === proto ? '✓' : '',
        run: () => ctx.set(`providers.${path.index}.protocol`, proto),
      }))
    }

    case 'models': {
      const p = config.providers[path.providerIndex]
      if (!p) return []
      const entries: Entry[] = p.models.map((m, i) => ({
        label: m.name || '（未命名）',
        kind: 'goto' as const,
        value: `${m.contextWindow} ctx`,
        subPath: { kind: 'model', providerIndex: path.providerIndex, modelIndex: i } as ConfigPath,
        del: () => ctx.remove('models', i, path.providerIndex),
      }))
      entries.push({ label: '＋ 添加 model', kind: 'action', value: '', run: () => ctx.add(`providers.${path.providerIndex}.models`, { name: '', contextWindow: 128000, maxOutput: 16384, reasoning: false }) })
      return entries
    }

    case 'model': {
      const p = config.providers[path.providerIndex]
      const m = p?.models[path.modelIndex]
      if (!p || !m) return []
      const base = `providers.${path.providerIndex}.models.${path.modelIndex}`
      return [
        { label: 'name', kind: 'scalar', value: m.name, save: (v) => ctx.set(`${base}.name`, v) },
        { label: 'contextWindow', kind: 'scalar', value: String(m.contextWindow), save: (v) => ctx.set(`${base}.contextWindow`, nan(v)) },
        { label: 'maxOutput', kind: 'scalar', value: String(m.maxOutput), save: (v) => ctx.set(`${base}.maxOutput`, nan(v)) },
        { label: 'reasoning', kind: 'bool', value: m.reasoning, save: (v) => ctx.set(`${base}.reasoning`, v) },
        { label: '删除此 model', kind: 'action', value: '', run: () => ctx.remove('models', path.modelIndex, path.providerIndex), del: () => ctx.remove('models', path.modelIndex, path.providerIndex) },
      ]
    }

    case 'selectProvider':
      return config.providers.map((p) => ({
        label: p.name || '（未命名）',
        kind: 'action' as const,
        value: '',
        run: () => ctx.set('defaultProvider', p.name),
      }))

    case 'selectModel': {
      const p = config.providers.find((x) => x.name === config.defaultProvider) ?? config.providers[0]
      if (!p) return [{ label: '（尚无 provider）', kind: 'action', value: '', run: () => {} }]
      return p.models.map((m) => ({
        label: m.name || '（未命名）',
        kind: 'action' as const,
        value: '',
        run: () => ctx.set('defaultModel', m.name),
      }))
    }

    case 'selectShell': {
      // 检测系统可用 shell + 提供手动输入选项。
      const shells = detectShells()
      const entries: Entry[] = shells.map((s) => ({
        label: s.label,
        kind: 'action' as const,
        value: config.shellProgram === s.value ? '✓' : '',
        run: () => ctx.set('shellProgram', s.value),
      }))
      entries.push({ label: '手动输入…', kind: 'prompt', title: 'shell 程序名', save: (v) => { const t = v.trim(); if (t) ctx.set('shellProgram', t) } })
      return entries
    }

    case 'selectTheme': {
      // 主题切换是纯 UI 偏好——不通过 config_set，直接调 setTheme。
      const current = themeRegistry.name
      return Object.entries(THEMES).map(([key, t]) => ({
        label: t.label,
        kind: 'action' as const,
        value: key === current ? '✓' : '',
        run: () => themeRegistry.set(key),
      }))
    }

    case 'selectTool': {
      // 候选 = MCP 服务逐个 + 内建工具逐个，加入即空数组（整键生效：服务 = 整组，工具 = 整工具）。
      // MCP 不再逐工具罗列——服务是一个权限单元（避免工具多时列表爆炸），逐工具细化在钻入视图勾选。
      // 服务清单 = 配置 mcpServers ⊕ 运行时身份（配置快照只含全局服务，项目级服务从运行时补齐）。
      // 排除已在当前桶中的键（避免重复添加）；同一键允许出现在多个桶（优先级语义的用途）。
      const bucket = config.permission[path.bucket]
      const entries: Entry[] = []

      const serverToolCount = new Map<string, number>()
      const serverNames = new Set<string>(config.mcpServers.map((s) => s.name))
      for (const t of tools ?? []) {
        if (t.identity.kind !== 'mcp') continue
        serverNames.add(t.identity.server)
        serverToolCount.set(t.identity.server, (serverToolCount.get(t.identity.server) ?? 0) + 1)
      }
      for (const name of serverNames) {
        if (name in bucket) continue
        const n = serverToolCount.get(name)
        entries.push({
          label: `${name}（MCP 服务 · ${n === undefined ? '未运行' : `${n} 个工具`}）`,
          kind: 'action',
          value: '',
          run: () => ctx.set(`permission.${path.bucket}`, { ...bucket, [name]: [] }),
        })
      }
      // 内建工具键：运行时清单的 builtin 身份；未播种（tools 缺省）回退静态 KNOWN_TOOLS。
      const builtinNames = tools
        ? tools.filter((t) => t.identity.kind === 'builtin').map((t) => t.name)
        : [...KNOWN_TOOLS]
      for (const name of builtinNames) {
        if (name in bucket) continue
        entries.push({
          label: name,
          kind: 'action',
          value: '',
          run: () => ctx.set(`permission.${path.bucket}`, { ...bucket, [name]: [] }),
        })
      }
      return entries
    }
  }
}

// ── permission 编辑的私有辅助 ──

// 桶键是否为 MCP 服务名：配置 mcpServers 清单 ⊕ 运行时身份中出现过的服务
//（权限引擎按身份匹配服务键——见 bridge/contract/permission.ts 的服务键立法）。
function isMcpServerKey(key: string, config: Config, tools?: ToolListItem[]): boolean {
  return config.mcpServers.some((s) => s.name === key) ||
    (tools ?? []).some((t) => t.identity.kind === 'mcp' && t.identity.server === key)
}

// 桶内键的摘要文案：内建工具 = 整工具/N 条模式（describeBucketTool）；MCP 服务键 = 整组/N 个工具规则。
function describeBucketEntry(patterns: string[], isServer: boolean): string {
  if (!isServer) return describeBucketTool(patterns)
  return patterns.length === 0 ? '整组（该服务所有工具）' : `${patterns.length} 个工具规则`
}

// 跨桶提示：同一工具在其它桶也有规则时提醒（防「已放行为什么还问我」的困惑——
// ask 规则优先于 allow 是判定语义，桶间互相独立呈现在配置里并不直观）。
function crossBucketHint(config: Config, from: 'allow' | 'reject' | 'ask', tool: string): string {
  const others = (['allow', 'reject', 'ask'] as const).filter((b) => b !== from && tool in config.permission[b])
  return others.length > 0 ? `（另在 ${others.join('/')} 桶有规则）` : ''
}

// 删除对象的一个键（不改变其余键）——桶内移除工具用。
function omitKey(bucket: Record<string, string[]>, key: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(bucket)) if (k !== key) out[k] = v
  return out
}
