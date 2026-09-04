import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'
import type { Block } from '../../../shared/block'

// Claude Code 风格消息渲染——极简，靠前缀符号和颜色区分块类型，无边框无角色头：
//   user:      > 文本（accent 色尖括号）
//   assistant: 正文直接输出（markdown 渲染后的纯文本）
//   thinking:  ✻ 思考 + dim 全文
//   tool:      ⏺ name(args) 青色 + dim 结果摘要（⎿ 前缀缩进）
//   error:     ✕ message（红）
//   notice / auto_compact: · text（dim）
export function MessageBlock(props: { block: Block }) {
  const b = props.block
  switch (b.kind) {
    case 'user':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={palette.accent}>{'> '}</Text>
          <Text>{b.text}</Text>
        </Box>
      )
    case 'assistant':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>{b.text}</Text>
        </Box>
      )
    case 'thinking':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>✻ 思考</Text>
          <Text dimColor>{b.full ?? b.text}</Text>
        </Box>
      )
    case 'tool': {
      // text 首行是调用（name + args JSON），其余是结果摘要。args JSON 截断防超长。
      const lines = b.text.split('\n')
      const callLine = lines[0] ?? ''
      const callName = callLine.split(' ')[0] ?? '工具'
      const rest = lines.slice(1)
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={palette.cyan}>⏺ {callName}({truncateMiddle(callLine.slice(callName.length).trim(), 80)})</Text>
          {rest.map((l, i) => (
            <Text key={i} dimColor>  ⎿ {l}</Text>
          ))}
        </Box>
      )
    }
    case 'error':
      return (
        <Text color={palette.red}>✕ {b.text}</Text>
      )
    default: // notice / auto_compact
      return (
        <Text dimColor>· {b.text}</Text>
      )
  }
}

// 中间截断：保留头尾，中间以 … 代替（比尾部截断保留更多信息）。
function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s
  const half = Math.floor(max / 2)
  return s.slice(0, half) + '…' + s.slice(s.length - half)
}
