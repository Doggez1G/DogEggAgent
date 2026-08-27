import type { AgentToUiMessage } from '../contract/agent-to-ui'
import type { UiToAgentMessage } from '../contract/ui-to-agent'

// 传输无关的端口：agent 侧与 ui 侧各自持有对偶的 Port，通过 post/onMessage 收发消息。
// 这一层是 bridge 唯一的新抽象——把「两端如何互通」从具体传输（同进程 / SSE / WebSocket）中抽离。
// 将来接 WebUI 时，在 bridge 内新增 sse-channel.ts 实现同一 Port 接口，agent 与 ui 一行不改。
export interface AgentPort {
  /** 订阅来自 UI 的消息，返回退订函数。 */
  onMessage(cb: (msg: UiToAgentMessage) => void): () => void
  /** 向 UI 发消息（发后即忘，同步、无返回值——模仿真实消息边界，UI 不能 await agent 方法）。 */
  post(msg: AgentToUiMessage): void
}

export interface UiPort {
  /** 订阅来自 agent 的消息，返回退订函数。 */
  onMessage(cb: (msg: AgentToUiMessage) => void): () => void
  /** 向 agent 发消息（发后即忘）。 */
  post(msg: UiToAgentMessage): void
}
