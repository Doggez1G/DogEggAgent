import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'
import type { Block } from '../../../shared/block'

// DogEgg 品牌化消息渲染——强视觉区分设计：
//   user:      圆角气泡框（accent 色，收缩到内容宽度）——消息最醒目的边界
//   assistant: 🐶 DogEgg 绿色粗体头行 + 正文（与 user 的蓝色区分角色）
//   thinking:  折叠=dim 单行；展开=头行+dim 全文
//   tool:      调用行用背景色块（动作事件的强锚点）+ ⎿ dim 结果
//   error:     红色头行+正文
//   notice / auto_compact: dim 单行
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
        <Box
          borderStyle="round"
          borderColor={palette.accent}
          paddingX={1}
          alignSelf="flex-start"
          maxWidth="100%"
        >
          <Text color={palette.accent}>❯ {b.text}</Text>
        </Box>
      )
    case 'assistant':
      return (
        <>
          <Text bold color={palette.green}>🐶 DogEgg</Text>
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
      const callBadge = (
        <Text backgroundColor={palette.subtext} color={palette.cyan}> 🐾 {callName}({callArgs}) </Text>
      )
      if (!expanded || !b.full) {
        // 折叠：调用行（背景块）+ 结果摘要（dim）。
        return (
          <>
            {callBadge}
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
          {callBadge}
          <Text bold dimColor>（已展开）</Text>
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
