import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'
import type { Block } from '../../../shared/block'

// DogEgg 品牌化消息渲染——emoji 前缀 + 主题色区分块类型：
//   user:      ❯ 文本（accent 尖括号）
//   assistant: 🐶 头行 + 正文（markdown 渲染后的纯文本）
//   thinking:  🐣 折叠单行（字数）/ 展开显示 dim 全文
//   tool:      🐾 调用行（cyan）+ ⎿ 结果摘要 / 展开显示完整结果与 diff
//   error:     ✕ message（红）
//   notice:    · text（dim）
//   auto_compact: 🥚 压缩提示（dim）
// 折叠/展开由 expanded prop 控制——切换时 App 清屏并重挂 Static 重绘全部块。
export function MessageBlock(props: { block: Block; expanded?: boolean }) {
  const b = props.block
  const expanded = props.expanded ?? false
  switch (b.kind) {
    case 'user':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={palette.accent}>❯ {b.text}</Text>
        </Box>
      )
    case 'assistant':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>🐶 </Text>
          <Text>{b.text}</Text>
        </Box>
      )
    case 'thinking': {
      const full = b.full ?? b.text
      if (!expanded) {
        // 折叠：单行摘要（字数统计基于全文）。
        return (
          <Text dimColor>🐣 思考 · {full.length} 字</Text>
        )
      }
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>🐣 思考（展开）</Text>
          <Text dimColor>{full}</Text>
        </Box>
      )
    }
    case 'tool': {
      // text 首行是调用（name + args JSON），其余是结果摘要。
      const lines = b.text.split('\n')
      const callLine = lines[0] ?? ''
      const callName = callLine.split(' ')[0] ?? '工具'
      const callArgs = truncateMiddle(callLine.slice(callName.length).trim(), 80)
      if (!expanded || !b.full) {
        // 折叠：调用行 + 结果摘要（dim）。
        return (
          <Box flexDirection="column" marginBottom={1}>
            <Text color={palette.cyan}>🐾 {callName}({callArgs})</Text>
            {lines.slice(1).map((l, i) => (
              <Text key={i} dimColor>  ⎿ {truncateMiddle(l, 100)}</Text>
            ))}
          </Box>
        )
      }
      // 展开：调用行 + 完整结果/diff（超长截断到 50 行）。
      const fullLines = b.full.split('\n')
      const clipped = fullLines.slice(1) // 跳过调用行（已在标题显示）
      const truncated = clipped.length > 50
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={palette.cyan}>🐾 {callName}({callArgs})（展开）</Text>
          {clipped.slice(0, 50).map((l, i) => (
            <Text key={i} dimColor>  ⎿ {l}</Text>
          ))}
          {truncated && <Text dimColor>  …（共 {clipped.length} 行，完整输出见 /log）</Text>}
        </Box>
      )
    }
    case 'error':
      return (
        <Text color={palette.red}>✕ {b.text}</Text>
      )
    case 'auto_compact':
      return (
        <Text dimColor>🥚 {b.text}</Text>
      )
    default: // notice
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
