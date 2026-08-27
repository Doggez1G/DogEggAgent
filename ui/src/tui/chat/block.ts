import { palette, type BlockColor } from '../theme'

// 消息块模型：一条消息在 UI 中的呈现单元。
// text = 折叠时显示的摘要；full = 展开时显示的完整内容（工具的完整结果）。
export interface Block {
  icon: string
  role: string
  color: BlockColor
  text: string
  full?: string
}

// 「狗蛋」人格：🐶 狗 = 助手/本体，🥚 蛋 = 用户/主人，🐣 思考，🐾 工具。见设计 §14。
export const ICON = { user: '🥚', assistant: '🐶', tool: '🐾', thinking: '🐣' } as const

// 角色 → 颜色映射：用户 accent、助手正文、工具 cyan、思考 yellow。
export const COLOR: Record<keyof typeof ICON, BlockColor> = {
  user: palette.accent,
  assistant: palette.text,
  tool: palette.cyan,
  thinking: palette.yellow,
}
