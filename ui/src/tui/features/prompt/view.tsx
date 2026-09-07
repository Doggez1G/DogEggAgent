import React from 'react'
import { Box, Text } from 'ink'
import TextInput from 'ink-text-input'
import { palette } from '../../theme'
import type { View } from '../../view-state'

// 标量输入弹层视图：标题 + 内联 TextInput。onSubmit 前需要吞掉回车（与其它命令一致）。
export function PromptOverlay({ view, setView, suppressEnter }: {
  view: Extract<View, { kind: 'prompt' }>
  setView(view: View): void
  suppressEnter(): void
}) {
  return (
    <Box>
      <Text color={palette.cyan}>{view.title} → </Text>
      <TextInput
        value={view.value}
        onChange={(val) => setView({ ...view, value: val })}
        onSubmit={(val) => {
          suppressEnter()
          view.onSubmit(val)
        }}
      />
    </Box>
  )
}
