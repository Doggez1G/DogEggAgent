import type { PermissionDecision } from '@dogegg/bridge'

// 决议结果：decision + 范围提升的模式（allow_always_scoped 时由挂起项带回——
// 模式在请求时由 agent 推导并随 permission_request.alwaysScope 下发）。
export interface PermissionResolution {
  decision: PermissionDecision
  scopePattern?: string
}

interface Pending {
  resolve: (r: PermissionResolution) => void
  reject: (e: Error) => void
  scopePattern?: string
}

// 挂起中的权限请求：request 注册一个待决议 Promise，resolve/rejectAll 在收到决定或取消时结算。
// scopePattern 记录该请求可提供的范围模式（derive 推导），scoped 决议时随决议结果带回。
export class PendingPermissions {
  private map = new Map<string, Pending>()

  add(id: string, pending: Pending): void {
    this.map.set(id, pending)
  }

  resolve(id: string, d: PermissionDecision): void {
    const p = this.map.get(id)
    if (p) { this.map.delete(id); p.resolve({ decision: d, scopePattern: p.scopePattern }) }
  }

  rejectAll(e: Error): void {
    for (const [, p] of this.map) p.reject(e)
    this.map.clear()
  }
}
