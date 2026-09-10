import { z } from 'zod'

// 模型/提供商字段在校验层刻意放宽（name/baseURL/apiKey/models 允许暂时为空），
// 以支持 /config 里「自由创建节点、逐字段填写」的编辑流程。
// 能否真正对话由 isConfigured() 做完整性判定，而非 schema 强制非空。

export const modelSchema = z.object({
  name: z.string(),
  contextWindow: z.number().int().positive().default(128000),
  maxOutput: z.number().int().positive().default(16384),
  reasoning: z.boolean().default(false),
})

export const providerSchema = z.object({
  name: z.string(),
  protocol: z.enum(['openai']),
  baseURL: z.string(),
  apiKey: z.string(),
  models: z.array(modelSchema).default([]),
})

// 参数化权限规则：{ tool: 精确名或通配 } + 任意个限定键（值 = 参数模式，键名镜像工具自己的 zod schema
// 字段，如 read_file 的 path、shell 的 command）。全部限定键命中才算规则命中（见 contract/permission.ts）。
// 限定键经 catchall 强制为字符串——规则对象里塞非字符串值属配置错误，load 期即拒绝。
// { tool } 单键合法（退化为整工具规则）——宽松于报错：配置里手写一半的规则仍能按预期兜底。
export const toolRuleSchema = z.object({ tool: z.string() }).catchall(z.string())

// 三桶条目 union：裸字符串（整工具，兼容旧配置）或参数化规则对象。
export const permissionEntrySchema = z.union([z.string(), toolRuleSchema])

export type ToolRule = z.infer<typeof toolRuleSchema>
export type PermissionEntry = z.infer<typeof permissionEntrySchema>

// ── 权限配置 v2：桶 → 工具 → 模式数组（空数组 = 整工具）──
// 设计：2026-09-09-permission-config-design.md。三层分离：
// config.json（v2 grouped 书写格式；legacy 扁平条目数组加载兼容、保存统一写 v2）
//   → 内存 Config.permission（v2 grouped，编辑器直接读写）
//   → 匹配引擎（contract/permission.ts 按 grouped 逐桶求值，与 M1 判定语义完全一致）。
// 模式字符串对应工具的主参数（primarySpecifier，见 permission.ts）：shell → command，其余 → path。

// v2 桶形态：工具名 → 模式数组。空数组 = 整工具生效（引擎按零限定键规则处理）。
const bucketMapSchema = z.record(z.string(), z.array(z.string()))

// 主参数表（立法）：v2 形态里模式字符串对应工具的哪个参数。shell 的参数是 command，其余文件类
// 工具（read/write/edit/ls/glob/grep）的文件参数都叫 path。grouped 形态的固有简化——
// 未来新增主参数不是 path 的工具时需在此登记；表住 bridge 与归一化转换同居，三端共享同一解释。
export const PRIMARY_SPECIFIER: Record<string, 'path' | 'command'> = { shell: 'command' }

export function primarySpecifier(tool: string): 'path' | 'command' {
  return PRIMARY_SPECIFIER[tool] ?? 'path'
}

const permissionV2Schema = z.object({
  allow: bucketMapSchema.default({}),
  reject: bucketMapSchema.default({}),
  ask: bucketMapSchema.default({}),
})

// legacy（M1）：三桶条目数组（裸工具名字符串或 { tool, ...参数模式 } 规则对象）。仅加载兼容用。
const permissionLegacySchema = z.object({
  allow: z.array(permissionEntrySchema).default([]),
  reject: z.array(permissionEntrySchema).default([]),
  ask: z.array(permissionEntrySchema).default([]),
})

// legacy 条目数组 → v2 桶映射：字符串 → 空数组（整工具）；规则对象 → 主参数模式值（无主参数键 → 空数组）。
// 同工具多条规则合并（patterns 拼接），不做覆盖——legacy 里同一工具可以出现多条。
export function entriesToBucket(entries: PermissionEntry[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const e of entries) {
    if (typeof e === 'string') {
      if (!(e in out)) out[e] = []
      continue
    }
    const primary = primarySpecifier(e.tool)
    const v = e[primary]
    out[e.tool] = [...(out[e.tool] ?? []), ...(typeof v === 'string' ? [v] : [])]
  }
  return out
}

// v2 权限配置的内存形态（Config.permission 的类型）：三桶 → 工具 → 模式数组。
export type PermissionConfigV2 = {
  allow: Record<string, string[]>
  reject: Record<string, string[]>
  ask: Record<string, string[]>
}

// union + 显式返回类型标注：legacy 输入在加载期归一为 v2；v2 输入原样通过。
// Array.isArray 判别书写形态（legacy 的桶是条目数组，v2 的桶是对象映射）。
export const permissionSchema = z.union([permissionV2Schema, permissionLegacySchema])
  .transform((p): PermissionConfigV2 => {
    if (Array.isArray((p as { allow: unknown }).allow)) {
      const legacy = p as z.infer<typeof permissionLegacySchema>
      return {
        allow: entriesToBucket(legacy.allow),
        reject: entriesToBucket(legacy.reject),
        ask: entriesToBucket(legacy.ask),
      }
    }
    return p as PermissionConfigV2
  })
  .superRefine((p, ctx) => {
    // 作用域前缀校验（立法）：路径模式必须显式声明作用域——锚点（./、../、~/）、盘符（绝对），
    // 或以 * 开头（无锚点，glob 从文件系统根匹配：**/x 全盘任意深度、*/x 仅盘根一层）。
    // 字面量打头的裸模式（docs/**、test）从根匹配只能命中盘根条目，必然是忘了写锚点 → 拒绝加载。
    // shell 的 command 模式无作用域概念，不校验。错误在 /config 编辑时也会经 validate/回滚浮出。
    for (const bucket of [p.allow, p.reject, p.ask]) {
      for (const [tool, patterns] of Object.entries(bucket)) {
        if (primarySpecifier(tool) !== 'path') continue
        for (const pat of patterns) {
          const unified = pat.replace(/\\/g, '/')
          const ok = /^(\.\.\/|\.\/|~\/|\*)/.test(unified) || /^[a-zA-Z]:\//.test(unified) || unified.startsWith('/')
          if (!ok) {
            ctx.addIssue({
              code: 'custom',
              message: `权限模式 "${pat}"（${tool}）缺少作用域前缀——以 ./ 或 ../（cwd）、~/（主目录）、*（任意位置，如 **/x）或盘符（绝对路径）开头`,
            })
          }
        }
      }
    }
  })

export const configSchema = z.object({
  systemPrompt: z.string().optional(),
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  // 对话最大轮次：-1 = 无限（默认，靠取消/错误终止）；正整数 = 上限（无人值守批处理用）。0 非法。
  maxIterations: z.number().int().refine((n) => n === -1 || n >= 1).default(-1),
  maxRetries: z.number().int().min(0).default(3),
  shellProgram: z.string().optional(),
  // 出厂默认权限（设计 §4.1）：读类工具放行（只读安全、探索顺畅的前提），写类/命令默认 ask。
  // 仅对「配置文件未写 permission 字段」的加载生效；用户显式配置的三桶不受影响。
  // v2 形态：空数组 = 整工具。
  permission: permissionSchema.default({
    allow: { read_file: [], ls: [], glob: [], grep: [] },
    reject: {},
    ask: { write_file: [], edit_file: [], shell: [] },
  }),
  providers: z.array(providerSchema).default([]),
})

export type Config = z.infer<typeof configSchema>
export type ProviderConfig = z.infer<typeof providerSchema>
export type ModelConfig = z.infer<typeof modelSchema>

// 是否「已配置到可以提问」：至少有一个完整 provider，且 defaultProvider/defaultModel 能解析到非空模型。
export function isConfigured(config: Config): boolean {
  const provider = config.providers.find((p) => p.name === config.defaultProvider) ?? config.providers[0]
  if (!provider) return false
  if (!provider.name.trim() || !provider.baseURL.trim() || !provider.apiKey.trim() || provider.models.length === 0) return false
  const model = provider.models.find((m) => m.name === config.defaultModel) ?? provider.models[0]
  return !!model && !!model.name.trim()
}