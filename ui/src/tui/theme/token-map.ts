import type { BlockKind, ColorToken } from '../../shared'
import { getCurrentPalette } from './palette'

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

// TUI 视觉映射：语义 colorToken → hex 色值（动态读取当前主题）。
export const TOKEN_COLOR: Record<ColorToken, string> = new Proxy({} as Record<ColorToken, string>, {
  get(_target, prop: string) {
    return getCurrentPalette()[prop as keyof ReturnType<typeof getCurrentPalette>] ?? ''
  },
})

// TUI 视觉映射：语义 kind → 中文角色标签。
export const KIND_ROLE: Record<BlockKind, string> = {
  user: '你',
  assistant: '助手',
  thinking: '思考',
  tool: '工具',
  error: '错误',
  notice: '提示',
  auto_compact: '压缩',
}
