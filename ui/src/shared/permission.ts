import { classifyPermission, type Config } from '@dogegg/bridge'

// 工具权限标签（display-only）：null 配置视为 ask。
// 三桶判定逻辑归 bridge 的 classifyPermission——契约 schema 的唯一解释者，UI 不再自行实现。
export function getToolPermission(toolName: string, config: Config | null): string {
  if (!config) return 'ask'
  return classifyPermission(config.permission, toolName)
}
