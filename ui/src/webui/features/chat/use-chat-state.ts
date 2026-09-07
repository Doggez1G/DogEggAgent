import { useEffect, useReducer } from 'react'
import type { UiPort } from '@dogegg/bridge'
import { reducer, type ChatState, type Action } from '../../../shared'

const initialState: ChatState = { blocks: [], status: 'idle', partial: null, toolActive: false }

// chat 数据域：每条 agent 消息都进 reducer（它认识全部消息类型）。
// 其它特征（面板/追踪/会话）各自订阅 port 处理自己的子集——多订阅合法。
export function useChatState(port: UiPort): { chat: ChatState; dispatch: (action: Action) => void } {
  const [chat, dispatch] = useReducer(reducer, initialState)
  useEffect(() => {
    const off = port.onMessage((msg) => dispatch(msg))
    return off
  }, [port])
  return { chat, dispatch }
}
