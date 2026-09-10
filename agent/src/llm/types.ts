import type { Message } from '@dogegg/bridge'

// LLM 级流事件：provider → agent loop 的底层流，表达「模型吐了什么」。
export type LlmStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thought_delta'; text: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argsJsonDelta: string }
  | { type: 'tool_call_end'; index: number; id: string; name: string; arguments: string }
  | { type: 'done'; message: Message; reasoning?: string; usage?: LlmUsage }
  | { type: 'error'; error: Error }

// 单次对话请求。连接参数（baseURL/apiKey）归 LlmClient 实例所有，不随请求传递；
// maxRetries 保留在请求级——压缩摘要等离线调用会用更激进的重试策略。
export interface ChatRequest {
  model: string
  systemPrompt: string
  messages: Message[] // 仅 user / assistant / tool 历史；system 由 client 自行拼接
  tools: object[]
  maxOutput: number
  maxRetries: number
}

// 归一化的用量统计（OpenAI snake_case 字段在 parser 转换为 camelCase）。
// 精确值来自 API 返回——与本地粗估（context/token/estimate.ts）并排展示可见校准误差。
export interface LlmUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface ChatResult {
  message: Message
  /** 推理模型的思考内容（reasoning），供持久化用——不进 history/context。 */
  reasoning?: string
  /** 本次调用的真实用量（stream_options.include_usage），供轮次累计与会话统计。 */
  usage?: LlmUsage
}

// 客户端连接参数：构造 OpenAiClient 等 LlmClient 实例时注入。
export interface LlmClientConn {
  baseURL: string
  apiKey: string
}

// LLM 客户端接口：一个协议一个实现（openai → OpenAiClient）。
export interface LlmClient {
  chat(req: ChatRequest, signal: AbortSignal, emit: (e: LlmStreamEvent) => void): Promise<ChatResult>
}
