import type React from 'react'
import {
  User, Bot, Brain, Wrench, AlertCircle, MessageSquare,
} from 'lucide-react'
import type { BlockKind, ColorToken } from '../../shared/block'

// WebUI 视觉映射：语义 kind → Lucide SVG 图标组件。
// TUI 用 emoji（终端限制），WebUI 用 SVG 矢量图标（可主题化、清晰缩放）。
// Record 查找返回可能 undefined（noUncheckedIndexedAccess），调用方需处理。
// LucideIcon 接受 size/strokeWidth/color 等 props，这里用宽松类型避免与 Lucide 内部类型冲突。
export const KIND_ICON: Record<BlockKind, React.ComponentType<Record<string, unknown>>> = {
  user: User,
  assistant: Bot,
  thinking: Brain,
  tool: Wrench,
  error: AlertCircle,
  notice: MessageSquare,
  auto_compact: Wrench,
}

// WebUI 视觉映射：语义 colorToken → CSS variable 名。
// 各主题 CSS 把 --color-token-* 映射到具体 hex 值。
export const TOKEN_CSS_VAR: Record<ColorToken, string> = {
  accent: 'var(--color-token-accent)',
  text: 'var(--color-token-text)',
  cyan: 'var(--color-token-cyan)',
  yellow: 'var(--color-token-yellow)',
  red: 'var(--color-token-red)',
  subtext: 'var(--color-token-subtext)',
}

// WebUI 视觉映射：语义 kind → 标签文本。
export const KIND_LABEL: Record<BlockKind, string> = {
  user: 'You',
  assistant: 'DogEgg',
  thinking: 'Thinking',
  tool: 'Tool',
  error: 'Error',
  notice: 'Notice',
  auto_compact: 'Compacted',
}
