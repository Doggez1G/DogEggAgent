import type { BlockKind, ColorToken } from '../../shared'
import { palette } from './palette'

// TUI 视觉映射：语义 kind → emoji 图标（终端限制只能用 emoji）。
export const KIND_ICON: Record<BlockKind, string> = {
  user: '🥚',
  assistant: '🐶',
  thinking: '🐣',
  tool: '🐾',
  error: '🐶',
  notice: '🥚',
  auto_compact: '🐾',
}

// TUI 视觉映射：语义 colorToken → hex 色值（Catppuccin Mocha 调色板）。
export const TOKEN_COLOR: Record<ColorToken, string> = {
  accent: palette.accent,
  text: palette.text,
  cyan: palette.cyan,
  yellow: palette.yellow,
  red: palette.red,
  subtext: palette.subtext,
}

// TUI 视觉映射：语义 kind → 中文角色标签。
export const KIND_ROLE: Record<BlockKind, string> = {
  user: '你',
  assistant: '助手',
  thinking: '思考',
  tool: '工具',
  error: '错误',
  notice: '提示',
  auto_compact: '自动压缩',
}
