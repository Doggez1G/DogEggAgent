import type { ConfigPath } from '../overlays/config'

// UI 自己的视图态（叠加在后端状态机之上，二者正交）。
// 决定当前显示哪个 overlay：无 / 权限弹层 / 菜单选择器 / 标量输入 / 配置编辑器 / 只读信息面板。
export type View =
  | { kind: 'none' }
  | { kind: 'permission'; id: string; tool: string; input: unknown; cursor: number }
  | { kind: 'menu'; title: string; items: { label: string; onSelect: () => void }[]; cursor: number }
  | { kind: 'prompt'; title: string; value: string; onSubmit: (v: string) => void; returnPath?: ConfigPath; returnCursor?: number }
  | { kind: 'config'; path: ConfigPath; cursor: number; preview: boolean | null }
  | { kind: 'info'; title: string; lines: string[] } // /context /tools /status /system /log /help 的只读面板
