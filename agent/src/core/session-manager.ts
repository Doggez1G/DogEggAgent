import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentToUiMessage } from '@dogegg/bridge'
import type { BusyGate } from './busy-gate'
import type { Conversation } from './conversation'
import type { SessionStore } from '../session'
import type { PermissionManager } from '../permission'

// 会话生命周期：new / resume / delete / list / clear 的实现归属。
// 会话隔离：allow_always 授权随 PermissionManager.reset() 只对当前会话生效。
export class SessionManager {
  constructor(private readonly deps: {
    conversation: Conversation
    gate: BusyGate
    sessions: SessionStore
    permission: () => PermissionManager
    emit: (m: AgentToUiMessage) => void
  }) {}

  // R2：动工作集类命令运行中阻塞（发 notice 不静默丢弃）。
  private blocked(): boolean {
    if (this.deps.gate.busy) {
      this.deps.emit({ type: 'notice', text: '运行中，请稍候' })
      return true
    }
    return false
  }

  // 新建会话：可选指定工作目录（WebUI 项目树添加会话时传入）。
  newSession(cwd?: string): void {
    if (this.blocked()) return
    if (cwd) {
      try {
        const resolved = resolve(cwd)
        if (!statSync(resolved).isDirectory()) { this.deps.emit({ type: 'notice', text: `${cwd} 不是目录` }); return }
        this.deps.conversation.setCwd(resolved)
      } catch { this.deps.emit({ type: 'notice', text: `路径不存在：${cwd}` }); return }
    }
    this.deps.conversation.reset()
    this.deps.permission().reset() // 会话隔离：allow_always 只对当前会话生效
    // 立即保存空会话——让 list_sessions 能返回新会话（侧栏即时显示）。
    try { this.save() } catch { /* 磁盘错误忽略 */ }
    this.deps.emit({ type: 'session_ready', id: this.deps.conversation.getId(), messages: [] })
  }

  resume(id: string): void {
    if (this.blocked()) return
    try {
      const s = this.deps.sessions.load(id)
      this.deps.conversation.load(s)
      // 恢复该会话的 allow_always 授权（resume 不清空，保留之前设置的授权）。
      this.deps.permission().reset()
      for (const t of s.allowedTools) this.deps.permission().apply(t, 'allow_always')
      const thinking = this.deps.conversation.getThinking()
      this.deps.emit({
        type: 'session_ready',
        id: s.id,
        messages: [...this.deps.conversation.getHistory()],
        ...(thinking.length ? { thinking: [...thinking] } : {}),
      })
    } catch {
      this.deps.emit({ type: 'notice', text: `会话 ${id} 加载失败（文件不存在或已损坏）` })
    }
  }

  clearHistory(): void {
    if (this.blocked()) return
    this.deps.conversation.clearMessages()
    this.deps.emit({ type: 'history_cleared' })
  }

  list(): void {
    try { this.deps.emit({ type: 'session_list', sessions: this.deps.sessions.list() }) }
    catch { this.deps.emit({ type: 'notice', text: '会话列表读取失败' }) }
  }

  // 删除会话文件——运行中阻塞（不能删正在使用的会话）。
  deleteSession(id: string): void {
    if (this.blocked()) return
    try {
      this.deps.sessions.delete(id)
      this.deps.emit({ type: 'session_deleted', id })
      // 如果删除的是当前会话，发一个 notice 提示。
      if (id === this.deps.conversation.getId()) {
        this.deps.emit({ type: 'notice', text: '当前会话已删除' })
      }
    } catch {
      this.deps.emit({ type: 'notice', text: `会话 ${id} 删除失败` })
    }
  }

  // 落盘快照（静默版：新建会话时保存失败不打扰用户）。
  private save(): void {
    this.deps.sessions.save({ ...this.deps.conversation.snapshot(), allowedTools: this.deps.permission().listAllowed() })
  }
}
