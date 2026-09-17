import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'
import { filterSessions, relTime } from './filter'
import type { View } from '../../view-state'

// 会话选择器视图：目录标题 + 搜索行 + 窗口化列表（最多 12 项，cursor 靠边滚动）。
export function SessionPickerOverlay({ view, cwd }: { view: Extract<View, { kind: 'sessionPicker' }>; cwd: string }) {
  const filtered = filterSessions(view.sessions, view.query)
  const dirName = cwd ? cwd.replace(/\\/g, '/').split('/').pop() ?? cwd : ''
  const WIN = 12
  const start = Math.max(0, Math.min(view.cursor - WIN + 3, Math.max(0, filtered.length - WIN)))
  const windowed = filtered.slice(start, start + WIN)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.accent}>选择会话 — {dirName || '当前目录'}</Text>
      <Text dimColor>搜索: {view.query || '（输入过滤）'}{'_'}</Text>
      {windowed.length === 0 ? (
        <Text dimColor>（无匹配会话）</Text>
      ) : (
        windowed.map((s, i) => {
          const realIdx = start + i
          return (
            <Text key={s.id} inverse={realIdx === view.cursor}>{realIdx === view.cursor ? '> ' : '  '}{s.title || s.preview} <Text dimColor>{relTime(s.updatedAt)}</Text></Text>
          )
        })
      )}
      {filtered.length > WIN && <Text dimColor>（{filtered.length} 项，↑↓ 滚动）</Text>}
      <Text dimColor>↑↓ 选择 · 回车切换 · d 删除 · esc 返回</Text>
    </Box>
  )
}
