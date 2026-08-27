import type { PermissionDecision } from '@dogegg/bridge'

interface Pending {
  resolve: (d: PermissionDecision) => void
  reject: (e: Error) => void
}

// 挂起中的权限请求：request 注册一个待决议 Promise，resolve/rejectAll 在收到决定或取消时结算。
// 从旧 Agent 类抽出的权限挂起表，归此独立成可测模块。
export class PendingPermissions {
  private map = new Map<string, Pending>()

  add(id: string, pending: Pending): void {
    this.map.set(id, pending)
  }

  resolve(id: string, d: PermissionDecision): void {
    const p = this.map.get(id)
    if (p) { this.map.delete(id); p.resolve(d) }
  }

  rejectAll(e: Error): void {
    for (const [, p] of this.map) p.reject(e)
    this.map.clear()
  }
}
