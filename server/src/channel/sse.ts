import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentPort } from '@dogegg/bridge'
import type { AgentToUiMessage } from '@dogegg/bridge'
import type { UiToAgentMessage } from '@dogegg/bridge'
import { uiToAgentMessageSchema } from '@dogegg/bridge'

// POST body 最大 1MB——防止恶意大 body 耗尽内存。
const MAX_BODY_SIZE = 1024 * 1024

// SSE 通道：实现 AgentPort 接口，用 HTTP SSE 下行 + POST 上行。
// agent 侧把本实例直接当作 agentPort（收 UI 消息经 postHandler 触发、发 UI 消息写 SSE 流）；
// Router 把 GET /api/events 与 POST /api/message 接到 sseHandler/postHandler。
// UI 侧直接消费 SSE 流（浏览器 EventSource）+ POST 上行（fetch），不需要 UiPort。
// 多个浏览器标签页可同时连 SSE——它们都是同一 Agent 的观察者，共享同一事件流。
export class SseChannel implements AgentPort {
  // UI→agent 消息回调（由 postHandler 触发）。
  private readonly agentListeners = new Set<(m: UiToAgentMessage) => void>()
  // 活跃的 SSE 连接——agent→UI 消息会写入所有连接。
  private readonly sseClients = new Set<ServerResponse>()

  /** 订阅来自 UI 的消息，返回退订函数。 */
  onMessage(cb: (m: UiToAgentMessage) => void): () => void {
    this.agentListeners.add(cb)
    return () => { this.agentListeners.delete(cb) }
  }

  // agent → UI：序列化为 JSON，写入所有活跃 SSE 连接。
  post(msg: AgentToUiMessage): void {
    const data = `data: ${JSON.stringify(msg)}\n\n`
    for (const res of this.sseClients) {
      try { res.write(data) } catch { /* 连接已断开，write 失败——清理在 close 事件里做 */ }
    }
  }

  /** GET /api/events 的 HTTP handler——建立 SSE 连接，注册到活跃连接集合。 */
  sseHandler(_req: IncomingMessage, res: ServerResponse): void {
    // SSE 响应头：text/event-stream + no-cache + keep-alive。
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    res.write(': connected\n\n')
    this.sseClients.add(res)
    res.on('close', () => { this.sseClients.delete(res) })
  }

  /** POST /api/message 的 HTTP handler——读取 body，zod 校验，触发 agentPort 回调。 */
  postHandler(req: IncomingMessage, res: ServerResponse): void {
    let body = ''
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
      if (body.length > MAX_BODY_SIZE) {
        tooLarge = true
        req.destroy() // 停止读取
      }
    })
    req.on('end', () => {
      if (tooLarge) {
        res.writeHead(413, { 'Content-Type': 'text/plain' })
        res.end('Request body too large')
        return
      }
      try {
        const raw = JSON.parse(body)
        // zod 校验——确保 POST body 是合法的 UiToAgentMessage。
        const result = uiToAgentMessageSchema.safeParse(raw)
        if (!result.success) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid message', details: result.error.issues }))
          return
        }
        this.agentListeners.forEach((l) => l(result.data))
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('ok')
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('invalid JSON')
      }
    })
    req.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('request error')
      }
    })
  }
}
