import React from 'react'
import { Box, Text } from 'ink'
import { MultilineInput } from '../../components'
import { palette } from '../../theme'
import type { View } from '../../view-state'

// 标量输入弹层视图：标题 + 内联输入框。onSubmit 前需要吞掉回车（与其它命令一致）。
// 用项目内 MultilineInput 而非 ink-text-input：后者把 Ctrl+A/U/W/V 等解析出的普通字母
// 直接插入文本（P2-26），且 delete/backspace 合并处理（P2-28）——MultilineInput 已修复，
// 两端按键语义一致。view.kind === 'prompt' 期间主输入框不渲染，无焦点冲突。
export function PromptOverlay({ view, setView, suppressEnter }: {
  view: Extract<View, { kind: 'prompt' }>
  setView(view: View): void
  suppressEnter(): void
}) {
  return (
    <Box>
      <Text color={palette.cyan}>{view.title} → </Text>
      <MultilineInput
        value={view.value}
        placeholder=" " // 空值时渲染一个反色空格占位——相当于光标块，保持输入焦点可见
        onChange={(val) => setView({ ...view, value: val })}
        onSubmit={(val) => {
          suppressEnter()
          view.onSubmit(val)
        }}
      />
    </Box>
  )
}
