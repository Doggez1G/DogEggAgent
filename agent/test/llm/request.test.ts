import { describe, it, expect } from 'vitest'
import { buildRequest } from '../../src/llm/provider/openai/request'

describe('buildRequest', () => {
  it('流式请求携带 stream_options.include_usage（真实用量链路的入口）', () => {
    const { init } = buildRequest(
      { model: 'm', systemPrompt: 's', messages: [], tools: [], maxOutput: 100, maxRetries: 0 },
      { baseURL: 'http://x/v1', apiKey: 'k' },
    )
    const body = JSON.parse(String(init.body))
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })
})
