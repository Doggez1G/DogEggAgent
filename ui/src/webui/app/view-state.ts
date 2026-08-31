// WebUI 视图状态：panel（持久侧栏选择）+ modal（中断性弹窗，叠加在任意面板之上）。
// 区别于 TUI 的单选一 View（聊天 XOR overlay）：WebUI 的 panel 持久保留，modal 独立叠加。
export type Panel = 'chat' | 'sessions' | 'settings'
export type SettingsTab = 'general' | 'models' | 'permissions' | 'tools' | 'context' | 'system-prompt' | 'logs'
export type ThemeName = 'catppuccin' | 'ios-light' | 'ios-dark'

export type Modal =
  | { kind: 'none' }
  | { kind: 'permission'; id: string; tool: string; input: unknown }
  | { kind: 'confirm'; title: string; message: string; onConfirm: () => void }
  | { kind: 'fs-browser' }
  | { kind: 'help' }

// 斜杠命令 → 面板/设置导航映射。
// 输入斜杠命令后导航到对应面板而非弹 overlay（与 TUI 的 overlay 模式不同）。
export const COMMAND_TO_NAV: Record<string, { panel?: Panel; settingsTab?: SettingsTab; modal?: 'help' | 'fs-browser' }> = {
  '/config': { panel: 'settings', settingsTab: 'general' },
  '/model': { panel: 'settings', settingsTab: 'models' },
  '/permissions': { panel: 'settings', settingsTab: 'permissions' },
  '/tools': { panel: 'settings', settingsTab: 'tools' },
  '/context': { panel: 'settings', settingsTab: 'context' },
  '/system': { panel: 'settings', settingsTab: 'system-prompt' },
  '/log': { panel: 'settings', settingsTab: 'logs' },
  '/session': { panel: 'sessions' },
  '/help': { modal: 'help' },
  '/cd': { modal: 'fs-browser' },
  '/status': { modal: 'help' },
}
