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
  // 请求快照字段（snapshot 重发挂起审批用）：tool/input 是 permission_request 的载荷，
  // scopePattern 由 derive 推导、随 alwaysScope 下发——重发时按原样还原线上消息形态。
  tool: string
  input: unknown
  scopePattern?: string
}

// 挂起项的对外快照：字段命名镜像 permission_request 线上消息（alwaysScope 是 { pattern } 包装形态），
// 重发侧可直接展开进 permission_request 消息，无需二次映射。
export interface PendingSnapshot {
  id: string
  tool: string
  input: unknown
  alwaysScope?: { pattern: string }
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

  // 挂起项快照：恢复链的一部分——刷新页面/断线重连后前端丢失挂起中的审批，
  // 按原 id 重发 permission_request（同 id 幂等，UI 按 id 关联决议）即可恢复。
  snapshot(): PendingSnapshot[] {
    return [...this.map.entries()].map(([id, p]) => ({
      id,
      tool: p.tool,
      input: p.input,
      ...(p.scopePattern ? { alwaysScope: { pattern: p.scopePattern } } : {}),
    }))
  }

  rejectAll(e: Error): void {
    for (const [, p] of this.map) p.reject(e)
    this.map.clear()
  }
}
