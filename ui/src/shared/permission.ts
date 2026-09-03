import type { Config } from '@dogegg/bridge'

// 获取工具的权限标签——从 config.permission 的 allow/reject/ask 桶判断。
// WebUI 的 app.tsx (getToolConfigPerm) 和 info-panel (getToolPermission) 共用此函数。
// agent 端的 classify.ts 不能被 UI import（跨包），所以这里是 display-only 的等价实现。
export function getToolPermission(toolName: string, config: Config | null): string {
  if (!config) return 'ask'
  if (config.permission.reject.includes(toolName)) return 'reject'
  if (config.permission.allow.includes(toolName)) return 'allow'
  return 'ask'
}
