import type { AgentToUiMessage, UiToAgentMessage, UiPort } from '@dogegg/bridge'
import { agentToUiMessageSchema } from '@dogegg/bridge'

export type ConnectionState = 'connected' | 'reconnecting' | 'disconnected'

// 带「重连回调注册」的 UiPort——SSE 传输的特有能力：EventSource 断线自动重连成功后，
// 上层需要重新播种（自动重连不会重跑 React effect），通过 setOnReconnect 注册回调。
export type SseUiPort = UiPort & { setOnReconnect(cb: () => void): void }

// SSE UiPort：把浏览器的 EventSource + fetch POST 封装为 UiPort 接口。
// 下行（agent → UI）：EventSource 监听 /api/events，收到 data 事件 → JSON.parse → onMessage 回调。
// 上行（UI → agent）：fetch POST /api/message，body 为 JSON.stringify(msg)。
// EventSource 断开后浏览器自动重连——重连时 server 推 session_ready 恢复完整状态。
// 连接状态通过 onConnectionChange 回调通知 UI（顶栏指示器 + 首次断连 toast）。
export function createSseUiPort(onConnectionChange?: (state: ConnectionState) => void): SseUiPort {
  const listeners = new Set<(msg: AgentToUiMessage) => void>()
  let currentState: ConnectionState = 'reconnecting'
  let hasConnectedOnce = false
  // 是否经历过断线（onerror）——onopen 时据此区分「首连」与「断线后的自动重连」。
  let hasErrored = false
  // 重连回调：断线后重连成功时调用一次（首连不调）。由上层（app.tsx）注册播种逻辑。
  let onReconnect: (() => void) | null = null

  const setState = (s: ConnectionState) => {
    if (s === currentState) return
    currentState = s
    onConnectionChange?.(s)
  }

  const es = new EventSource('/api/events')

  es.onopen = () => {
    const isReconnect = hasErrored
    hasConnectedOnce = true
    hasErrored = false
    setState('connected')
    // EventSource 自动重连不会重跑 effect——重连成功必须显式通知上层重新播种，
    // 否则重连后各数据域停留在断线前的旧状态（或因服务端重启而全空）。
    if (isReconnect) onReconnect?.()
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
    // 记录断线事实——下次 onopen 即视为重连（而非首连）。
    hasErrored = true
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
        // 服务端 400 = 消息被 zod 校验拒绝（契约漂移信号）。多数调用点不接 Promise，
        // 不在这里留痕就只剩浏览器控制台的 unhandled rejection——排障线索必须落地。
        const detail = await res.text().catch(() => '')
        console.warn('[dogegg] 上行消息被服务端拒绝', res.status, msg.type, detail)
        throw new Error(`POST failed: ${res.status}`)
      }
    },
    setOnReconnect(cb: () => void): void { onReconnect = cb },
  }
}
