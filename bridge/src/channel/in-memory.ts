import type { AgentPort, UiPort } from './port'
import type { AgentToUiMessage } from '../contract/agent-to-ui'
import type { UiToAgentMessage } from '../contract/ui-to-agent'

// 同进程通道：同步投递（与旧 agent.send/emit 的时序语义完全一致），保证行为不变。
// 返回对偶的两端：agentPort 收 UI 来的消息、发往 UI；uiPort 收 agent 来的消息、发往 agent。
// 用 Set 存监听器支持多订阅与退订（onMessage 返回的函数即退订）。
export function createChannelPair(): { agentPort: AgentPort; uiPort: UiPort } {
  const agentListeners = new Set<(m: UiToAgentMessage) => void>()
  const uiListeners = new Set<(m: AgentToUiMessage) => void>()

  return {
    agentPort: {
      onMessage(cb) {
        agentListeners.add(cb)
        return () => { agentListeners.delete(cb) }
      },
      post(msg) { uiListeners.forEach((l) => l(msg)) },
    },
    uiPort: {
      onMessage(cb) {
        uiListeners.add(cb)
        return () => { uiListeners.delete(cb) }
      },
      post(msg) { agentListeners.forEach((l) => l(msg)) },
    },
  }
}
