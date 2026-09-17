// WebUI 视图状态：主区域永远是聊天，面板切换通过 modal 叠加。
// 三主题：Midnight / Forest / Dawn。
export type ThemeName = 'midnight' | 'forest' | 'dawn'

// 主题元数据——侧栏主题切换器 + 命令面板用。
export const THEMES: { theme: ThemeName; label: string; color: string }[] = [
  { theme: 'midnight', label: 'Midnight', color: '#6366F1' },
  { theme: 'forest', label: 'Forest', color: '#22C55E' },
  { theme: 'dawn', label: 'Dawn', color: '#6366F1' },
]

export type Modal =
  | { kind: 'none' }
  | { kind: 'settings' }
  | { kind: 'command-palette' }
  | { kind: 'confirm'; title: string; message: string; onConfirm: () => void }
  | { kind: 'fs-browser'; onConfirm: (path: string) => void }
  | { kind: 'help' }

// 斜杠命令 → modal 导航映射。
// 只有打开 modal 的命令在这里——信息类命令（/context /status /tools /system /log /permissions）
// 不打开 modal，而是在 App 的 onMessage 中展开右侧面板 + toast。
export const COMMAND_TO_MODAL: Record<string, { modal: Exclude<Modal, { kind: 'none' }> }> = {
  '/config': { modal: { kind: 'settings' } },
  '/model': { modal: { kind: 'settings' } },
  '/help': { modal: { kind: 'help' } },
}

// 会话列表项（后端 session_list 返回的形状）。
export interface SessionItem {
  id: string
  updatedAt: string
  preview: string
  /** 会话标题（/rename 手动命名或首轮自动生成）；缺省时列表展示 preview。 */
  title?: string
  cwd?: string
}

// Files Touched 追踪——从 tool_start 的 input 提取文件路径。
export interface FileTouched {
  path: string
  action: 'edit' | 'write'
  toolName: string
  time: number
}
