import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'
import type { Block } from '../../../shared/block'

// DogEgg 品牌化消息渲染——三层视觉层次：轮次 > 块 > 行。
//   轮次：每条用户消息前画 dim 分隔线（对话轮次的边界）
//   块：  emoji 前缀 + 主题色头行（❯ user / 🐶 assistant / 🐣 thinking / 🐾 tool）
//   行：  正文普通色，辅助信息（工具结果等）dim 缩进
// 所有块统一 marginBottom=1 空行分隔——折叠/展开切换时 App 清屏重挂 Static 重绘。
export function MessageBlock(props: { block: Block; expanded?: boolean; width?: number }) {
  const b = props.block
  const expanded = props.expanded ?? false
  const divider = '─'.repeat(Math.max(20, Math.min(80, (props.width ?? 80) - 1)))
  return (
    <Box flexDirection="column" marginBottom={1}>
      {renderBlock(b, expanded, divider)}
    </Box>
  )
}

function renderBlock(b: Block, expanded: boolean, divider: string): React.ReactNode {
  switch (b.kind) {
    case 'user':
      return (
        <>
          <Text dimColor>{divider}</Text>
          <Text color={palette.accent}>❯ {b.text}</Text>
        </>
      )
    case 'assistant':
      return (
        <>
          <Text bold color={palette.accent}>🐶 DogEgg</Text>
          <Text>{b.text}</Text>
        </>
      )
    case 'thinking': {
      const full = b.full ?? b.text
      if (!expanded) {
        return <Text dimColor>🐣 思考 · {full.length} 字</Text>
      }
      return (
        <>
          <Text bold dimColor>🐣 思考（展开）</Text>
          <Text dimColor>{full}</Text>
        </>
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
          <>
            <Text bold color={palette.cyan}>🐾 {callName}({callArgs})</Text>
            {lines.slice(1).map((l, i) => (
              <Text key={i} dimColor>  ⎿ {truncateMiddle(l, 100)}</Text>
            ))}
          </>
        )
      }
      // 展开：调用行 + 完整结果/diff（超长截断到 50 行）。
      const fullLines = b.full.split('\n')
      const clipped = fullLines.slice(1) // 跳过调用行（已在标题显示）
      const truncated = clipped.length > 50
      return (
        <>
          <Text bold color={palette.cyan}>🐾 {callName}({callArgs})（展开）</Text>
          {clipped.slice(0, 50).map((l, i) => (
            <Text key={i} dimColor>  ⎿ {l}</Text>
          ))}
          {truncated && <Text dimColor>  …（共 {clipped.length} 行，完整输出见 /log）</Text>}
        </>
      )
    }
    case 'error':
      return (
        <>
          <Text bold color={palette.red}>✕ 出错了</Text>
          <Text color={palette.red}>{b.text}</Text>
        </>
      )
    case 'auto_compact':
      return <Text dimColor>🥚 {b.text}</Text>
    default: // notice
      return <Text dimColor>· {b.text}</Text>
  }
}

// 中间截断：保留头尾，中间以 … 代替（比尾部截断保留更多信息）。
function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s
  const half = Math.floor(max / 2)
  return s.slice(0, half) + '…' + s.slice(s.length - half)
}
