import { z } from 'zod'

export const modelSchema = z.object({
  name: z.string(),
  contextWindow: z.number().int().positive().default(128000),
  maxOutput: z.number().int().positive().default(16384),
  reasoning: z.boolean().default(false),
})

export const providerSchema = z.object({
  name: z.string(),
  protocol: z.literal('openai'),
  baseURL: z.string(),
  apiKey: z.string(),
  models: z.array(modelSchema).min(1),
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
  maxIterations: z.number().int().positive().default(50),
  maxRetries: z.number().int().min(0).default(3),
  permission: permissionSchema.default({ allow: [], reject: [], ask: [] }),
  providers: z.array(providerSchema).min(1),
})

export type Config = z.infer<typeof configSchema>
export type ProviderConfig = z.infer<typeof providerSchema>
export type ModelConfig = z.infer<typeof modelSchema>