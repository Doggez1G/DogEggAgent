import type { Message } from '@dogegg/bridge'

// LLM 级流事件：provider → agent loop 的底层流，表达「模型吐了什么」。
export type LlmStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thought_delta'; text: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argsJsonDelta: string }
  | { type: 'tool_call_end'; index: number; id: string; name: string; arguments: string }
  | { type: 'done'; message: Message }
  | { type: 'error'; error: Error }

export interface ChatRequest {
  baseURL: string
  apiKey: string
  model: string
  systemPrompt: string
  messages: Message[] // 仅 user / assistant / tool 历史；system 由 adapter 自行拼接
  tools: object[]
  maxOutput: number
  maxRetries: number
}

export interface ProviderAdapter {
  chat(req: ChatRequest, signal: AbortSignal, emit: (e: LlmStreamEvent) => void): Promise<Message>
}