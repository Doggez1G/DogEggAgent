import type { AgentToUiMessage, UiToAgentMessage, UiPort } from '@dogegg/bridge'
import { agentToUiMessageSchema } from '@dogegg/bridge'

export type ConnectionState = 'connected' | 'reconnecting' | 'disconnected'

// SSE UiPort：把浏览器的 EventSource + fetch POST 封装为 UiPort 接口。
// 下行（agent → UI）：EventSource 监听 /api/events，收到 data 事件 → JSON.parse → onMessage 回调。
// 上行（UI → agent）：fetch POST /api/message，body 为 JSON.stringify(msg)。
// EventSource 断开后浏览器自动重连——重连时 server 推 session_ready 恢复完整状态。
// 连接状态通过 onConnectionChange 回调通知 UI（顶栏指示器 + 首次断连 toast）。
export function createSseUiPort(onConnectionChange?: (state: ConnectionState) => void): UiPort {
  const listeners = new Set<(msg: AgentToUiMessage) => void>()
  let currentState: ConnectionState = 'reconnecting'
  let hasConnectedOnce = false

  const setState = (s: ConnectionState) => {
    if (s === currentState) return
    currentState = s
    onConnectionChange?.(s)
  }

  const es = new EventSource('/api/events')

  es.onopen = () => {
    hasConnectedOnce = true
    setState('connected')
  }

  es.onmessage = (e: MessageEvent) => {
    try {
      const raw = JSON.parse(e.data)
      // zod 校验下行消息——校验失败则丢弃，不传给 listener。
      const result = agentToUiMessageSchema.safeParse(raw)
      if (result.success) {
        listeners.forEach((l) => l(result.data))
      }
    } catch {
      // 忽略无法解析的消息（不应发生，但防御性处理）
    }
  }

  es.onerror = () => {
    // EventSource readyState: 0=connecting, 1=open, 2=closed
    if (es.readyState === EventSource.CLOSED) {
      setState('disconnected')
    } else {
      // readyState === CONNECTING：浏览器正在自动重连
      setState('reconnecting')
    }
  }

  return {
    onMessage(cb: (msg: AgentToUiMessage) => void): () => void {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    async post(msg: UiToAgentMessage): Promise<void> {
      const res = await fetch('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
      })
      if (!res.ok) {
        throw new Error(`POST failed: ${res.status}`)
      }
    },
  }
}
