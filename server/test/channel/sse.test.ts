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
})
