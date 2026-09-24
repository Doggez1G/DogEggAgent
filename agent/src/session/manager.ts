import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentToUiMessage } from '@dogegg/bridge'
import type { Conversation } from './conversation'
import type { SessionStore } from './store'
import type { AgentContext } from '../ctx'

// 会话生命周期：new / resume / delete / list / clear 的实现归属。
// 会话隔离：allow_always 授权随 PermissionManager.reset() 只对当前会话生效。
export class SessionManager {
  constructor(private readonly deps: {
    ctx: AgentContext
    conversation: Conversation
    sessions: SessionStore
    emit: (m: AgentToUiMessage) => void
    /**
     * 会话切换成功钩子（cwd 确定后回调）：newSession 与 resume 换的不只是 cwd——
     * 项目级 skills / 项目级 .mcp.json 都锚定在会话目录上，跨项目切换后若不重挂，
     * skills 面板与系统提示段仍显示旧项目，toggle 还会写错项目的 .skills.json。
     * 由门面装配联动集（与 set_cwd 分支同口径）：setProjectDir + 各显示刷新 + rebuildMcp。
     */
    onSessionSwitched?: (cwd: string) => void
  }) {}

  // R2：动工作集类命令运行中阻塞（发 notice 不静默丢弃）。
  private blocked(): boolean {
    if (this.deps.ctx.gate.busy) {
      this.deps.emit({ type: 'notice', text: '运行中，请稍候' })
      return true
    }
    return false
  }

  // 新建会话：可选指定工作目录（WebUI 项目树添加会话时传入）。
  // persist=false：只换内存、不落盘（删除当前会话的替换场景专用）——新会话等首次对话才持久化，
  // 否则立即写入的空会话文件会把「刚删空的项目」又撑成非空（WebUI 删除项目被它挡住）。
  newSession(cwd?: string, opts?: { persist?: boolean }): void {
    if (this.blocked()) return
    if (cwd) {
      try {
        const resolved = resolve(cwd)
        if (!statSync(resolved).isDirectory()) { this.deps.emit({ type: 'notice', text: `${cwd} 不是目录` }); return }
        this.deps.conversation.setCwd(resolved)
      } catch { this.deps.emit({ type: 'notice', text: `路径不存在：${cwd}` }); return }
    }
    this.deps.conversation.reset()
    this.deps.ctx.permission.reset() // 会话隔离：allow_always 只对当前会话生效
    // 立即保存空会话——让 list_sessions 能返回新会话（侧栏即时显示）。
    if (opts?.persist !== false) { try { this.save() } catch { /* 磁盘错误忽略 */ } }
    // busy 与 WP2 的 session_ready 契约同步（恢复链立法）：UI 据此落到「运行中」形态，不被快照打回 idle。
    this.deps.emit({ type: 'session_ready', id: this.deps.conversation.getId(), messages: [], busy: this.deps.ctx.gate.busy })
    // 成功路径（cwd 已确定——显式指定的新目录，或沿用当前目录）通知项目级资源重挂。
    this.deps.onSessionSwitched?.(this.deps.conversation.getCwd())
  }

  resume(id: string): void {
    if (this.blocked()) return
    try {
      const s = this.deps.sessions.load(id)
      this.deps.conversation.load(s)
      // 恢复该会话的权限提升（resume 不清空，保留之前设置的提升；旧格式的 allowedTools 字段直接无视）。
      this.deps.ctx.permission.reset()
      this.deps.ctx.permission.restore(s.sessionPermissions)
      const thinking = this.deps.conversation.getThinking()
      this.deps.emit({
        type: 'session_ready',
        id: s.id,
        messages: [...this.deps.conversation.getHistory()],
        // busy 与 WP2 的 session_ready 契约同步（恢复链立法，见 newSession 内注释）。
        busy: this.deps.ctx.gate.busy,
        ...(thinking.length ? { thinking: [...thinking] } : {}),
      })
      // 成功路径（cwd 已随存档恢复到 conversation）：跨项目 resume 后重挂项目级资源——
      // cwd 必须取 conversation 的最终值（存档带 cwd 时为存档值，旧格式无 cwd 时保持原值）。
      this.deps.onSessionSwitched?.(this.deps.conversation.getCwd())
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
    } catch {
      this.deps.emit({ type: 'notice', text: `会话 ${id} 删除失败` })
      return
    }
    this.deps.emit({ type: 'session_deleted', id })
    // 删除的是当前会话 → 立即换一个新空会话（persist=false，首次对话才落盘）。内存旧工作集
    // 必须被替换：否则下一轮落盘会把刚删掉的会话原样写回（「复活」）；但不能立即落盘新会话：
    // 否则删空的项目永远非空，WebUI 的删除项目会被这个僵尸空会话挡住。
    if (id === this.deps.conversation.getId()) {
      this.deps.emit({ type: 'notice', text: '当前会话已删除，已切换到新会话' })
      this.newSession(undefined, { persist: false })
    }
  }

  // 落盘快照（静默版：新建会话时保存失败不打扰用户）。
  private save(): void {
    this.deps.sessions.save(
      this.deps.conversation.snapshotFull(
        this.deps.ctx.permission.snapshotPermissions(),
        this.deps.conversation.getUsage(),
        this.deps.conversation.getCompactions(),
      ),
    )
  }
}
