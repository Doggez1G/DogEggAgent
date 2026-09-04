import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'
import { KIND_ICON, TOKEN_COLOR, KIND_ROLE } from '../../theme/token-map'
import type { BlockKind, ColorToken } from '../../../shared/block'

// 消息块：左侧色条 + 角色头 + dim 分隔线 + 缩进正文，无全框（减少边框噪音）。
// focused 用 accent 左侧色条 + ▸ 标示当前浏览焦点。
// 块间靠 marginBottom 留白分隔，而非边框——视觉更呼吸。
// showHeader=false 时只渲染正文（块顶部被视口裁切时不重复显示角色头）。
export function MessageBlock(props: { kind: BlockKind; color: ColorToken; focused?: boolean; showHeader?: boolean; children: React.ReactNode }) {
  const icon = KIND_ICON[props.kind]
  const role = KIND_ROLE[props.kind]
  const colorHex = TOKEN_COLOR[props.color]
  const showHeader = props.showHeader !== false
  return (
    <Box flexDirection="column" marginBottom={showHeader ? 1 : 0}>
      <Box gap={1}>
        <Text color={props.focused ? palette.accent : colorHex}>{props.focused ? '▌' : '│'}</Text>
        <Box flexDirection="column" flexGrow={1}>
          {showHeader && (
            <Text bold color={props.focused ? palette.accent : colorHex}>
              {icon} {role}{props.focused ? '  ▸' : ''}
            </Text>
          )}
          <Box paddingLeft={0} marginTop={0}>
            {props.children}
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
