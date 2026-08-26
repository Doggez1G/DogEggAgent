import React from 'react'
import { Box, Text } from 'ink'

export type BlockColor = 'blue' | 'green' | 'yellow' | 'cyan' | 'red' | 'gray'

// 五种消息块的统一容器：圆角框 + 角色头图标。
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

// 通用选项列表：高亮当前项，供权限三选 / 选择器 / 配置树复用。空列表显示「（暂无）」。
export function ListPicker(props: { title: string; items: string[]; cursor: number; hint: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginY={1}>
      <Text bold color="cyan">{props.title}</Text>
      {props.items.length === 0 ? (
        <Text dimColor>（暂无，esc 返回）</Text>
      ) : (
        props.items.map((it, i) => (
          <Text key={i} inverse={i === props.cursor}>{i === props.cursor ? '> ' : '  '}{it}</Text>
        ))
      )}
      <Text dimColor>{props.hint}</Text>
    </Box>
  )
}