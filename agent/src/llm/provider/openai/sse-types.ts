// SSE 数据片段的最小类型形状（OpenAI chat.completions 流）。
// 全部字段可选——流式 chunk 只含增量，逐字段窄化，避免无类型 any。
export interface SseToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}
export interface SseChoiceDelta {
  content?: string
  // reasoning_content 是 OpenAI 官方字段（部分兼容端点用 reasoning），两者都尝试读取。
  reasoning_content?: string
  reasoning?: string
  tool_calls?: SseToolCallDelta[]
}
// usage：流式模式下随 stream_options:{include_usage:true} 在末尾 chunk 返回（choices 为空）。
export interface SseUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}
export interface SseChunk {
  choices?: { delta?: SseChoiceDelta }[]
  usage?: SseUsage
}
