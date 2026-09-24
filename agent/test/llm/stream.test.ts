import { describe, it, expect, vi, afterEach } from 'vitest'
import { OpenAiClient } from '../../src/llm'
import { streamOnce, setIdleTimeoutForTest } from '../../src/llm/provider/openai/stream'
import { StreamTimeoutError } from '../../src/llm/provider/openai/errors'
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

// 手动控制进度的 SSE 流：用例按需 push/close，构造带真实时间静默间隔的 chunk 节奏
//（sseResponse 是一次性的，做不了「先吐一段 → 停顿 → 再吐」的时序）。
function manualSseResponse(): { res: Response; push: (line: string) => void; close: () => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
  const enc = new TextEncoder()
  return {
    res: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    push: (line) => controller.enqueue(enc.encode(line)),
    close: () => controller.close(),
  }
}

// 永不进数据也永不关闭的 200 响应体：body 阶段挂死，等空闲定时器掐断。
function hangingResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({ start() { /* 故意什么都不做 */ } }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

describe('streamOnce — 两级空闲超时（首字节前紧 / 流建立后放宽）', () => {
  // 立法阈值（首 chunk 前 60s / 首 chunk 后 180s）在测试里缩比成毫秒级：真实的分钟级思考静默
  // 无法等待，验证的是「两级阈值按流是否建立正确分发」这一机制本身。用例级还原，防泄漏到其他 describe。
  afterEach(() => setIdleTimeoutForTest(60_000, 180_000))

  it('回归：首 chunk 后的思考静默超过「首字节级」阈值但小于「流建立级」阈值 → 不误杀，正常完成', async () => {
    // 缩比复现用户实测场景（thought_delta 陆续到达后长静默被旧单级阈值误杀）：
    // 首字节级 80ms 扮演旧 60s 的角色，流建立级 800ms 扮演新 180s 的角色；
    // 静默 300ms——超过首字节级（旧逻辑会在此掐断），落在流建立级的容忍范围内。
    setIdleTimeoutForTest(80, 800)
    const stream = manualSseResponse()
    vi.stubGlobal('fetch', async () => stream.res)
    const pending = streamOnce(conn, req, new AbortController().signal, () => {})
    stream.push('data: {"choices":[{"delta":{"content":"思考结束前的一段"}}]}\n\n')
    await sleep(300) // 思考静默：provider 整段时间不发任何字节，属合法生成节奏
    stream.push('data: {"choices":[{"delta":{"content":"，静默后的正文"}}]}\n\n')
    stream.push('data: [DONE]\n\n')
    const result = await pending
    expect(result.message.content).toBe('思考结束前的一段，静默后的正文')
  })

  it('首字节前静默超过首字节级阈值 → 空闲超时仍触发（快速失败未被放宽冲掉）', async () => {
    // 流建立级故意设得很大，隔离出「首 chunk 前」这一级的判定。
    setIdleTimeoutForTest(80, 10 * 60_000)
    vi.stubGlobal('fetch', async () => hangingResponse())
    const err = await streamOnce(conn, req, new AbortController().signal, () => {}).then(() => null, (e) => e)
    expect(err).toBeInstanceOf(StreamTimeoutError)
    expect((err as StreamTimeoutError).kind).toBe('idle')
    expect((err as StreamTimeoutError).retryable).toBe(true)
  })

  it('流建立后静默超过流建立级阈值 → 空闲超时仍触发（放宽不是取消上限）', async () => {
    // 首字节级故意设得很大，隔离出「首 chunk 后」这一级的判定；之后永不 push、永不 close——
    // 静默超过流建立级阈值必须被掐断，而非永久挂死。
    setIdleTimeoutForTest(10 * 60_000, 80)
    const stream = manualSseResponse()
    vi.stubGlobal('fetch', async () => stream.res)
    const pending = streamOnce(conn, req, new AbortController().signal, () => {})
    stream.push('data: {"choices":[{"delta":{"content":"先吐一段"}}]}\n\n')
    const err = await pending.then(() => null, (e) => e)
    expect(err).toBeInstanceOf(StreamTimeoutError)
    expect((err as StreamTimeoutError).kind).toBe('idle')
  })

  it('空闲超时文案不暗示连接死亡（体现「停止等待服务器数据」）', async () => {
    setIdleTimeoutForTest(50, 10 * 60_000)
    vi.stubGlobal('fetch', async () => hangingResponse())
    const err = await streamOnce(conn, req, new AbortController().signal, () => {}).then(() => null, (e) => e)
    expect((err as Error).message).toBe('流式空闲超时（长时间未收到服务器新数据，已停止等待）')
  })
})
