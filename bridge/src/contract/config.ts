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

// MCP server 配置（M4.2）：全局放 config.json 的 mcpServers 字段，项目级放 .dogegg/.mcp.json
// （同名 server 项目覆盖全局）。transport 判别联合——stdio（本地进程）与 http（远程 Streamable HTTP）。
// enabled=false 只停用不删除（调试时保留配置）。
export const mcpTransportSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.literal('http'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
])
export const mcpServerSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  transport: mcpTransportSchema,
})
export type McpServerConfig = z.infer<typeof mcpServerSchema>
export type McpTransport = z.infer<typeof mcpTransportSchema>

// ── 权限配置 v3：桶 → 键 → { whole, patterns } 结构化规则 ──
// 设计：ADR-0012/0013。三层分离：
// config.json（v3 结构化书写格式——唯一合法格式，配置演进不兼容原则见 ADR-0013）
//   → 内存 Config.permission（v3 形态，编辑器直接读写）
//   → 匹配引擎（contract/permission.ts 按 whole/patterns 求值）。
// 键 = 内建工具名或 MCP 服务裸名（服务键按注册期身份匹配，见 contract/permission.ts）。
// - whole: true → 整键命中（整工具/整组）；patterns 不参与匹配、仅作取消整选时的恢复内容；
// - whole: false → patterns 生效（OR 匹配）：内建键为主参数模式（path/command），
//   服务键为内部工具名/通配（工具启用匹配，永不涉参数）；
// - whole: false + 空数组 → 键存在但不命中任何规则（编辑中空选态）。
// 旧格式（M1 条目数组 / v2 字符串数组 / ** 标记）不受兼容——加载即报错并指引文档（bin/dogegg.ts）。

// 桶内单键规则。
const bucketRuleSchema = z.object({
  whole: z.boolean().default(false),
  patterns: z.array(z.string()).default([]),
})

// 主参数表（立法）：whole=false 时模式字符串对应工具的哪个参数。shell 的参数是 command，
// 其余文件类工具（read/write/edit/ls/glob/grep）的文件参数都叫 path。grouped 形态的固有简化——
// 未来新增主参数不是 path 的工具时需在此登记；表住 bridge 与归一化转换同居，三端共享同一解释。
export const PRIMARY_SPECIFIER: Record<string, 'path' | 'command'> = { shell: 'command' }

// 内建 path 主参数工具清单（立法）：作用域前缀校验只对这些键的 patterns 生效——只有它们的
// 条目才是路径模式（锚点语义才有意义）。MCP 服务键等其余键的 patterns 是工具名选择器
// （如 browser_close），不存在路径锚点语义，跳过校验。
export const BUILTIN_PATH_TOOLS = ['read_file', 'write_file', 'edit_file', 'ls', 'glob', 'grep'] as const

export function primarySpecifier(tool: string): 'path' | 'command' {
  return PRIMARY_SPECIFIER[tool] ?? 'path'
}

// 单键规则的内存/契约形态（UI 读写、引擎匹配共用）；Config.permission 的整体类型由
// permissionSchema 推导（见 contract/permission.ts 的 PermissionConfig）。
export type PermissionRule = z.infer<typeof bucketRuleSchema>

const permissionV3Schema = z.object({
  allow: z.record(z.string(), bucketRuleSchema).default({}),
  reject: z.record(z.string(), bucketRuleSchema).default({}),
  ask: z.record(z.string(), bucketRuleSchema).default({}),
})

// 权限 schema：v3 结构化形态（唯一合法格式）+ 作用域校验。
export const permissionSchema = permissionV3Schema.superRefine((p, ctx) => {
  // 作用域前缀校验（立法）：路径模式必须显式声明作用域——锚点（./、../、~/）、盘符（绝对），
  // 或以 * 开头（无锚点，glob 从文件系统根匹配：**/x 全盘任意深度、*/x 仅盘根一层）。
  // 字面量打头的裸模式（docs/**、test）从根匹配只能命中盘根条目，必然是忘了写锚点 → 拒绝加载。
  // 只对内建 path 工具生效（见 BUILTIN_PATH_TOOLS）——MCP 服务键等其余键的 patterns 是工具名
  // 选择器（如 browser_close），不存在路径锚点语义。shell 的 command 模式无作用域概念，不校验。
  // patterns 无论 whole 与否都校验——它们是规则的待命态（取消整选后生效），编写期就该正确。
  // 错误在 /config 编辑时也会经 validate/回滚浮出。
  for (const bucket of [p.allow, p.reject, p.ask]) {
    for (const [tool, rule] of Object.entries(bucket)) {
      if (!(BUILTIN_PATH_TOOLS as readonly string[]).includes(tool)) continue
      for (const pat of rule.patterns) {
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
  // v3 形态：whole = 整键生效。
  permission: permissionSchema.default({
    allow: {
      read_file: { whole: true, patterns: [] },
      ls: { whole: true, patterns: [] },
      glob: { whole: true, patterns: [] },
      grep: { whole: true, patterns: [] },
    },
    reject: {},
    ask: {
      write_file: { whole: true, patterns: [] },
      edit_file: { whole: true, patterns: [] },
      shell: { whole: true, patterns: [] },
    },
  }),
  // MCP server 列表（/mcp 面板与 .dogegg/.mcp.json 共用同一 schema；变更即重启对应 server）。
  mcpServers: z.array(mcpServerSchema).default([]),
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