import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request, type Server } from 'node:http'
import { describe, it, expect, afterEach } from 'vitest'
import { Agent, ConfigStore } from '@dogegg/agent'
import { SseChannel } from '../../src/channel/sse'

// 端到端实证（真 HTTP + 真 SSE 流 + 真 Agent）：浏览器视角的完整链路——
// GET /api/events 建流 → POST /api/message 发 rename_session → 断言 notice 与 session_list
// 都能从 SSE 流里收到。本测试刻意跨组合边界（server 包本身对 agent 无知，组合发生在 main-web），
// 放在这里是为了实证「WebUI 下行链路对 notice 无过滤」——与 TUI 的进程内 Port 行为对齐。

function makeConfig() {
  return new ConfigStore().load({
    providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x/v1', apiKey: 'k', models: [{ name: 'm' }] }],
  })
}

const fakeClient = {
  async chat() {
    return { message: { role: 'assistant' as const, content: 'ok' }, reasoning: undefined }
  },
}

let server: Server | null = null
afterEach(async () => {
  if (server) {
    // SSE 是长连接——先强断所有连接，close 回调才会返回。
    server.closeAllConnections()
    await new Promise<void>((r) => server!.close(() => r()))
  }
  server = null
})

// 装配真实链路：Agent(channel) + http server（GET /api/events / POST /api/message）。
async function start(): Promise<string> {
  const channel = new SseChannel()
  const cwd = mkdtempSync(join(tmpdir(), 'dogegg-e2e-cwd-'))
  const sessionsDir = mkdtempSync(join(tmpdir(), 'dogegg-e2e-sess-'))
  // eslint-disable-next-line no-new
  new Agent(channel, makeConfig(), cwd, { client: fakeClient, sessionsDir })
  server = createServer((req, res) => {
    if (req.url === '/api/events') { channel.sseHandler(req, res); return }
    if (req.url === '/api/message' && req.method === 'POST') { channel.postHandler(req, res); return }
    res.writeHead(404); res.end()
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

// 从 SSE 流收集数据块直到谓词命中（超时兜底；离开时取消 reader，让连接可关闭）。
async function collectStream(base: string, pred: (buf: string) => boolean, label: string): Promise<string> {
  const res = await fetch(`${base}/api/events`)
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    const deadline = Date.now() + 3000
    for (;;) {
      if (pred(buf)) return buf
      if (Date.now() > deadline) throw new Error(`等待 ${label} 超时；已收到：${buf.slice(0, 400)}`)
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`等待 ${label} 超时`)), 3000)),
      ])
      buf += decoder.decode(chunk.value)
    }
  } finally {
    reader.cancel().catch(() => { /* 已结束则忽略 */ })
  }
}

// 用 node:http 客户端手工控制 TCP 写入时序——fetch 的 body 是整体字符串，无法指定
// chunk 边界。逐块 write（等 flush 回调后再写下一块，块间再加间隔让服务端消化），
// 人为制造 chunk 边界 / 保证服务端逐块跟得上。Content-Length 按全部块之和声明。
function postRaw(base: string, chunks: Buffer[], gapMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${base}/api/message`)
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const req = request(
      {
        host: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': total },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (d: string) => { body += d })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', reject)
    let i = 0
    const writeNext = () => {
      if (i >= chunks.length) { req.end(); return }
      req.write(chunks[i]!, () => { i++; setTimeout(writeNext, gapMs) })
    }
    writeNext()
  })
}

describe('WebUI 下行链路端到端（SSE 无过滤）', () => {
  it('rename_session 的 notice 与 session_list 都能从 SSE 流到达浏览器', async () => {
    const base = await start()
    // 先连流（浏览器挂载时序），再发消息。
    const streamPromise = collectStream(base, (buf) => buf.includes('"type":"notice"') && buf.includes('会话已命名'), 'notice')
    await new Promise((r) => setTimeout(r, 50)) // 等服务端登记 SSE 连接

    const post = await fetch(`${base}/api/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'rename_session', title: '端到端命名' }),
    })
    expect(post.status).toBe(200)

    const buf = await streamPromise
    expect(buf).toContain('"type":"notice"')
    expect(buf).toContain('会话已命名「端到端命名」')
    expect(buf).toContain('"type":"session_list"')
    expect(buf).toContain('"title":"端到端命名"')
  })

  // ── P2-19a 实网验证：多字节 UTF-8 跨 TCP chunk 边界不被截断 ──
  it('「你」的 3 字节分两个 TCP 写入仍被完整解析（通知回显无替换符）', async () => {
    const base = await start()
    const streamPromise = collectStream(base, (buf) => buf.includes('会话已命名「你」'), 'notice')
    await new Promise((r) => setTimeout(r, 50)) // 等服务端登记 SSE 连接

    // 「你」的 UTF-8 编码为 3 字节（E4 BD A0）——从首字节之后切开，两个 TCP 写入。
    const body = Buffer.from(JSON.stringify({ type: 'rename_session', title: '你' }), 'utf8')
    const cut = body.indexOf(Buffer.from([0xe4])) + 1
    const post = await postRaw(base, [body.subarray(0, cut), body.subarray(cut)], 20)

    expect(post.status).toBe(200) // 不再因 JSON 损坏 400
    const buf = await streamPromise
    expect(buf).toContain('会话已命名「你」') // 文本完整回显
  })

  // ── P2-19b 实网验证：413 可达（尽力而为语义下用正常速度发送保证读到响应）──
  it('body 超过 1MB 上限 → 客户端收到 413 与 JSON 错误体', async () => {
    const base = await start()
    // 压线构造：head（json + 填充）恰好 1MB，最后 1 字节才突破——总数 = 上限 + 1。
    // 突破点即最后一个 TCP 写入——服务端回应 413 时客户端已发完全部数据（end 已调用），
    // 没有后续在途写入触发 RST，「尽力而为」的最坏路径被排除，413 必达。
    const json = JSON.stringify({ type: 'submit', text: 'x' })
    const pad = 1024 * 1024 - Buffer.byteLength(json)
    const head = Buffer.concat([Buffer.from(json), Buffer.alloc(pad)])
    const post = await postRaw(
      base,
      [head.subarray(0, 512 * 1024), head.subarray(512 * 1024), Buffer.from('a')],
      30,
    )

    expect(post.status).toBe(413)
    expect(JSON.parse(post.body)).toEqual({ error: 'Request body too large' })
  }, 10000)
})
