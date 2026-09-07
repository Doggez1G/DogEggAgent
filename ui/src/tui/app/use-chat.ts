import { useEffect, useReducer } from 'react'
import type { UiPort } from '@dogegg/bridge'
import { reducer, type ChatState, type Action } from '../../shared'

const initialState: ChatState = { blocks: [], status: 'idle', partial: null, toolActive: false }

// chat 数据域：每条 agent 消息都进 reducer（它认识全部消息类型）。
// UI 视图侧效应（开 overlay / 清屏重挂载 / 错误回填）归 use-agent-events——两个订阅域正交。
export function useChat(port: UiPort): { chat: ChatState; dispatch: (action: Action) => void } {
  const [chat, dispatch] = useReducer(reducer, initialState)
  useEffect(() => {
    const off = port.onMessage((msg) => dispatch(msg))
    return off
  }, [port])
  return { chat, dispatch }
}
