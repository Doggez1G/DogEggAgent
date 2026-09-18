import type { Config } from '@dogegg/bridge'
import type { ConfigPath } from './navigation'
import type { Entry, TreeCtx } from './entries'
import { nan } from './label'
import { detectShells } from './shells'
import { THEMES, themeRegistry } from '../../theme'
import { KNOWN_TOOLS, describeBucketTool } from '../../../shared'

// 生成给定路径下的一层字段列表。依据 config + path 决定展示哪些字段、它们的交互形态。
// tools：运行时工具清单（tools_list 消息的镜像）——权限桶选择器用它；缺省回退静态 KNOWN_TOOLS。
export function buildEntries(config: Config, path: ConfigPath, ctx: TreeCtx, tools?: { name: string; description: string }[]): Entry[] {
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
      // 桶内按工具分组（v2：工具 → 模式数组，空数组 = 整工具）。
      const bucketName = path.bucket
      const bucket = config.permission[bucketName]
      const entries: Entry[] = Object.entries(bucket).map(([tool, patterns]) => ({
        label: tool,
        kind: 'goto' as const,
        value: describeBucketTool(patterns) + crossBucketHint(config, bucketName, tool),
        subPath: { kind: 'permissionTool', bucket: bucketName, tool } as ConfigPath,
        del: () => ctx.set(`permission.${bucketName}`, omitKey(bucket, tool)),
      }))
      entries.push({ label: '＋ 添加工具', kind: 'goto', value: '', subPath: { kind: 'selectTool', bucket: bucketName } })
      return entries
    }

    case 'permissionTool': {
      // 工具的模式列表：空数组 = 整工具（显示两态转换提示），有模式 = 逐条就地编辑/删除。
      // 变更原语统一为「重算整桶对象 → config_set 桶路径」（设计 §3）。
      const bucket = config.permission[path.bucket]
      const patterns = bucket[path.tool] ?? []
      const setPatterns = (next: string[]): void =>
        ctx.set(`permission.${path.bucket}`, { ...bucket, [path.tool]: next })
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
        { label: 'baseURL', kind: 'scalar', value: p.baseURL, save: (v) => ctx.set(`providers.${path.index}.baseURL`, v) },
        { label: 'apiKey', kind: 'scalar', value: p.apiKey, save: (v) => ctx.set(`providers.${path.index}.apiKey`, v) },
        { label: 'models', kind: 'goto', value: `${p.models.length} 个`, subPath: { kind: 'models', providerIndex: path.index } },
        { label: '删除此 provider', kind: 'action', value: '', run: () => ctx.remove('providers', path.index), del: () => ctx.remove('providers', path.index) },
      ]
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
      // 从运行时工具清单中选择——排除已在当前桶中的工具（避免重复添加）。
      // 加入即空数组（整工具生效）；同一工具允许出现在多个桶（优先级语义的用途）。
      const bucket = config.permission[path.bucket]
      const names = tools?.map((t) => t.name) ?? [...KNOWN_TOOLS]
      return names
        .filter((t) => !(t in bucket))
        .map((t) => ({
          label: t,
          kind: 'action' as const,
          value: '',
          run: () => ctx.set(`permission.${path.bucket}`, { ...bucket, [t]: [] }),
        }))
    }
  }
}

// ── permission 编辑的私有辅助 ──

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
