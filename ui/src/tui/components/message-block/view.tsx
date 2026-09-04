import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'
import type { Block } from '../../../shared/block'

// OpenCode/Codex 风格消息渲染——背景色块 + 克制符号：
//   user:      整行 surface 背景横幅 + 左侧 accent 竖线（对话轮次的强边界）
//   assistant: 无头行直接正文（markdown 富文本）——背景横幅已分轮
//   thinking:  + 思考 · N 字（黄 + 号，dim 元信息）／展开显示全文
//   tool:      ▪ name(args)（青色小方块）+ ⎿ dim 摘要／展开显示完整结果
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
        // 整行背景横幅：surface 底 + 左侧 accent 竖线（OpenCode 同款）。
        <Box borderStyle="round" borderTop={false} borderBottom={false} borderRight={false} borderColor={palette.accent} backgroundColor={palette.surface} paddingX={1}>
          <Text>{b.text}</Text>
        </Box>
      )
    case 'assistant':
      // 无头行——回复直接输出（markdown 富文本），靠 user 背景横幅分轮。
      return <Text>{b.text}</Text>
    case 'thinking': {
      const full = b.full ?? b.text
      if (!expanded) {
        return <Text color={palette.subtext}>+ 思考 · {full.length} 字</Text>
      }
      return (
        <>
          <Text color={palette.yellow}>+ 思考（展开）</Text>
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
          <Text color={palette.cyan}>▪ {callName}</Text>
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
          <Text color={palette.yellow}>  ↑ 已展开（Ctrl+Enter 或浏览模式 Enter 折叠）</Text>
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
      return <Text color={palette.subtext}>· {b.text}</Text>
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
