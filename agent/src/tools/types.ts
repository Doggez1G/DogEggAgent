import type { z } from 'zod'

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  // 仅 shell 工具使用：配置里的解释器（如 cmd/powershell/bash），缺省按平台解析。
  shellProgram?: string
  // 仅 shell 工具使用：单命令超时毫秒数（超时杀进程树并把已有输出回填模型）。
  // 缺省 120s——交互式/常驻进程（游戏循环、dev server）不会自行退出，无超时会卡死整轮对话。
  shellTimeoutMs?: number
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