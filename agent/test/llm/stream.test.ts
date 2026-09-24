import { describe, it, expect, vi, afterEach } from 'vitest'
import { OpenAiClient } from '../../src/llm'
import { streamOnce } from '../../src/llm/provider/openai/stream'
import type { LlmStreamEvent, ChatRequest, LlmClientConn } from '../../src/llm'

// streamOnce / OpenAiClient 的网络层单测：stub 全局 fetch，用 ReadableStream 构造 SSE 响应。

const conn: LlmClientConn = { baseURL: 'http://fake/v1', apiKey: 'k' }
const req: ChatRequest = { model: 'm', systemPrompt: 's', messages: [], tools: [], maxOutput: 100, maxRetries: 1 }

// 构造 SSE 响应：chunks 逐段入流，保留 chunk 边界（跨 chunk 的行/字符分割测试依赖它）。
function sseResponse(chunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch)
      c.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('streamOnce — HTTP 错误响应体（!res.ok 路径）', () => {
  it('401 + JSON 错误体：HttpError message 含状态码与服务端 error.message', async () => {
    vi.stubGlobal('fetch', async () => new Response(
      JSON.stringify({ error: { message: 'Invalid API key provided' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ))
    const err = await streamOnce(conn, req, new AbortController().signal, () => {}).then(() => null, (e) => e)
    expect(err.name).toBe('HttpError')
    expect(err.status).toBe(401)
    expect(err.message).toContain('401')
    expect(err.message).toContain('Invalid API key provided')
  })

  it('非 JSON 错误体：用原文截断进 message（网关 HTML/纯文本报错也能自查）', async () => {
    vi.stubGlobal('fetch', async () => new Response('plain gateway down', { status: 502 }))
    const err = await streamOnce(conn, req, new AbortController().signal, () => {}).then(() => null, (e) => e)
    expect(err.status).toBe(502)
    expect(err.message).toContain('plain gateway down')
  })

  it('throw 前移除用户 abort 监听（错误路径不留悬挂监听）', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":{"message":"x"}}', { status: 401 }))
    const ctrl = new AbortController()
    const removeSpy = vi.spyOn(ctrl.signal, 'removeEventListener')
    await streamOnce(conn, req, ctrl.signal, () => {}).catch(() => {})
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})

describe('OpenAiClient.chat — 请求层重试发 stream_reset', () => {
  it('第 2 次尝试开始前发出 stream_reset（第 1 次不发），reset 后的增量正常送达', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      if (calls === 1) {
        // 429 + retry-after: 0——可重试且退避为 0ms（测试不等待）。
        return new Response('{"error":{"message":"rate limited"}}', { status: 429, headers: { 'retry-after': '0' } })
      }
      return sseResponse([
        new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'),
        new TextEncoder().encode('data: [DONE]\n\n'),
      ])
    })
    const client = new OpenAiClient(conn)
    const events: LlmStreamEvent[] = []
    const result = await client.chat(req, new AbortController().signal, (e) => events.push(e))
    expect(result.message.content).toBe('ok')
    // 事件序列：reset 先于第 2 次尝试的增量，且全程只发一次。
    expect(events[0]).toEqual({ type: 'stream_reset' })
    expect(events.filter((e) => e.type === 'stream_reset')).toHaveLength(1)
    expect(events.some((e) => e.type === 'text_delta')).toBe(true)
  })
})

describe('streamOnce — SSE 缓冲与解码', () => {
  it('无换行的超长单行超过 8MB 上限 → 抛错（畸形端点保护）', async () => {
    const giant = 'x'.repeat(9 * 1024 * 1024)
    vi.stubGlobal('fetch', async () => sseResponse([new TextEncoder().encode(giant)]))
    const err = await streamOnce(conn, req, new AbortController().signal, () => {}).then(() => null, (e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('SSE 缓冲')
  })

  it('残余行：连接关闭无尾随换行（尾行 [DONE]）+ 多字节字符跨 chunk，done content 完整', async () => {
    // 「你」= E4 BD A0、「好」= E5 A5 BD——在「好」的 A5 后切一刀（字符跨 chunk，靠 decoder
    // stream 模式拼回）；尾行 [DONE] 无尾随换行，走残余行路径。
    const all = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"}}]}\ndata: [DONE]')
    const cut = all.indexOf(0xa5) + 1
    vi.stubGlobal('fetch', async () => sseResponse([all.slice(0, cut), all.slice(cut)]))
    const result = await streamOnce(conn, req, new AbortController().signal, () => {})
    expect(result.message.content).toBe('你好')
  })
})
