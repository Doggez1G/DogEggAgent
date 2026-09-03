import type { Config } from '@dogegg/bridge'
import type { ConfigPath } from './navigation'
import type { Entry, TreeCtx } from './entries'
import { nan } from './label'
import { detectShells } from './shells'

// 生成给定路径下的一层字段列表。依据 config + path 决定展示哪些字段、它们的交互形态。
export function buildEntries(config: Config, path: ConfigPath, ctx: TreeCtx): Entry[] {
  switch (path.kind) {
    case 'root':
      return [
        { label: 'systemPrompt', kind: 'scalar', value: config.systemPrompt ?? '', save: (v) => ctx.set('systemPrompt', v) },
        { label: 'defaultProvider', kind: 'goto', value: config.defaultProvider ?? '（未选择）', subPath: { kind: 'selectProvider' } },
        { label: 'defaultModel', kind: 'goto', value: config.defaultModel ?? '（未选择）', subPath: { kind: 'selectModel' } },
        { label: 'maxIterations', kind: 'scalar', value: String(config.maxIterations), save: (v) => ctx.set('maxIterations', nan(v)) },
        { label: 'maxRetries', kind: 'scalar', value: String(config.maxRetries), save: (v) => ctx.set('maxRetries', nan(v)) },
        { label: 'shellProgram', kind: 'goto', value: config.shellProgram || '（未选择）', subPath: { kind: 'selectShell' } },
        { label: 'permission', kind: 'goto', value: 'allow/reject/ask', subPath: { kind: 'permission' } },
        { label: 'providers', kind: 'goto', value: `${config.providers.length} 个`, subPath: { kind: 'providers' } },
      ]

    case 'permission':
      return (['allow', 'reject', 'ask'] as const).map((b) => ({
        label: b,
        kind: 'goto' as const,
        value: `${config.permission[b].length} 个工具`,
        subPath: { kind: 'permissionBucket', bucket: b } as ConfigPath,
      }))

    case 'permissionBucket': {
      const bucket = path.bucket
      const tools = config.permission[bucket]
      return [
        ...tools.map((tool) => ({
          label: tool,
          kind: 'action' as const,
          value: '按 d 删 · 回车同样移除',
          run: () => ctx.set(`permission.${bucket}`, tools.filter((t) => t !== tool)),
          del: () => ctx.set(`permission.${bucket}`, tools.filter((t) => t !== tool)),
        })),
        { label: '＋ 添加工具', kind: 'prompt', title: '工具名', save: (v) => { const t = v.trim(); if (t && !tools.includes(t)) ctx.set(`permission.${bucket}`, [...tools, t]) } },
      ]
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
        { label: '删除此 provider', kind: 'action', value: '', run: () => ctx.remove('providers', path.index) },
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
        { label: '删除此 model', kind: 'action', value: '', run: () => ctx.remove('models', path.modelIndex, path.providerIndex) },
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
  }
}
