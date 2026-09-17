import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
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
})
