import type { AgentToUiMessage } from '../contract/agent-to-ui'
import type { UiToAgentMessage } from '../contract/ui-to-agent'

// 传输无关的端口：agent 侧与 ui 侧各自持有对偶的 Port，通过 post/onMessage 收发消息。
// 这一层是 bridge 唯一的新抽象——把「两端如何互通」从具体传输（同进程 / SSE / WebSocket）中抽离。
// post 可以是同步或异步（in-memory 同步投递，SSE 异步 fetch）——返回 void | Promise<void>。
export interface AgentPort {
  /** 订阅来自 UI 的消息，返回退订函数。 */
  onMessage(cb: (msg: UiToAgentMessage) => void): () => void
  /** 向 UI 发消息（发后即忘——同步或异步，取决于传输实现）。 */
  post(msg: AgentToUiMessage): void | Promise<void>
}

export interface UiPort {
  /** 订阅来自 agent 的消息，返回退订函数。 */
  onMessage(cb: (msg: AgentToUiMessage) => void): () => void
  /** 向 agent 发消息（发后即忘——同步或异步，取决于传输实现）。 */
  post(msg: UiToAgentMessage): void | Promise<void>
}
