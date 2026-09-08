import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'
import { isExpandable } from '../../../shared'
import type { Block } from '../../../shared'

const KIND_LABEL: Record<string, string> = {
  user: '你的消息', assistant: 'DogEgg 回复', thinking: '思考',
  tool: '工具调用', error: '错误', notice: '提示', auto_compact: '压缩',
}

// 浏览模式状态条：当前焦点块的信息 + 内容预览（焦点块在 Static 缓冲区里，无法就地高亮，用此条反馈）。
export function BrowseStatusBar({ idx, total, block, expanded }: {
  idx: number
  total: number
  block: Block | undefined
  expanded: boolean
}) {
  const expandable = block ? isExpandable(block) : false
  // 内容预览：取块文本前 2 行（去除 ANSI），每行截断 60 字符。
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
  const previewLines = block ? stripAnsi(block.text).split('\n').slice(0, 2).map((l) => l.length > 60 ? l.slice(0, 60) + '…' : l) : []
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text backgroundColor={palette.surfaceAlt} color={palette.text}> 🔍 {idx + 1}/{total} {block ? KIND_LABEL[block.kind] ?? block.kind : ''}{expandable ? (expanded ? ' · 已展开' : ' · 已折叠') : ''} </Text>
      </Text>
      {previewLines.map((l, i) => (
        <Text key={i} dimColor>  ┃ {l}</Text>
      ))}
      <Text dimColor>Ctrl+↑↓ 切换块{expandable ? ' · Enter 展开/折叠' : ''} · Esc 退出浏览</Text>
    </Box>
  )
}
