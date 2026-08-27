import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'

// 通用选项列表：权限三选 / 会话选择器 / 模型选择器 / 配置树的覆盖层共用。
// 圆角框 + dim 边框 + accent 标题 + cursor 反色高亮。
export function ListPicker(props: { title: string; items: string[]; cursor: number; hint: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.subtext} paddingX={1} marginY={1}>
      <Text bold color={palette.accent}>{props.title}</Text>
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
