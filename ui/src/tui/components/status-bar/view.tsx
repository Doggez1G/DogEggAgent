import React from 'react'
import { Text } from 'ink'

// 状态栏：反色显示当前 agent 状态（来自后端 state 事件）。
export function StatusBar(props: { state: string }) {
  return <Text inverse dimColor>{` 🐶🥚 ${props.state} `}</Text>
}
