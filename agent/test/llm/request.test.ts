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

  it('maxOutput=-1（不设限）：省略 max_tokens 字段——直接下发 -1 会被严格实现判 400（P1-7）', () => {
    const { init } = buildRequest(
      { model: 'm', systemPrompt: 's', messages: [], tools: [], maxOutput: -1, maxRetries: 0 },
      { baseURL: 'http://x/v1', apiKey: 'k' },
    )
    const body = JSON.parse(String(init.body))
    expect('max_tokens' in body).toBe(false)
  })

  it('maxOutput 为正整数：照常携带 max_tokens', () => {
    const { init } = buildRequest(
      { model: 'm', systemPrompt: 's', messages: [], tools: [], maxOutput: 100, maxRetries: 0 },
      { baseURL: 'http://x/v1', apiKey: 'k' },
    )
    const body = JSON.parse(String(init.body))
    expect(body.max_tokens).toBe(100)
  })
})
