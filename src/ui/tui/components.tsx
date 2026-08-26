import React from 'react'
import { Box, Text } from 'ink'

export type BlockColor = 'blue' | 'green' | 'yellow' | 'cyan' | 'red' | 'gray'

// 五种消息块的统一容器：圆角框 + 角色头图标 + 可折叠正文（折叠交互后续补，先完整展示）。
export function MessageBlock(props: { icon: string; role: string; color: BlockColor; children: React.ReactNode }) {
  return (
    <Box borderStyle="round" borderColor="gray" flexDirection="column" marginBottom={1}>
      <Text bold color={props.color}>{props.icon} {props.role}</Text>
      <Box paddingLeft={2}>{props.children}</Box>
    </Box>
  )
}

export function StatusBar(props: { state: string }) {
  return <Text inverse dimColor>{`🐶🥚  ${props.state}`}</Text>
}