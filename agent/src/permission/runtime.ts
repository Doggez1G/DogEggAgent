import type { PermissionDecision } from '@dogegg/bridge'
import { classify, type PermissionConfig } from './classify'

// 两层权限的运行时层：配置三桶静态分类 + 运行时 allow_always 会话内提升。
// 用户对某工具选 allow_always 后，本会话内该工具不再询问（挪进 sessionAllowed）。
// ⚠️ 会话隔离：allow_always 只对当前会话生效，新建/切换会话时应调 reset() 清空。
export class PermissionManager {
  private sessionAllowed = new Set<string>()

  constructor(private cfg: PermissionConfig) {}

  classify(tool: string): 'allow' | 'reject' | 'ask' {
    return classify(this.cfg, this.sessionAllowed, tool)
  }

  apply(tool: string, decision: PermissionDecision): void {
    if (decision === 'allow_always') this.sessionAllowed.add(tool)
  }

  // 清空运行时 allow_always 授权——新建/切换会话时调用，实现权限会话隔离。
  reset(): void {
    this.sessionAllowed.clear()
  }

  // 导出当前 allow_always 集合——配置编辑时保留授权用。
  snapshot(): ReadonlySet<string> {
    return new Set(this.sessionAllowed)
  }
}
