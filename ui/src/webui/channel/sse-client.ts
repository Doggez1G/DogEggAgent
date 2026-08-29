import type { AgentToUiMessage, UiToAgentMessage, UiPort } from '@dogegg/bridge'

// SSE UiPort：把浏览器的 EventSource + fetch POST 封装为 UiPort 接口。
// 下行（agent → UI）：EventSource 监听 /api/events，收到 data 事件 → JSON.parse → onMessage 回调。
// 上行（UI → agent）：fetch POST /api/message，body 为 JSON.stringify(msg)。
// EventSource 断开后浏览器自动重连——重连时 server 推 session_ready 恢复完整状态。
export function createSseUiPort(): UiPort {
  const listeners = new Set<(msg: AgentToUiMessage) => void>()
  const es = new EventSource('/api/events')
  es.onmessage = (e: MessageEvent) => {
    try {
      const msg = JSON.parse(e.data) as AgentToUiMessage
      listeners.forEach((l) => l(msg))
    } catch {
      // 忽略无法解析的消息（不应发生，但防御性处理）
    }
  }
  return {
    onMessage(cb: (msg: AgentToUiMessage) => void): () => void {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    async post(msg: UiToAgentMessage): Promise<void> {
      await fetch('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
      })
    },
  }
}
