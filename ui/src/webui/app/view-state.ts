// WebUI 视图状态：主区域永远是聊天，面板切换通过 modal 叠加。
// Panel 类型已删除——不再有 sessions/settings panel，改为侧栏导航 + modal。
export type SettingsTab = 'general' | 'models' | 'permissions'
export type ThemeName = 'catppuccin' | 'ios-light' | 'ios-dark'

export type Modal =
  | { kind: 'none' }
  | { kind: 'settings'; tab: SettingsTab }
  | { kind: 'permission'; id: string; tool: string; input: unknown }
  | { kind: 'confirm'; title: string; message: string; onConfirm: () => void }
  | { kind: 'fs-browser'; onConfirm: (path: string) => void }
  | { kind: 'help' }

// 斜杠命令 → modal/设置导航映射。
// 设置类命令打开 settings modal；信息类命令（/tools /context /system /log /status）
// 不再打开设置——信息在右侧面板实时显示。
export const COMMAND_TO_MODAL: Record<string, { modal: Exclude<Modal, { kind: 'none' }> }> = {
  '/config': { modal: { kind: 'settings', tab: 'general' } },
  '/model': { modal: { kind: 'settings', tab: 'models' } },
  '/permissions': { modal: { kind: 'settings', tab: 'permissions' } },
  '/help': { modal: { kind: 'help' } },
  '/status': { modal: { kind: 'help' } },
}

// 会话列表项（后端 session_list 返回的形状）。
export interface SessionItem {
  id: string
  updatedAt: string
  preview: string
  cwd?: string
}
