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
// 多个浏览器标签页可同时连 SSE——它们都是同一 Agent 的观察者，**常规事件**（post）共享
// 同一广播流；唯【恢复链】例外：新连接的会话快照重发走 per-client 单播（见 onConnect/send）。
export class SseChannel implements AgentPort {
  // UI→agent 消息回调（由 postHandler 触发）。
  private readonly agentListeners = new Set<(m: UiToAgentMessage) => void>()
  // 活跃的 SSE 连接——agent→UI 消息会写入所有连接。
  private readonly sseClients = new Set<ServerResponse>()
  // 可选回调：新 SSE 连接建立时触发（含断线自动重连、页面刷新后的重新连接）。
  // 参数 send 是捕获了【该连接】res 的单播发送器（构造见 sseHandler）——组合根
  //（main-web.ts / bin/dogegg.ts）用它调 agent.resendSessionState(send) 向新连接单播重发会话快照。
  // 【立法】恢复是新连接的私事，必须单播、绝不广播：session_ready 一旦经 post() 广播，会把
  // 其它正在看的客户端聊天区整体重置（运行中的流式内容随 blocks 重建而丢失），且 N 个客户端
  // 时一次重连退化为 O(N²) 消息。SSE 重连/刷新后前端没有后端事件重放，新连接必须重发快照，
  // 兑现 sse-client 的注释承诺。
  onConnect?: (send: (msg: AgentToUiMessage) => void) => void

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
    // 连接已登记——此刻重发快照能送达新连接（先登记再触发，避免消息写入时新连接缺席）。
    // 单播 send：闭包捕获本连接的 res，写入格式与 post() 完全一致（data: <JSON>\n\n）。
    // 连接关闭后该 send 自然失效——res.write 对已销毁的连接可能抛错，try/catch 吞掉即可
    //（连接清理在 close 事件里做，这里不重复负责）。
    const send = (msg: AgentToUiMessage): void => {
      try { res.write(`data: ${JSON.stringify(msg)}\n\n`) } catch { /* 连接已断开，write 失败忽略 */ }
    }
    this.onConnect?.(send)
  }

  /** POST /api/message 的 HTTP handler——读取 body，zod 校验，触发 agentPort 回调。 */
  postHandler(req: IncomingMessage, res: ServerResponse): void {
    // Content-Type 必须是 application/json（带 charset 等后缀也算命中）——simple request
    // 无法伪造该头（text/plain 表单 POST 与 no-cors fetch 都改不了它），是本地来源校验
    //（http-server 的 host/origin 检查）之外服务端可独立自证的第二道防线；否则 415 拒绝。
    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.includes('application/json')) {
      res.writeHead(415, { 'Content-Type': 'text/plain' })
      res.end('Unsupported Media Type: Content-Type must be application/json')
      return
    }
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
