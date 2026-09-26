import { describe, it, expect } from 'vitest'
import { SseChannel } from '../../src/channel/sse'
import type { AgentToUiMessage, UiToAgentMessage } from '@dogegg/bridge'

// SSE channel 测试：验证 Port 接口的消息传递正确性。
// 不测真实 HTTP——用 mock req/res 验证消息流。
describe('SseChannel', () => {
  it('onMessage 收到 postHandler 转发的 UI 消息', () => {
    const channel = new SseChannel()
    const received: UiToAgentMessage[] = []
    channel.onMessage((msg) => { received.push(msg) })

    // 模拟 POST handler 收到的请求。
    const msg: UiToAgentMessage = { type: 'submit', text: 'hello' }
    const body = JSON.stringify(msg)
    const chunks: Buffer[] = [Buffer.from(body)]
    const fakeReq = {
      headers: { 'content-type': 'application/json' },
      on: (event: string, cb: (arg?: Buffer) => void) => {
        if (event === 'data') chunks.forEach((c) => cb(c))
        if (event === 'end') cb()
        if (event === 'error') { /* no-op */ }
      },
    }
    const fakeRes = {
      writeHead: () => {},
      end: () => {},
    }
    channel.postHandler(fakeReq as never, fakeRes as never)

    expect(received).toHaveLength(1)
    expect(received[0]!.type).toBe('submit')
  })

  it('post 写入所有活跃 SSE 连接', () => {
    const channel = new SseChannel()
    const written: string[] = []
    const fakeRes = {
      writeHead: () => {},
      write: (data: string) => { written.push(data) },
      on: () => {},
    }
    channel.sseHandler({} as never, fakeRes as never)

    const msg: AgentToUiMessage = { type: 'state', from: 'idle', to: 'thinking' }
    channel.post(msg)

    // 第一行是 ': connected\n\n'，第二行是 data: {...}\n\n
    expect(written.length).toBeGreaterThanOrEqual(2)
    const dataLine = written.find((w) => w.startsWith('data: '))
    expect(dataLine).toBeDefined()
    expect(dataLine!).toContain('"type":"state"')
    expect(dataLine!).toContain('"from":"idle"')
    expect(dataLine!).toContain('"to":"thinking"')
  })

  it('SSE 连接关闭后从客户端集合移除（不泄漏）', () => {
    const channel = new SseChannel()
    const closeHandlers: (() => void)[] = []
    const fakeRes = {
      writeHead: () => {},
      write: () => {},
      on: (event: string, cb: () => void) => { if (event === 'close') closeHandlers.push(cb) },
    }
    channel.sseHandler({} as never, fakeRes as never)

    // 模拟连接关闭。
    closeHandlers.forEach((cb) => cb())

    // 关闭后 post 不应崩溃（集合已移除，write 不会被调用）。
    const msg: AgentToUiMessage = { type: 'finished' }
    expect(() => channel.post(msg)).not.toThrow()
  })

  it('无效 JSON 的 POST 返回 400', () => {
    const channel = new SseChannel()
    const received: UiToAgentMessage[] = []
    channel.onMessage((msg) => { received.push(msg) })

    const fakeReq = {
      headers: { 'content-type': 'application/json' },
      on: (event: string, cb: (arg?: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from('not valid json'))
        if (event === 'end') cb()
        if (event === 'error') { /* no-op */ }
      },
    }
    let statusCode = 0
    const fakeRes = {
      writeHead: (code: number) => { statusCode = code },
      end: () => {},
    }
    channel.postHandler(fakeReq as never, fakeRes as never)

    expect(statusCode).toBe(400)
    expect(received).toHaveLength(0)
  })

  // ── Content-Type 防线（配 http-server 的 host/origin 校验，见 http-server.ts 立法注释）──
  // simple request 无法伪造 Content-Type，text/plain 表单 POST / no-cors fetch 在此被拒。

  it('Content-Type 非 application/json 的 POST 返回 415', () => {
    const channel = new SseChannel()
    const received: UiToAgentMessage[] = []
    channel.onMessage((msg) => { received.push(msg) })

    const fakeReq = {
      headers: { 'content-type': 'text/plain' },
      on: (event: string, cb: (arg?: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from('text body'))
        if (event === 'end') cb()
        if (event === 'error') { /* no-op */ }
      },
    }
    let statusCode = 0
    const fakeRes = {
      writeHead: (code: number) => { statusCode = code },
      end: () => {},
    }
    channel.postHandler(fakeReq as never, fakeRes as never)

    expect(statusCode).toBe(415)
    expect(received).toHaveLength(0)
  })

  it('缺少 Content-Type 的 POST 返回 415', () => {
    const channel = new SseChannel()
    const received: UiToAgentMessage[] = []
    channel.onMessage((msg) => { received.push(msg) })

    const fakeReq = {
      headers: {},
      on: (event: string, cb: (arg?: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from('{}'))
        if (event === 'end') cb()
        if (event === 'error') { /* no-op */ }
      },
    }
    let statusCode = 0
    const fakeRes = {
      writeHead: (code: number) => { statusCode = code },
      end: () => {},
    }
    channel.postHandler(fakeReq as never, fakeRes as never)

    expect(statusCode).toBe(415)
    expect(received).toHaveLength(0)
  })

  it('Content-Type 带 charset 后缀仍视为 application/json 放行', () => {
    const channel = new SseChannel()
    const received: UiToAgentMessage[] = []
    channel.onMessage((msg) => { received.push(msg) })

    const fakeReq = {
      headers: { 'content-type': 'application/json; charset=utf-8' },
      on: (event: string, cb: (arg?: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from(JSON.stringify({ type: 'list_sessions' })))
        if (event === 'end') cb()
        if (event === 'error') { /* no-op */ }
      },
    }
    let statusCode = 0
    const fakeRes = {
      writeHead: (code: number) => { statusCode = code },
      end: () => {},
    }
    channel.postHandler(fakeReq as never, fakeRes as never)

    expect(statusCode).toBe(200)
    expect(received).toHaveLength(1)
  })

  it('每个新连接建立时触发一次 onConnect（重连重发快照的接线点）', () => {
    const channel = new SseChannel()
    let calls = 0
    channel.onConnect = () => { calls++ }

    const makeRes = () => ({
      writeHead: () => {},
      write: () => {},
      on: () => {},
    })
    // 第二个客户端连接（模拟另一标签页 / 刷新页面后的重连）——每次连接计数 +1。
    channel.sseHandler({} as never, makeRes() as never)
    channel.sseHandler({} as never, makeRes() as never)

    expect(calls).toBe(2)
  })

  // ── 恢复链单播化（立法见 sse.ts onConnect 注释）──
  // session_ready 是「新连接的私事」：广播会把其它在看客户端的聊天区整体重置（运行中流式
  // 内容丢失），N 客户端一次重连退化为 O(N²) 消息。onConnect 必须拿到只写发起连接的单播 send。

  it('onConnect 收到单播 send——恢复消息只写发起连接，其它连接不受影响', () => {
    const channel = new SseChannel()
    const sends: ((msg: AgentToUiMessage) => void)[] = []
    channel.onConnect = (send) => { sends.push(send) }

    const writtenA: string[] = []
    const writtenB: string[] = []
    const makeRes = (written: string[]) => ({
      writeHead: () => {},
      write: (data: string) => { written.push(data) },
      on: () => {},
    })
    // 两个假连接（模拟两个标签页）——各自拿到自己的单播 send。
    channel.sseHandler({} as never, makeRes(writtenA) as never)
    channel.sseHandler({} as never, makeRes(writtenB) as never)

    // 连接 A 触发的恢复重发：只有 A 收到 session_ready，B 的流不受影响。
    const msg: AgentToUiMessage = { type: 'session_ready', id: 's1', messages: [], busy: false }
    sends[0]!(msg)

    const dataA = writtenA.find((w) => w.startsWith('data: '))
    expect(dataA).toBeDefined()
    expect(dataA!).toContain('"type":"session_ready"')
    expect(writtenB.every((w) => !w.startsWith('data: '))).toBe(true)
  })

  it('单播 send 的写入格式与 post 一致（data: <JSON>\\n\\n）', () => {
    const channel = new SseChannel()
    let captured: ((msg: AgentToUiMessage) => void) | undefined
    channel.onConnect = (send) => { captured = send }

    const written: string[] = []
    channel.sseHandler({} as never, {
      writeHead: () => {},
      write: (data: string) => { written.push(data) },
      on: () => {},
    } as never)

    const msg: AgentToUiMessage = { type: 'notice', text: '单播' }
    captured!(msg)
    // 最后一行是单播写入（前面只有 ': connected\n\n'）——格式与 post 的 data 行逐字节一致。
    expect(written[written.length - 1]).toBe(`data: ${JSON.stringify(msg)}\n\n`)
  })

  it('连接关闭后单播 send 写失败被忽略（不向恢复链抛异常）', () => {
    const channel = new SseChannel()
    let captured: ((msg: AgentToUiMessage) => void) | undefined
    channel.onConnect = (send) => { captured = send }

    // 连接建立阶段照常写入；sseHandler 返回后模拟连接销毁——此后 write 同步抛错。
    let destroyed = false
    channel.sseHandler({} as never, {
      writeHead: () => {},
      write: () => { if (destroyed) throw new Error('write after end') },
      on: () => {},
    } as never)
    destroyed = true

    expect(() => captured!({ type: 'notice', text: 'x' })).not.toThrow()
  })

  // ── P2-19a：POST body 跨 chunk 多字节 UTF-8 ──
  // 旧实现 `body += chunk.toString()` 在 chunk 边界把多字节字符截成 U+FFFD；改为 Buffer[]
  // 收集后解码只发生在完整字节序列上。

  it('多字节 UTF-8 字符跨 chunk 边界仍完整解析（「你」的 3 字节分两个 chunk）', () => {
    const channel = new SseChannel()
    const received: UiToAgentMessage[] = []
    channel.onMessage((msg) => { received.push(msg) })

    // 「你」的 UTF-8 编码为 3 字节（E4 BD A0）——从首字节之后切开，迫使该字符跨两个 chunk。
    const body = Buffer.from(JSON.stringify({ type: 'submit', text: '你' }), 'utf8')
    const cut = body.indexOf(Buffer.from([0xe4])) + 1
    const chunks = [body.subarray(0, cut), body.subarray(cut)]

    const fakeReq = {
      headers: { 'content-type': 'application/json' },
      on: (event: string, cb: (arg?: Buffer) => void) => {
        if (event === 'data') chunks.forEach((c) => cb(c))
        if (event === 'end') cb()
        if (event === 'error') { /* no-op */ }
      },
    }
    let statusCode = 0
    const fakeRes = {
      writeHead: (code: number) => { statusCode = code },
      end: () => {},
    }
    channel.postHandler(fakeReq as never, fakeRes as never)

    expect(statusCode).toBe(200) // 不再 400
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({ type: 'submit', text: '你' }) // 文本完整，无替换符
  })

  it('整段中文按单字节切碎成多个 chunk 仍完整解析（最坏切分）', () => {
    const channel = new SseChannel()
    const received: UiToAgentMessage[] = []
    channel.onMessage((msg) => { received.push(msg) })

    // 中英混合文本逐字节切开——每个多字节字符都被撕成 3 份，是最坏的 chunk 边界分布。
    const text = '中文消息abc123'
    const body = Buffer.from(JSON.stringify({ type: 'submit', text }), 'utf8')
    const chunks: Buffer[] = []
    for (let i = 0; i < body.length; i++) chunks.push(body.subarray(i, i + 1))

    const fakeReq = {
      headers: { 'content-type': 'application/json' },
      on: (event: string, cb: (arg?: Buffer) => void) => {
        if (event === 'data') chunks.forEach((c) => cb(c))
        if (event === 'end') cb()
        if (event === 'error') { /* no-op */ }
      },
    }
    let statusCode = 0
    const fakeRes = {
      writeHead: (code: number) => { statusCode = code },
      end: () => {},
    }
    channel.postHandler(fakeReq as never, fakeRes as never)

    expect(statusCode).toBe(200)
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({ type: 'submit', text })
  })

  // ── P2-19b：413 尽力而为响应 ──
  // 旧实现超限即 req.destroy()，413 分支是死代码（'end' 永不触发）；新实现超限时立刻
  // 写 413 + JSON 错误体，响应 flush 后才断开连接，后续数据一律忽略。

  it('body 超过 1MB 上限 → data 阶段即刻回应 413（JSON 形态），flush 后才断开', () => {
    const channel = new SseChannel()
    const received: UiToAgentMessage[] = []
    channel.onMessage((msg) => { received.push(msg) })

    let destroyed = false
    const handlers: Record<string, (arg?: unknown) => void> = {}
    const fakeReq = {
      headers: { 'content-type': 'application/json' },
      on: (event: string, cb: (arg?: unknown) => void) => { handlers[event] = cb },
      destroy: () => { destroyed = true },
    }
    let statusCode = 0
    let responseBody: string | undefined
    let endCalls = 0
    const fakeRes = {
      writeHead: (code: number) => { statusCode = code },
      // 模拟真实 res.end(data, cb)：写入完成（flush）后调用回调。
      end: (body?: string, cb?: () => void) => { endCalls++; responseBody = body; cb?.() },
    }
    channel.postHandler(fakeReq as never, fakeRes as never)

    // 第一块 600KB 未超限（600KB < 1MB）——不响应。
    handlers['data']!(Buffer.alloc(600 * 1024))
    expect(statusCode).toBe(0)
    expect(destroyed).toBe(false)

    // 第二块累计 1200KB > 1MB——在 data 阶段即刻回应 413，flush（回调）后才 destroy。
    handlers['data']!(Buffer.alloc(600 * 1024))
    expect(statusCode).toBe(413)
    expect(JSON.parse(responseBody!)).toEqual({ error: 'Request body too large' })
    expect(destroyed).toBe(true)
    expect(endCalls).toBe(1)

    // 后续 data 与 'end' 均被忽略——不重复写响应、不触发 agent。
    handlers['data']!(Buffer.alloc(10))
    handlers['end']!()
    expect(endCalls).toBe(1)
    expect(statusCode).toBe(413)
    expect(received).toHaveLength(0)
  })

  it('未超限的正常 body 不受影响：end 阶段正常 200', () => {
    const channel = new SseChannel()
    const received: UiToAgentMessage[] = []
    channel.onMessage((msg) => { received.push(msg) })

    const handlers: Record<string, (arg?: unknown) => void> = {}
    const fakeReq = {
      headers: { 'content-type': 'application/json' },
      on: (event: string, cb: (arg?: unknown) => void) => { handlers[event] = cb },
      destroy: () => {},
    }
    let statusCode = 0
    const fakeRes = {
      writeHead: (code: number) => { statusCode = code },
      end: () => {},
    }
    channel.postHandler(fakeReq as never, fakeRes as never)

    handlers['data']!(Buffer.from(JSON.stringify({ type: 'submit', text: 'hello' })))
    handlers['end']!()

    expect(statusCode).toBe(200)
    expect(received).toHaveLength(1)
  })
})
