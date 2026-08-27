import React from 'react'
import { Box, Text } from 'ink'
import { palette, type BlockColor } from '../../theme'

// 消息块：圆角边框 + 彩色角色图标 + 加粗角色名 + 缩进正文。
// focused 用 accent 边框标示当前浏览焦点（↑↓ 选中、回车展开的可折叠块）。
export function MessageBlock(props: { icon: string; role: string; color: BlockColor; focused?: boolean; children: React.ReactNode }) {
  return (
    <Box borderStyle="round" borderColor={props.focused ? palette.accent : palette.subtext} flexDirection="column" marginBottom={1} paddingX={1}>
      <Text bold color={props.color}>{props.icon}  {props.role}{props.focused ? '  ▸' : ''}</Text>
      <Box paddingLeft={2}>{props.children}</Box>
    </Box>
  )
}
