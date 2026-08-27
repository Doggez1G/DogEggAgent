import type { z } from 'zod'

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  // 仅 shell 工具使用：配置里的解释器（如 cmd/powershell/bash），缺省按平台解析。
  shellProgram?: string
}

export type ToolResult = { content: string } | { error: string }

// 工具契约：schema 用于 zod 校验 LLM 返回的参数；parameters 是暴露给 LLM 的 OpenAI JSON schema。
export interface Tool {
  name: string
  description: string
  schema: z.ZodTypeAny
  parameters: Record<string, unknown>
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>
}