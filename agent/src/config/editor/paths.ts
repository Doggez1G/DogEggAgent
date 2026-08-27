import type { ProviderConfig, ModelConfig } from '@dogegg/bridge'

// config_set 的点号路径文法解析。路径约定（与 config_add/remove 的 index 语义一致）：
//   'defaultProvider' | 'defaultModel' | 'maxIterations' | 'maxRetries' | 'systemPrompt' | 'shellProgram'
//   'permission.allow' | 'permission.reject' | 'permission.ask'
//   'providers.<index>.<field>'，field ∈ { name, baseURL, apiKey }
//   'providers.<index>.models.<modelIndex>.<field>'，field ∈ { name, contextWindow, maxOutput, reasoning }
// 用 discriminated union 把路径解析成强类型操作，取代旧代码 applyConfigSet 里的手写 split 梯子。
export type ConfigSetOp =
  | { kind: 'top'; field: 'defaultProvider' | 'defaultModel' | 'maxIterations' | 'maxRetries' | 'systemPrompt' | 'shellProgram'; value: string | number }
  | { kind: 'permission'; bucket: 'allow' | 'reject' | 'ask'; value: string[] }
  | { kind: 'provider'; index: number; field: 'name' | 'baseURL' | 'apiKey'; value: string }
  | { kind: 'model'; providerIndex: number; modelIndex: number; field: 'name' | 'contextWindow' | 'maxOutput' | 'reasoning'; value: string | number | boolean }

const TOP_FIELDS = ['defaultProvider', 'defaultModel', 'maxIterations', 'maxRetries', 'systemPrompt', 'shellProgram'] as const
const PROVIDER_FIELDS = ['name', 'baseURL', 'apiKey'] as const
const MODEL_FIELDS = ['name', 'contextWindow', 'maxOutput', 'reasoning'] as const

function isTopField(s: string): s is typeof TOP_FIELDS[number] {
  return (TOP_FIELDS as readonly string[]).includes(s)
}
function isProviderField(s: string): s is typeof PROVIDER_FIELDS[number] {
  return (PROVIDER_FIELDS as readonly string[]).includes(s)
}
function isModelField(s: string): s is typeof MODEL_FIELDS[number] {
  return (MODEL_FIELDS as readonly string[]).includes(s)
}

// 解析 config_set 路径。返回 null 表示路径非法（调用方应忽略）。
export function parseConfigSet(path: string, value: unknown): ConfigSetOp | null {
  const seg = path.split('.')

  // 单段顶层标量
  if (seg.length === 1 && isTopField(path)) {
    if (path === 'maxIterations' || path === 'maxRetries') return { kind: 'top', field: path, value: value as number }
    return { kind: 'top', field: path, value: value as string }
  }
  // permission.<bucket>
  if (seg.length === 2 && seg[0] === 'permission') {
    const bucket = seg[1]!
    if (bucket === 'allow' || bucket === 'reject' || bucket === 'ask') return { kind: 'permission', bucket, value: value as string[] }
    return null
  }
  // providers.<i>.<field>
  if (seg.length === 3 && seg[0] === 'providers') {
    const idx = Number(seg[1])
    const field = seg[2]!
    if (!Number.isInteger(idx) || idx < 0 || !isProviderField(field)) return null
    return { kind: 'provider', index: idx, field, value: value as string }
  }
  // providers.<i>.models.<j>.<field>
  if (seg.length === 5 && seg[0] === 'providers' && seg[2] === 'models') {
    const pi = Number(seg[1]); const mi = Number(seg[3]); const field = seg[4]!
    if (!Number.isInteger(pi) || pi < 0 || !Number.isInteger(mi) || mi < 0 || !isModelField(field)) return null
    if (field === 'reasoning') return { kind: 'model', providerIndex: pi, modelIndex: mi, field, value: value as boolean }
    if (field === 'name') return { kind: 'model', providerIndex: pi, modelIndex: mi, field, value: value as string }
    return { kind: 'model', providerIndex: pi, modelIndex: mi, field, value: value as number }
  }
  return null
}

export type ConfigAddOp =
  | { kind: 'provider'; value: ProviderConfig }
  | { kind: 'model'; providerIndex: number; value: ModelConfig }

// config_add：'providers' 追加 provider；'providers.<i>.models' 追加 model。
export function parseConfigAdd(path: string, value: unknown): ConfigAddOp | null {
  if (path === 'providers') return { kind: 'provider', value: value as ProviderConfig }
  const seg = path.split('.')
  if (seg.length === 3 && seg[0] === 'providers' && seg[2] === 'models') {
    const idx = Number(seg[1])
    if (!Number.isInteger(idx) || idx < 0) return null
    return { kind: 'model', providerIndex: idx, value: value as ModelConfig }
  }
  return null
}
