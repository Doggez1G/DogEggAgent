import type { AgentPort } from '@dogegg/bridge'
import type { UiToAgentMessage } from '@dogegg/bridge'
import type { AgentToUiMessage } from '@dogegg/bridge'
import type { Message, Config } from '@dogegg/bridge'
import { isConfigured } from '@dogegg/bridge'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { StateMachine, type TransitionInput, PendingPermissions, TurnRunner, type TurnParams, AgentLoop, Compactor, summarizeHistory, type PermissionResolution } from './turn'
import { BusyGate, newId, CancelledError, Logger } from './shared'
import { Conversation, SessionManager, SessionStore } from './session'
import { ConfigController, ConfigStore, ConfigEditor, resolveCurrent } from './config'
import { ContextAssembler, breakdownContextTokens } from './context'
import { ToolRegistry } from './tools'
import { clientFor, type LlmClient } from './llm'
import { PermissionManager, deriveAlwaysScope } from './permission'
import type { AgentContext } from './ctx'

// Agent 构造选项：依赖注入（生产组合根传 logger；client/sessionsDir/registry 为测试接缝）。
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

// Agent 是后端对外的唯一入口（门面）：持有 port 订阅与消息路由，通过 AgentPort 收发消息，不依赖 ui。
// 具体职责拆给协作类：ctx（可变状态唯一持有者）/ Conversation（工作集，归 session 域）/
// TurnRunner（轮次+压缩）/ SessionManager（会话生命周期）/ ConfigController（配置编辑）/ AgentLoop（主循环）。
// emit() 内部走 port.post()（加日志埋点）——agent 只有消息这一个进出通道。
export class Agent {
  private readonly ctx: AgentContext
  private readonly pending = new PendingPermissions()
  private readonly conversation: Conversation
  private editor: ConfigEditor
  private readonly sessions: SessionStore
  private readonly logger: Logger
  private readonly registry: ToolRegistry
  private readonly clientOverride: LlmClient | undefined
  private readonly configs: ConfigStore
  private readonly compactor: Compactor
  private readonly loop: AgentLoop
  private readonly turnRunner: TurnRunner
  private readonly sessionManager: SessionManager
  private readonly configController: ConfigController

  constructor(
    private port: AgentPort,
    config: Config,
    cwd: string,
    opts: AgentOptions = {},
  ) {
    this.sessions = new SessionStore(opts.sessionsDir)
    this.logger = opts.logger ?? new Logger(null)
    this.registry = opts.registry ?? ToolRegistry.withBuiltins()
    this.clientOverride = opts.client
    this.conversation = new Conversation(cwd)
    this.ctx = {
      config,
      permission: new PermissionManager(config.permission),
      assembler: new ContextAssembler(config.systemPrompt, this.registry),
      machine: new StateMachine('idle'),
      gate: new BusyGate(),
    }
    this.editor = new ConfigEditor(config)
    this.configs = new ConfigStore()
    this.compactor = new Compactor(this.summarize)
    this.loop = new AgentLoop({
      registry: this.registry,
      machine: this.ctx.machine,
      compactor: this.compactor,
      emit: (e) => this.emit(e),
      requestPermission: (tool, input) => this.requestPermission(tool, input),
      checkCancelled: () => this.ctx.gate.isCancelled(),
    })
    this.turnRunner = new TurnRunner({
      ctx: this.ctx,
      conversation: this.conversation,
      loop: this.loop,
      compactor: this.compactor,
      sessions: this.sessions,
      registry: this.registry,
      emit: (m) => this.emit(m),
      emitState: (input) => this.emitState(input),
    })
    this.sessionManager = new SessionManager({
      ctx: this.ctx,
      conversation: this.conversation,
      sessions: this.sessions,
      emit: (m) => this.emit(m),
    })
    this.configController = new ConfigController({
      ctx: this.ctx,
      editor: this.editor,
      configs: this.configs,
      emit: (m) => this.emit(m),
      onConfigChanged: (config) => this.onConfigChanged(config),
    })
    // 自订阅：UI 发来的消息都经 port 路由到 send。
    this.port.onMessage((msg) => { this.send(msg).catch(() => {}) })
  }

  // emitState：状态迁移的快捷方法——fire 唯一状态机（ctx.machine）后 emit state 事件。
  // 同时附带 status_state（含最新 token 估算），让 StatusBar 在每次状态变化时实时更新。
  private emitState(input: TransitionInput): void {
    const prev = this.ctx.machine.state
    const next = this.ctx.machine.fire(input)
    if (next !== prev) {
      this.emit({ type: 'state', from: prev, to: next })
      // 状态变化时同步推送 token 信息（thinking→responding→tool_calling 等都会触发）。
      try {
        const cur = this.current()
        this.emit({ type: 'status_state', sessionId: this.conversation.getId(), provider: cur.providerName, model: cur.modelName, cwd: this.conversation.getCwd(), state: next, estimatedTokens: this.estimateCurrentTokens(), windowTokens: cur.contextWindow, usage: this.conversation.getUsage() })
      } catch { /* 配置未就绪时跳过 */ }
    }
  }

  // emit = port.post + 日志埋点（纯出站职责：转发 + 日志，不再镜像状态——状态机只有一台）。
  // 日志按消息类型分 scope，便于 /log 面板按类型过滤。
  private emit(m: AgentToUiMessage): void {
    if (m.type === 'state') {
      this.logger.log(this.conversation.getId(), 'state', `${m.from} → ${m.to}`)
    } else if (m.type === 'message') {
      this.logger.log(this.conversation.getId(), 'message', m.role)
    } else if (m.type === 'tool_start') {
      this.logger.log(this.conversation.getId(), 'tool', `${m.name} ${JSON.stringify(m.input)}`)
    } else if (m.type === 'tool_end') {
      this.logger.log(this.conversation.getId(), 'tool', `${m.name} ${m.error ? '✕ ' + m.error : '✓'}`)
    } else if (m.type === 'permission_request') {
      this.logger.log(this.conversation.getId(), 'permission', `ask ${m.tool}`)
    } else if (m.type === 'error') {
      this.logger.log(this.conversation.getId(), 'error', m.error.message)
    } else if (m.type === 'compaction') {
      this.logger.log(this.conversation.getId(), 'compact', `${m.before_tokens} → ${m.after_tokens}`)
    } else if (m.type === 'finished') {
      this.logger.log(this.conversation.getId(), 'state', 'finished')
    }
    this.port.post(m)
  }

  // 当前 provider + model 解析（唯一入口——status 推送与参数解析都从这里取，避免重复 resolveCurrent）。
  private current(): { providerName: string; modelName: string; baseURL: string; apiKey: string; model: string; maxOutput: number; reasoning: boolean; contextWindow: number } {
    const { provider, model } = resolveCurrent(this.ctx.config)
    return {
      providerName: provider.name,
      modelName: model.name,
      baseURL: provider.baseURL,
      apiKey: provider.apiKey,
      model: model.name,
      maxOutput: model.maxOutput,
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
    }
  }

  private estimateCurrentTokens(): number {
    return this.ctx.assembler.estimate(this.conversation.getContext())
  }

  // 统一的 status_state 发射——status_request 与 set_cwd 共用，避免字段重复。
  private emitStatusState(): void {
    const cur = this.current()
    this.emit({ type: 'status_state', sessionId: this.conversation.getId(), provider: cur.providerName, model: cur.modelName, cwd: this.conversation.getCwd(), state: this.ctx.machine.state, estimatedTokens: this.estimateCurrentTokens(), windowTokens: cur.contextWindow, usage: this.conversation.getUsage() })
  }

  // 向 UI 提出权限请求，返回一个在收到 permission_decision 时才决议的 Promise。
  // 【SDK 接缝】无头使用时可注入程序化 permissionHandler 替代此 Port 往返。
  private requestPermission(tool: string, input: unknown): Promise<PermissionResolution> {
    return new Promise((resolve, reject) => {
      const id = newId()
      // 推导「对此范围不再询问」的模式（deriveAlwaysScope）随请求下发；推导不出时 UI 维持三档。
      const scopePattern = deriveAlwaysScope(tool, input, this.conversation.getCwd())
      this.pending.add(id, { resolve, reject, scopePattern })
      this.emit({ type: 'permission_request', id, tool, input, ...(scopePattern ? { alwaysScope: { pattern: scopePattern } } : {}) })
    })
  }

  // 压缩回调：闭合在 ctx 上（调用时读当前 config 解析 provider/model）。
  // signal 接收外部 signal 让取消能中断摘要调用（非无人持有的 new AbortController）。
  private summarize = (old: Message[], signal?: AbortSignal): Promise<string> => {
    const { provider } = resolveCurrent(this.ctx.config)
    const cur = this.current()
    const client = this.clientOverride ?? clientFor(provider.protocol, { baseURL: cur.baseURL, apiKey: cur.apiKey })
    return summarizeHistory({ client, model: cur.model }, old, signal)
  }

  // 当前轮次的 provider 连接与模型参数——在命令时刻解析成值传入 TurnRunner（派生值不进 ctx）。
  private resolveTurnParams(): TurnParams {
    const cur = this.current()
    const { provider } = resolveCurrent(this.ctx.config)
    return {
      client: this.clientOverride ?? clientFor(provider.protocol, { baseURL: cur.baseURL, apiKey: cur.apiKey }),
      model: cur.model,
      maxOutput: cur.maxOutput,
      maxRetries: this.ctx.config.maxRetries,
      reasoning: cur.reasoning,
      windowTokens: cur.contextWindow,
    }
  }

  // 配置编辑成功后的运行时联动：整体替换 ctx 中可变的三个成员。
  // PermissionManager 重建时保留运行时 allow_always 授权；ContextAssembler 重建使新 prompt 路径生效。
  private onConfigChanged(config: Config): void {
    this.ctx.config = config
    const saved = this.ctx.permission.snapshotPermissions()
    this.ctx.permission = new PermissionManager(config.permission)
    this.ctx.permission.restore(saved)
    this.ctx.assembler = new ContextAssembler(config.systemPrompt, this.registry)
  }

  // 命令分发：动工作集类在 running 时发 notice 不静默丢弃；纯查询类始终放行。
  async send(cmd: UiToAgentMessage): Promise<void> {
    switch (cmd.type) {
      // ── 动 loop 工作集 / 轮次（运行中阻塞）──
      case 'submit':
        if (!isConfigured(this.ctx.config)) { this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config 添加并保存后重试' }); break }
        await this.turnRunner.submit(cmd.text, this.resolveTurnParams())
        break
      case 'compact_request':
        if (!isConfigured(this.ctx.config)) { this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config' }); break }
        await this.turnRunner.compact(this.resolveTurnParams())
        break

      // ── 会话生命周期（运行中阻塞）──
      case 'new_session':
        this.sessionManager.newSession(cmd.cwd)
        break
      case 'resume_session':
        this.sessionManager.resume(cmd.id)
        break
      case 'clear_history':
        this.sessionManager.clearHistory()
        break
      case 'delete_session':
        this.sessionManager.deleteSession(cmd.id)
        break
      case 'list_sessions':
        this.sessionManager.list()
        break

      // ── 配置（编辑运行中阻塞，查询放行）──
      case 'config_set':
        this.configController.set(cmd.path, cmd.value)
        break
      case 'config_add':
        this.configController.add(cmd.path, cmd.value)
        break
      case 'config_remove':
        this.configController.remove(cmd.path, cmd.index, cmd.providerIndex)
        break
      case 'config_request':
        this.configController.request()
        break

      // ── loop 控制（仅运行时有意义）──
      case 'cancel':
        this.ctx.gate.cancel()
        this.pending.rejectAll(new CancelledError())
        break
      case 'permission_decision':
        this.logger.log(this.conversation.getId(), 'permission', `decision ${cmd.decision}`)
        this.pending.resolve(cmd.id, cmd.decision)
        break

      // ── 纯查询（任意时刻放行）──
      case 'tools_request':
        this.emit({ type: 'tools_list', tools: this.registry.all().map((t) => ({ name: t.name, description: t.description })) })
        break
      case 'context_request': {
        if (!isConfigured(this.ctx.config)) { this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config' }); break }
        try {
          const m = this.current()
          const tokens = this.estimateCurrentTokens()
          this.emit({
            type: 'context_state',
            estimatedTokens: tokens,
            windowTokens: m.contextWindow,
            percent: m.contextWindow ? Math.round((tokens / m.contextWindow) * 100) : 0,
            breakdown: breakdownContextTokens(this.ctx.assembler.systemPrompt(), this.conversation.getContext(), this.registry.schemas()),
            lastTurn: this.conversation.getLastTurn(),
            sessionUsage: this.conversation.getUsage(),
            compactions: this.conversation.getCompactions(),
          })
        } catch { this.emit({ type: 'notice', text: '上下文状态读取失败' }) }
        break
      }
      case 'status_request': {
        if (!isConfigured(this.ctx.config)) { this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config' }); break }
        try { this.emitStatusState() }
        catch { this.emit({ type: 'notice', text: '状态读取失败' }) }
        break
      }
      case 'system_request':
        try { this.emit({ type: 'system_state', path: this.ctx.config.systemPrompt ?? '内置', content: this.ctx.assembler.systemPrompt() }) }
        catch { this.emit({ type: 'notice', text: 'system prompt 加载失败（路径不存在或无法读取）' }) }
        break
      case 'log_request':
        try { this.emit({ type: 'log_state', path: this.logger.path(this.conversation.getId()) ?? '~/.dogegg/logs/<session>.log', tail: this.logger.tail(this.conversation.getId()) }) }
        catch { this.emit({ type: 'notice', text: '日志读取失败' }) }
        break
      case 'permissions_request':
        // /permissions：返回当前会话的提升清单（按工具分组；patterns 空 = 整工具）。
        this.emit({ type: 'permissions_list', permissions: this.ctx.permission.snapshotPermissions() })
        break
      case 'permission_revoke':
        // 撤销会话提升：带 pattern 撤单条模式，不带撤整工具；撤后重推清单。
        this.ctx.permission.revoke(cmd.tool, cmd.pattern)
        this.emit({ type: 'permissions_list', permissions: this.ctx.permission.snapshotPermissions() })
        break
      case 'set_cwd': {
        // 运行时切换工作目录——运行中阻塞（避免 in-flight 工具写到错误目录）。
        if (this.ctx.gate.busy) { this.emit({ type: 'notice', text: '运行中，请稍候' }); return }
        try {
          const resolved = resolve(cmd.path)
          const stat = statSync(resolved)
          if (!stat.isDirectory()) {
            this.emit({ type: 'notice', text: `${cmd.path} 不是目录` })
            break
          }
          this.conversation.setCwd(resolved)
          this.emit({ type: 'notice', text: `工作目录已切换到 ${resolved}` })
          // 立即落盘 + 重推会话列表：会话文件携带 cwd，WebUI 侧栏按 cwd 分组项目树——
          // 不即时保存的话，新项目要等下一轮对话落盘后才出现。
          try {
            this.sessions.save(
              this.conversation.snapshotFull(
                this.ctx.permission.snapshotPermissions(),
                this.conversation.getUsage(),
                this.conversation.getCompactions(),
              ),
            )
            this.emit({ type: 'session_list', sessions: this.sessions.list() })
          } catch { /* 落盘失败静默——切换本身已成功并提示 */ }
          // 复用 status_state 通知 UI 更新 cwd 显示（不需要 provider 配置——cwd 独立于 config）。
          if (isConfigured(this.ctx.config)) { this.emitStatusState() }
        } catch {
          this.emit({ type: 'notice', text: `路径不存在：${cmd.path}` })
        }
        break
      }

      case 'quit':
        process.exit(0)
    }
  }
}
