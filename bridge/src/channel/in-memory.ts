import type { AgentPort, UiPort } from './port'
import type { AgentToUiMessage } from '../contract/agent-to-ui'
import type { UiToAgentMessage } from '../contract/ui-to-agent'

// 同进程通道：同步投递（与旧 agent.send/emit 的时序语义完全一致），保证行为不变。
// 持有对偶的两端：agentPort 收 UI 来的消息、发往 UI；uiPort 收 agent 来的消息、发往 agent。
// 用 Set 存监听器支持多订阅与退订（onMessage 返回的函数即退订）。
export class InMemoryChannel {
  private readonly agentListeners = new Set<(m: UiToAgentMessage) => void>()
  private readonly uiListeners = new Set<(m: AgentToUiMessage) => void>()

  readonly agentPort: AgentPort
  readonly uiPort: UiPort

  constructor() {
    this.agentPort = {
      onMessage: (cb) => {
        this.agentListeners.add(cb)
        return () => { this.agentListeners.delete(cb) }
      },
      post: (msg) => { this.uiListeners.forEach((l) => l(msg)) },
    }
    this.uiPort = {
      onMessage: (cb) => {
        this.uiListeners.add(cb)
        return () => { this.uiListeners.delete(cb) }
      },
      post: (msg) => { this.agentListeners.forEach((l) => l(msg)) },
    }
  }
}
