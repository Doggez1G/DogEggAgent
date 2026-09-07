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

export const permissionSchema = z.object({
  allow: z.array(z.string()).default([]),
  reject: z.array(z.string()).default([]),
  ask: z.array(z.string()).default([]),
})

export const configSchema = z.object({
  systemPrompt: z.string().optional(),
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  // 对话最大轮次：-1 = 无限（默认，靠取消/错误终止）；正整数 = 上限（无人值守批处理用）。0 非法。
  maxIterations: z.number().int().refine((n) => n === -1 || n >= 1).default(-1),
  maxRetries: z.number().int().min(0).default(3),
  shellProgram: z.string().optional(),
  permission: permissionSchema.default({ allow: [], reject: [], ask: [] }),
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