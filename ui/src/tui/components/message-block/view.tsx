import React from 'react'
import { Box, Text } from 'ink'
import { palette, type BlockColor } from '../../theme'

// 消息块：左侧色条 + 角色头 + dim 分隔线 + 缩进正文，无全框（减少边框噪音）。
// focused 用 accent 左侧色条 + ▸ 标示当前浏览焦点。
// 块间靠 marginBottom 留白分隔，而非边框——视觉更呼吸。
// 角色头和正文之间加 dim 分隔线，增加层次感。
export function MessageBlock(props: { icon: string; role: string; color: BlockColor; focused?: boolean; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1}>
        <Text color={props.focused ? palette.accent : props.color}>{props.focused ? '▌' : '│'}</Text>
        <Box flexDirection="column" flexGrow={1}>
          <Text bold color={props.focused ? palette.accent : props.color}>
            {props.icon} {props.role}{props.focused ? '  ▸' : ''}
          </Text>
          <Box paddingLeft={0} marginTop={0}>
            {props.children}
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
