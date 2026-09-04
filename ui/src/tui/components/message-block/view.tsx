import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'
import type { Block } from '../../../shared/block'

// DogEgg 品牌消息渲染（OpenCode/Codex 骨架 + DogEgg 蛋狗家族 emoji）：
//   user:      整行 surface 背景横幅 + 左 accent 竖线 + 🥚 前缀（蛋=用户开壳发言）
//   assistant: 首行内联 🐶 前缀（狗蛋开口），正文 markdown 富文本
//   thinking:  🐣 思考 · N 字（破壳思考）／展开显示全文
//   tool:      🐾 name(args)（狗爪干活）+ dim 摘要／展开显示完整结果
//   error:     ✕ 红色
//   notice / auto_compact: · dim
// 折叠/展开由 expanded prop 控制——切换时 App 清屏并重挂 Static 重绘全部块。
export function MessageBlock(props: { block: Block; expanded?: boolean }) {
  const b = props.block
  const expanded = props.expanded ?? false
  return (
    <Box flexDirection="column" marginBottom={1}>
      {renderBlock(b, expanded)}
    </Box>
  )
}

function renderBlock(b: Block, expanded: boolean): React.ReactNode {
  switch (b.kind) {
    case 'user':
      return (
        // 整行背景横幅：surface 底 + 左侧 accent 竖线 + 🥚 前缀。
        <Box borderStyle="round" borderTop={false} borderBottom={false} borderRight={false} borderColor={palette.accent} backgroundColor={palette.surface} paddingX={1}>
          <Text>🥚 {b.text}</Text>
        </Box>
      )
    case 'assistant': {
      // 首行内联 🐶 前缀（不是整行头——保持 OpenCode 的克制），后续行直接输出。
      const lines = b.text.split('\n')
      const first = lines[0] ?? ''
      const rest = lines.slice(1)
      return (
        <>
          <Text>
            <Text>🐶 </Text>
            <Text>{first}</Text>
          </Text>
          {rest.length > 0 && <Text>{rest.join('\n')}</Text>}
        </>
      )
    }
    case 'thinking': {
      const full = b.full ?? b.text
      if (!expanded) {
        return (
          <Text>
            <Text>🐣 </Text>
            <Text color={palette.subtext}>思考 · {full.length} 字</Text>
          </Text>
        )
      }
      return (
        <>
          <Text>🐣 <Text color={palette.yellow}>思考（展开）</Text></Text>
          <Text dimColor>{full}</Text>
        </>
      )
    }
    case 'tool': {
      // text 首行是调用（name + args JSON），其余是结果摘要。
      const lines = b.text.split('\n')
      const callLine = lines[0] ?? ''
      const callName = callLine.split(' ')[0] ?? '工具'
      const callArgs = truncateMiddle(callLine.slice(callName.length).trim(), 70)
      const summaryLines = lines.slice(1)
      const head = (
        <Text>
          <Text color={palette.cyan}>🐾 {callName}</Text>
          <Text color={palette.subtext}>({callArgs})</Text>
          {summaryLines.length > 0 && <Text color={palette.subtext}> · {truncateMiddle(summaryLines[0]!.replace(/^[✓✕] /, ''), 50)}</Text>}
        </Text>
      )
      if (!expanded || !b.full) {
        return (
          <>
            {head}
            {summaryLines.slice(1).map((l, i) => (
              <Text key={i} color={palette.subtext}>  ⎿ {truncateMiddle(l, 100)}</Text>
            ))}
          </>
        )
      }
      // 展开：完整结果/diff（超长截断到 50 行）。
      const fullLines = b.full.split('\n')
      const clipped = fullLines.slice(1) // 跳过调用行
      const truncated = clipped.length > 50
      return (
        <>
          {head}
          <Text color={palette.yellow}>  ↑ 已展开</Text>
          {clipped.slice(0, 50).map((l, i) => (
            <Text key={i} color={palette.subtext}>  ⎿ {l}</Text>
          ))}
          {truncated && <Text color={palette.subtext}>  …（共 {clipped.length} 行，完整输出见 /log）</Text>}
        </>
      )
    }
    case 'error':
      return (
        <>
          <Text color={palette.red}>✕ 出错了</Text>
          <Text color={palette.red}>{b.text}</Text>
        </>
      )
    case 'auto_compact':
      return <Text color={palette.subtext}>🥚 {b.text}</Text>
    default: // notice
      return <Text color={palette.subtext}>· {b.text}</Text>
  }
}

// 中间截断：保留头尾，中间以 … 代替（比尾部截断保留更多信息）。
function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s
  const half = Math.floor(max / 2)
  return s.slice(0, half) + '…' + s.slice(s.length - half)
}
