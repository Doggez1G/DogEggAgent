import React from 'react'
import { Box, Text } from 'ink'

// Catppuccin Mocha 调色板（暗色、低饱和），落地设计文档 §14。
export const palette = {
  accent: '#89b4fa',
  text: '#cdd6f4',
  subtext: '#6c7086',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  cyan: '#94e2d5',
  red: '#f38ba8',
}

export type BlockColor = string

// 顶部品牌条：应用名 + 版本 + 当前 provider/model。
export function TopBar(props: { info: string }) {
  return (
    <Box marginBottom={1}>
      <Text bold color={palette.accent}>🐶🥚 DogEggAgent v0.1.0</Text>
      <Text dimColor>  {props.info}</Text>
    </Box>
  )
}

// 扁平消息块：彩色角色图标 + 加粗角色名 + 缩进正文；块与块靠角色头 + 间距分隔，不做嵌套边框。
export function MessageBlock(props: { icon: string; role: string; color: BlockColor; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={props.color}>{props.icon}  {props.role}</Text>
      <Box paddingLeft={2}>{props.children}</Box>
    </Box>
  )
}

export function StatusBar(props: { state: string }) {
  return <Text inverse dimColor>{` 🐶🥚 ${props.state} `}</Text>
}

// 通用选项列表（权限三选 / 选择器 / 配置树的覆盖层）：保留圆角框，dim 边框 + accent 标题。
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