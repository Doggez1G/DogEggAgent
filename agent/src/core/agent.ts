import type { AgentPort } from '@dogegg/bridge'
import type { UiToAgentMessage } from '@dogegg/bridge'
import type { AgentToUiMessage } from '@dogegg/bridge'
import type { Message, State, Config } from '@dogegg/bridge'
import { isConfigured } from '@dogegg/bridge'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { transition, type TransitionInput } from './state'
import { PendingPermissions } from './pending'
import { ConfigEditor } from '../config/editor'
import { resolveCurrent } from '../config/resolve'
import { ConfigStore } from '../config'
import { ContextAssembler, Compactor, summarizeHistory } from '../context'
import { ToolRegistry } from '../tools'
import { clientFor, type LlmClient } from '../llm'
import { AgentLoop } from '../loop'
import { SessionStore } from '../session'
import { PermissionManager } from '../permission'
import { newId, CancelledError, Logger } from '../shared'

// Agent 是后端对外的唯一入口：持有 history（完整原文）与 context（发给模型，可压缩），
// 通过 AgentPort 收发消息，不依赖 ui。
//
// 构造后自订阅 port 消息——外部不再调 send()，一切通过 port.post(UiToAgentMessage) 驱动。
// emit() 内部走 port.post()（加日志埋点），agent 只有消息这一个进出通道。
// Agent 构造选项：依赖注入（生产组合根传 logger；adapter/sessionsDir 为测试接缝）。
export interface AgentOptions {
  /** 覆盖 clientFor() 的 LLM client（表征测试注入假 client 用）。 */
  client?: LlmClient
  /** 会话持久化目录——缺省 ~/.dogegg/sessions。 */
  sessionsDir?: string
  /** 日志实例——缺省不启用日志。 */
  logger?: Logger
  /** 工具注册表——缺省内置四工具（测试可注入子集）。 */
  registry?: ToolRegistry
}

export class Agent {
  private history: Message[] = []
  private context: Message[] = []
  private thinking: { text: string }[] = []
  private sessionId = newId()
  private pending = new PendingPermissions()
  private cancelled = false
  private running = false
  private state: State = 'idle'
  private controller: AbortController | null = null
  private editor: ConfigEditor
  private permission: PermissionManager
  private readonly sessions: SessionStore
  private readonly logger: Logger
  private readonly registry: ToolRegistry
  private readonly clientOverride: LlmClient | undefined
  private assembler: ContextAssembler
  private readonly configs: ConfigStore
  private readonly compactor: Compactor
  private readonly loop: AgentLoop

  constructor(
    private port: AgentPort,
    private config: Config,
    private cwd: string,
    opts: AgentOptions = {},
  ) {
    this.sessions = new SessionStore(opts.sessionsDir)
    this.logger = opts.logger ?? new Logger(null)
    this.registry = opts.registry ?? ToolRegistry.withBuiltins()
    this.clientOverride = opts.client
    this.editor = new ConfigEditor(config)
    this.permission = new PermissionManager(config.permission)
    this.assembler = new ContextAssembler(config.systemPrompt, this.registry)
    this.configs = new ConfigStore()
    this.compactor = new Compactor(this.summarize)
    this.loop = new AgentLoop({
      registry: this.registry,
      emit: (e) => this.emit(e),
      requestPermission: (tool, input) => this.requestPermission(tool, input),
      checkCancelled: () => this.cancelled,
      summarize: this.summarize,
    })
    // 自订阅：UI 发来的消息都经 port 路由到 send。
    this.port.onMessage((msg) => { this.send(msg).catch(() => {}) })
  }

  // emitState：状态迁移的快捷方法——经 transition 算下一态后 emit state 事件。
  // 同时附带 status_state（含最新 token 估算），让 StatusBar 在每次状态变化时实时更新。
  private emitState(input: TransitionInput): void {
    const next = transition(this.state, input)
    if (next !== this.state) {
      this.emit({ type: 'state', from: this.state, to: next })
      // 状态变化时同步推送 token 信息（thinking→responding→tool_calling 等都会触发）。
      try {
        const { provider, model } = resolveCurrent(this.config)
        const cur = this.current()
        this.emit({ type: 'status_state', sessionId: this.sessionId, provider: provider.name, model: model.name, cwd: this.cwd, state: next, estimatedTokens: this.estimateCurrentTokens(), windowTokens: cur.contextWindow })
      } catch { /* 配置未就绪时跳过 */ }
    }
  }

  // emit = port.post + 日志埋点。日志按消息类型分 scope，便于 /log 面板按类型过滤。
  private emit(m: AgentToUiMessage): void {
    if (m.type === 'state') {
      this.state = m.to
      this.logger.log(this.sessionId, 'state', `${m.from} → ${m.to}`)
    } else if (m.type === 'message') {
      this.logger.log(this.sessionId, 'message', m.role)
    } else if (m.type === 'tool_start') {
      this.logger.log(this.sessionId, 'tool', `${m.name} ${JSON.stringify(m.input)}`)
    } else if (m.type === 'tool_end') {
      this.logger.log(this.sessionId, 'tool', `${m.name} ${m.error ? '✕ ' + m.error : '✓'}`)
    } else if (m.type === 'permission_request') {
      this.logger.log(this.sessionId, 'permission', `ask ${m.tool}`)
    } else if (m.type === 'error') {
      this.logger.log(this.sessionId, 'error', m.error.message)
    } else if (m.type === 'compaction') {
      this.logger.log(this.sessionId, 'compact', `${m.before_tokens} → ${m.after_tokens}`)
    } else if (m.type === 'finished') {
      this.logger.log(this.sessionId, 'state', 'finished')
    }
    this.port.post(m)
  }

  // 当前 provider + model 解析。调用方需先经 isConfigured 判定。
  private current(): { baseURL: string; apiKey: string; model: string; maxOutput: number; reasoning: boolean; contextWindow: number } {
    const { provider, model } = resolveCurrent(this.config)
    return {
      baseURL: provider.baseURL,
      apiKey: provider.apiKey,
      model: model.name,
      maxOutput: model.maxOutput,
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
    }
  }

  private estimateCurrentTokens(): number {
    return this.assembler.estimate(this.context)
  }

  // 统一的 status_state 发射——status_request 与 set_cwd 共用，避免字段重复。
  private emitStatusState(): void {
    const { provider, model } = resolveCurrent(this.config)
    const cur = this.current()
    this.emit({ type: 'status_state', sessionId: this.sessionId, provider: provider.name, model: model.name, cwd: this.cwd, state: this.state, estimatedTokens: this.estimateCurrentTokens(), windowTokens: cur.contextWindow })
  }

  // 向 UI 提出权限请求，返回一个在收到 permission_decision 时才决议的 Promise。
  private requestPermission(tool: string, input: unknown): Promise<'allow_once' | 'allow_always' | 'reject'> {
    return new Promise((resolve, reject) => {
      const id = newId()
      this.pending.add(id, { resolve, reject })
      this.emit({ type: 'permission_request', id, tool, input })
    })
  }

  // 压缩回调：供 loop 的 summarize 注入用。从当前 config 解析 provider/model，调 LLM 做摘要。
  // signal 接收外部 signal 让取消能中断摘要调用（非无人持有的 new AbortController）。
  private summarize = (old: Message[], signal?: AbortSignal): Promise<string> => {
    const { provider } = resolveCurrent(this.config)
    const cur = this.current()
    const client = this.clientOverride ?? clientFor(provider.protocol, { baseURL: cur.baseURL, apiKey: cur.apiKey })
    return summarizeHistory({ client, model: cur.model }, old, signal)
  }

  // R2 四类命令分发。动工作集类在 running 时发 notice 不静默丢弃；纯查询类始终放行。
  async send(cmd: UiToAgentMessage): Promise<void> {
    switch (cmd.type) {
      // ── 动 loop 工作集（运行中阻塞）──
      case 'submit': {
        if (this.running) { this.emit({ type: 'notice', text: '运行中，请稍候' }); return }
        if (!isConfigured(this.config)) {
          this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config 添加并保存后重试' })
          return
        }
        await this.runTurn(cmd.text)
        break
      }
      case 'new_session': {
        if (this.running) { this.emit({ type: 'notice', text: '运行中，请稍候' }); return }
        // 可选 cwd：WebUI 项目树添加会话时传入指定工作目录。
        if (cmd.cwd) {
          try {
            const resolved = resolve(cmd.cwd)
            if (!statSync(resolved).isDirectory()) { this.emit({ type: 'notice', text: `${cmd.cwd} 不是目录` }); break }
            this.cwd = resolved
          } catch { this.emit({ type: 'notice', text: `路径不存在：${cmd.cwd}` }); break }
        }
        this.history = []
        this.context = []
        this.thinking = []
        this.sessionId = newId()
        this.permission.reset() // 会话隔离：allow_always 只对当前会话生效
        // 立即保存空会话——让 list_sessions 能返回新会话（侧栏即时显示）。
        try { this.sessions.save({ id: this.sessionId, history: this.history, context: this.context, allowedTools: this.permission.listAllowed(), cwd: this.cwd, thinking: this.thinking }) } catch { /* 磁盘错误忽略 */ }
        this.emit({ type: 'session_ready', id: this.sessionId, messages: this.history })
        break
      }
      case 'resume_session': {
        if (this.running) { this.emit({ type: 'notice', text: '运行中，请稍候' }); return }
        try {
          const s = this.sessions.load(cmd.id)
          this.history = s.history
          this.context = s.context
          this.thinking = s.thinking
          this.sessionId = s.id
          // 恢复该会话的工作目录（项目→会话切换恢复目录）。
          if (s.cwd) { this.cwd = s.cwd }
          // 恢复该会话的 allow_always 授权（resume 不清空，保留之前设置的授权）。
          this.permission.reset()
          for (const t of s.allowedTools) this.permission.apply(t, 'allow_always')
          this.emit({ type: 'session_ready', id: s.id, messages: this.history, ...(this.thinking.length ? { thinking: this.thinking } : {}) })
        } catch {
          this.emit({ type: 'notice', text: `会话 ${cmd.id} 加载失败（文件不存在或已损坏）` })
        }
        break
      }
      case 'clear_history': {
        if (this.running) { this.emit({ type: 'notice', text: '运行中，请稍候' }); return }
        this.history = []
        this.context = []
        this.emit({ type: 'history_cleared' })
        break
      }
      case 'compact_request': {
        if (this.running) { this.emit({ type: 'notice', text: '运行中，请稍候' }); return }
        if (!isConfigured(this.config)) { this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config' }); break }
        await this.compactNow()
        break
      }
      case 'config_set': {
        if (this.running) { this.emit({ type: 'notice', text: '运行中，请稍候' }); return }
        this.applyConfigEdit((e) => e.set(cmd.path, cmd.value))
        break
      }
      case 'config_add': {
        if (this.running) { this.emit({ type: 'notice', text: '运行中，请稍候' }); return }
        this.applyConfigEdit((e) => e.add(cmd.path, cmd.value))
        break
      }
      case 'config_remove': {
        if (this.running) { this.emit({ type: 'notice', text: '运行中，请稍候' }); return }
        this.applyConfigEdit((e) => e.remove(cmd.path, cmd.index, cmd.providerIndex))
        break
      }

      // ── loop 控制（仅运行时有意义）──
      case 'cancel': {
        this.cancelled = true
        this.controller?.abort()
        this.pending.rejectAll(new CancelledError())
        break
      }
      case 'permission_decision': {
        this.logger.log(this.sessionId, 'permission', `decision ${cmd.decision}`)
        this.pending.resolve(cmd.id, cmd.decision)
        break
      }

      // ── 纯查询（任意时刻放行）──
      case 'list_sessions':
        try { this.emit({ type: 'session_list', sessions: this.sessions.list() }) }
        catch { this.emit({ type: 'notice', text: '会话列表读取失败' }) }
        break
      case 'config_request':
        this.emit({ type: 'config_state', config: this.editor.getConfig() })
        break
      case 'tools_request':
        this.emit({ type: 'tools_list', tools: this.registry.all().map((t) => ({ name: t.name, description: t.description })) })
        break
      case 'context_request': {
        if (!isConfigured(this.config)) { this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config' }); break }
        try {
          const m = this.current()
          const tokens = this.estimateCurrentTokens()
          this.emit({ type: 'context_state', estimatedTokens: tokens, windowTokens: m.contextWindow, percent: m.contextWindow ? Math.round((tokens / m.contextWindow) * 100) : 0 })
        } catch { this.emit({ type: 'notice', text: '上下文状态读取失败' }) }
        break
      }
      case 'status_request': {
        if (!isConfigured(this.config)) { this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config' }); break }
        try { this.emitStatusState() }
        catch { this.emit({ type: 'notice', text: '状态读取失败' }) }
        break
      }
      case 'system_request':
        try { this.emit({ type: 'system_state', path: this.config.systemPrompt ?? '内置', content: this.assembler.systemPrompt() }) }
        catch { this.emit({ type: 'notice', text: 'system prompt 加载失败（路径不存在或无法读取）' }) }
        break
      case 'log_request':
        try { this.emit({ type: 'log_state', path: this.logger.path(this.sessionId) ?? '~/.dogegg/logs/<session>.log', tail: this.logger.tail(this.sessionId) }) }
        catch { this.emit({ type: 'notice', text: '日志读取失败' }) }
        break

      case 'permissions_request': {
        // /permissions：返回当前会话的 allow_always 授权列表。
        const allowed = this.permission.listAllowed()
        this.emit({ type: 'permissions_list', tools: allowed })
        break
      }
      case 'permission_revoke': {
        // 撤销某工具的 allow_always 授权。
        this.permission.revoke(cmd.tool)
        const allowed = this.permission.listAllowed()
        this.emit({ type: 'permissions_list', tools: allowed })
        break
      }
      case 'set_cwd': {
        // 运行时切换工作目录——运行中阻塞（避免 in-flight 工具写到错误目录）。
        if (this.running) { this.emit({ type: 'notice', text: '运行中，请稍候' }); return }
        try {
          const resolved = resolve(cmd.path)
          const stat = statSync(resolved)
          if (!stat.isDirectory()) {
            this.emit({ type: 'notice', text: `${cmd.path} 不是目录` })
            break
          }
          this.cwd = resolved
          this.emit({ type: 'notice', text: `工作目录已切换到 ${resolved}` })
          // 复用 status_state 通知 UI 更新 cwd 显示（不需要 provider 配置——cwd 独立于 config）。
          if (isConfigured(this.config)) { this.emitStatusState() }
        } catch {
          this.emit({ type: 'notice', text: `路径不存在：${cmd.path}` })
        }
        break
      }
      case 'delete_session': {
        // 删除会话文件——运行中阻塞（不能删正在使用的会话）。
        if (this.running) { this.emit({ type: 'notice', text: '运行中，请稍候' }); return }
        try {
          this.sessions.delete(cmd.id)
          this.emit({ type: 'session_deleted', id: cmd.id })
          // 如果删除的是当前会话，发一个 notice 提示。
          if (cmd.id === this.sessionId) {
            this.emit({ type: 'notice', text: '当前会话已删除' })
          }
        } catch {
          this.emit({ type: 'notice', text: `会话 ${cmd.id} 删除失败` })
        }
        break
      }

      case 'quit':
        process.exit(0)
    }
  }

  // 一轮对话：push user 消息到 history+context（R1 双写）→ runLoop 作用于 context → 同步 newMessages 到 history → 落盘。
  private async runTurn(text: string): Promise<void> {
    this.cancelled = false
    this.controller = new AbortController()
    this.running = true
    const userMsg: Message = { role: 'user', content: text }
    this.history.push(userMsg)
    this.context.push(userMsg)
    this.emit({ type: 'message', role: 'user', id: newId() })
    const cur = this.current()
    const { provider } = resolveCurrent(this.config)
    try {
      const result = await this.loop.run({
        client: this.clientOverride ?? clientFor(provider.protocol, { baseURL: cur.baseURL, apiKey: cur.apiKey }),
        model: cur.model,
        maxOutput: cur.maxOutput,
        maxRetries: this.config.maxRetries,
        reasoning: cur.reasoning,
        systemPrompt: this.assembler.systemPrompt(),
        windowTokens: cur.contextWindow,
        context: this.context,
        permission: this.permission,
        maxIterations: this.config.maxIterations,
        cwd: this.cwd,
        shellProgram: this.config.shellProgram,
        signal: this.controller.signal,
      })
      // R1：loop 返回更新后的 context + 本轮新增消息 + thinking（成功/取消/错误都返回部分结果）。
      // context 已被 loop 修改（含压缩）；newMessages 同步 append 到 history。
      // thinking 累积到 this.thinking（resume 时恢复，不进 history/context）。
      this.context = result.context
      this.history.push(...result.newMessages)
      this.thinking.push(...result.thinking)
      if (result.cancelled) {
        this.emit({ type: 'notice', text: '已打断当前操作' })
      } else if (result.error) {
        this.emitState({ kind: 'error' })
        this.emit({ type: 'error', error: { message: result.error } })
      }
    } catch (e) {
      // 兜底：loop 内部未 catch 的意外错误（理论上不应到达，loop 已 catch 全部）。
      this.emitState({ kind: 'error' })
      this.emit({ type: 'error', error: { message: (e as Error).message, name: (e as Error).name } })
    } finally {
      // 无论成功/失败/取消，turn 结束后状态回到 idle（成功路径 loop 停在 finished，需复位）。
      this.running = false
      this.emitState({ kind: 'reset' })
      try { this.sessions.save({ id: this.sessionId, history: this.history, context: this.context, allowedTools: this.permission.listAllowed(), cwd: this.cwd, thinking: this.thinking }) }
      catch { this.emit({ type: 'notice', text: '会话保存失败（磁盘空间不足或权限问题）' }) }
    }
  }

  // 手动压缩（/compact）：复用 compactContext，只改 context、不动 history，落盘。
  // 压缩期间 emit state → compacting 让 UI 可感知，完成后回 idle。
  // 设 running=true 防止压缩期间 submit 并发写入 context（R2 阻塞）。
  // 失败时 emit error 而非让外层 .catch(() => {}) 静默吞掉。
  private async compactNow(): Promise<void> {
    this.running = true
    this.cancelled = false
    this.controller = new AbortController()
    const cur = this.current()
    this.emitState({ kind: 'compact_start' })
    try {
      const result = await this.compactor.compact({
        context: this.context,
        systemPrompt: this.assembler.systemPrompt(),
        tools: this.registry.schemas(),
        windowTokens: cur.contextWindow,
        force: true,
        signal: this.controller.signal,
      })
      if (result.compacted) {
        this.context = result.context
        this.sessions.save({ id: this.sessionId, history: this.history, context: this.context, allowedTools: this.permission.listAllowed(), cwd: this.cwd, thinking: this.thinking })
        this.emit({ type: 'compaction', before_tokens: result.before, after_tokens: result.after, source: 'manual' })
      } else {
        // context 为空——没有消息可压。
        this.emit({ type: 'notice', text: '上下文为空，无需压缩' })
      }
    } catch (e) {
      // AbortError 是用户取消——走 cancelled 态而非 error（与 runTurn catch 一致）。
      if ((e as Error).name === 'AbortError') {
        this.emitState({ kind: 'cancel' })
        this.emit({ type: 'notice', text: '已打断压缩' })
      } else {
        this.emitState({ kind: 'error' })
        this.emit({ type: 'error', error: { message: '压缩失败：' + (e as Error).message, name: (e as Error).name } })
      }
    } finally {
      this.running = false
      // 如果还在 compacting（成功路径），用 compact_done 回 idle；
      // 如果已 cancelled/error，用 reset 回 idle（compact_done 的 VALID_FROM 不含 cancelled/error）。
      this.emitState(this.state === 'compacting' ? { kind: 'compact_done', next: 'idle' } : { kind: 'reset' })
    }
  }

  // 配置编辑统一入口：委托 ConfigEditor，成功后同步 permission/provider 运行时 + 落盘 + emit。
  private applyConfigEdit(fn: (e: ConfigEditor) => { ok: boolean; error?: string }): void {
    const result = fn(this.editor)
    if (!result.ok) {
      this.emit({ type: 'notice', text: result.error ?? '配置编辑失败' })
      return
    }
    this.config = this.editor.getConfig()
    // 重建 PermissionManager 时保留运行时 allow_always 授权（配置编辑不该丢失会话授权）。
    const savedAllowed = this.permission.snapshot()
    this.permission = new PermissionManager(this.config.permission)
    for (const t of savedAllowed) this.permission.apply(t, 'allow_always')
    // systemPrompt 路径可能被编辑——重建组装器让新路径生效。
    this.assembler = new ContextAssembler(this.config.systemPrompt, this.registry)
    this.configs.save(this.config)
    this.emit({ type: 'config_updated', config: this.config })
  }
}
