import type { PermissionDecision } from '@dogegg/bridge'
import { classify, type PermissionConfig } from './classify'

// 两层权限的运行时层：配置三桶静态分类 + 运行时 allow_always 会话内提升。
// 用户对某工具选 allow_always 后，本会话内该工具不再询问（挪进 sessionAllowed）。
export class PermissionManager {
  private sessionAllowed = new Set<string>()

  constructor(private cfg: PermissionConfig) {}

  classify(tool: string): 'allow' | 'reject' | 'ask' {
    return classify(this.cfg, this.sessionAllowed, tool)
  }

  apply(tool: string, decision: PermissionDecision): void {
    if (decision === 'allow_always') this.sessionAllowed.add(tool)
  }
}
