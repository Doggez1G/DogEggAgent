import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentPort, UiPort } from '@dogegg/bridge'
import type { AgentToUiMessage } from '@dogegg/bridge'
import type { UiToAgentMessage } from '@dogegg/bridge'

// SSE 通道：实现 AgentPort / UiPort 接口，用 HTTP SSE 下行 + POST 上行。
// agent 侧通过 agentPort 收 UI 消息（POST → onMessage 回调）、发 UI 消息（→ SSE 流）。
// ui 侧通过 uiPort 收 agent 消息（SSE 流 → onMessage 回调）、发 agent 消息（→ POST handler）。
// 多个浏览器标签页可同时连 SSE——它们都是同一 Agent 的观察者，共享同一事件流。
export function createSseChannel(): {
  agentPort: AgentPort
  uiPort: UiPort
  /** GET /api/events 的 HTTP handler——建立 SSE 连接，注册到活跃连接集合。 */
  sseHandler: (req: IncomingMessage, res: ServerResponse) => void
  /** POST /api/message 的 HTTP handler——读取 body，解析为 UiToAgentMessage，触发 agentPort 回调。 */
  postHandler: (req: IncomingMessage, res: ServerResponse) => void
} {
  // agentPort 收到的 UI→agent 消息回调（由 postHandler 触发）。
  const agentListeners = new Set<(m: UiToAgentMessage) => void>()
  // 活跃的 SSE 连接——agent→UI 消息会写入所有连接。
  const sseClients = new Set<ServerResponse>()

  const agentPort: AgentPort = {
    onMessage(cb) {
      agentListeners.add(cb)
      return () => { agentListeners.delete(cb) }
    },
    // agent → UI：序列化为 JSON，写入所有活跃 SSE 连接。
    post(msg: AgentToUiMessage) {
      const data = `data: ${JSON.stringify(msg)}\n\n`
      for (const res of sseClients) {
        try { res.write(data) } catch { /* 连接已断开，write 失败——清理在 close 事件里做 */ }
      }
    },
  }

  const uiPort: UiPort = {
    onMessage() {
      // SSE 通道不支持 uiPort.onMessage——UI 侧通过 sseHandler 直接消费 SSE 流。
      // 此方法仅为满足 UiPort 接口形状（组合根不会调 uiPort.onMessage，而是调 sseHandler）。
      return () => {}
    },
    // UI → agent：由 postHandler 间接调用——uiPort.post 不直接使用，
    // 但保留接口形状。实际上行路径是 postHandler → agentListeners。
    post(msg: UiToAgentMessage) {
      agentListeners.forEach((l) => l(msg))
    },
  }

  const sseHandler = (_req: IncomingMessage, res: ServerResponse) => {
    // SSE 响应头：text/event-stream + no-cache + keep-alive。
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    // 立即发一个空 comment 行让浏览器尽快收到响应头（避免 EventSource 超时）。
    res.write(': connected\n\n')
    sseClients.add(res)

    // 连接关闭时清理——从集合移除，避免后续 post 写入已关闭的 res。
    res.on('close', () => { sseClients.delete(res) })
  }

  const postHandler = (req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      try {
        const msg = JSON.parse(body) as UiToAgentMessage
        agentListeners.forEach((l) => l(msg))
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*' })
        res.end('ok')
      } catch {
        res.writeHead(400, { 'Access-Control-Allow-Origin': '*' })
        res.end('invalid JSON')
      }
    })
    req.on('error', () => {
      res.writeHead(400, { 'Access-Control-Allow-Origin': '*' })
      res.end('request error')
    })
  }

  return { agentPort, uiPort, sseHandler, postHandler }
}
