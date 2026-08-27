import type { PermissionDecision } from '@dogegg/bridge'

export interface PermissionConfig {
  allow: string[]
  reject: string[]
  ask: string[]
}

// 两层权限：配置三桶静态分类（allow/reject/ask），运行时 allow_always 会把工具在本会话内挪进 allow。
export class PermissionManager {
  private sessionAllowed = new Set<string>()

  constructor(private cfg: PermissionConfig) {}

  classify(tool: string): 'allow' | 'reject' | 'ask' {
    if (this.cfg.reject.includes(tool)) return 'reject'
    if (this.cfg.allow.includes(tool) || this.sessionAllowed.has(tool)) return 'allow'
    return 'ask' // 未显式列出的默认询问，倾向安全
  }

  apply(tool: string, decision: PermissionDecision): void {
    if (decision === 'allow_always') this.sessionAllowed.add(tool)
  }
}