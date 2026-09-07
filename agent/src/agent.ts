import type { AgentPort } from '@dogegg/bridge'
import type { UiToAgentMessage } from '@dogegg/bridge'
import type { AgentToUiMessage } from '@dogegg/bridge'
import type { Message, State, Config } from '@dogegg/bridge'
import { isConfigured } from '@dogegg/bridge'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { StateMachine, type TransitionInput, PendingPermissions, TurnRunner, type TurnParams, AgentLoop } from './turn'
import { BusyGate } from './shared'
import { Conversation } from './session'
import { SessionManager } from './session'
import { ConfigController, ConfigStore, ConfigEditor, resolveCurrent } from './config'
import { ContextAssembler } from './context'
import { Compactor, summarizeHistory } from './turn'
import { ToolRegistry } from './tools'
import { clientFor, type LlmClient } from './llm'
import { SessionStore } from './session'
import { PermissionManager } from './permission'
import { newId, CancelledError, Logger } from './shared'

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
// 具体职责拆给协作类：Conversation（工作集）/ BusyGate（并发闸门）/ TurnRunner（轮次+压缩）/
// SessionManager（会话生命周期）/ ConfigController（配置编辑）/ AgentLoop（主循环）。
// emit() 内部走 port.post()（加日志埋点）——agent 只有消息这一个进出通道。
export class Agent {
  private readonly machine = new StateMachine('idle')
  private readonly pending = new PendingPermissions()
  private readonly conversation: Conversation
  private readonly gate = new BusyGate()
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
  private readonly turnRunner: TurnRunner
  private readonly sessionManager: SessionManager
  private readonly configController: ConfigController

  constructor(
    private port: AgentPort,
    private config: Config,
    cwd: string,
    opts: AgentOptions = {},
  ) {
    this.sessions = new SessionStore(opts.sessionsDir)
    this.logger = opts.logger ?? new Logger(null)
    this.registry = opts.registry ?? ToolRegistry.withBuiltins()
    this.clientOverride = opts.client
    this.conversation = new Conversation(cwd)
    this.editor = new ConfigEditor(config)
    this.permission = new PermissionManager(config.permission)
    this.assembler = new ContextAssembler(config.systemPrompt, this.registry)
    this.configs = new ConfigStore()
    this.compactor = new Compactor(this.summarize)
    this.loop = new AgentLoop({
      registry: this.registry,
      emit: (e) => this.emit(e),
      requestPermission: (tool, input) => this.requestPermission(tool, input),
      checkCancelled: () => this.gate.isCancelled(),
      summarize: this.summarize,
    })
    this.turnRunner = new TurnRunner({
      conversation: this.conversation,
      gate: this.gate,
      loop: this.loop,
      compactor: this.compactor,
      sessions: this.sessions,
      registry: this.registry,
      emit: (m) => this.emit(m),
      emitState: (input) => this.emitState(input),
      state: () => this.machine.state,
      config: () => this.config,
      permission: () => this.permission,
      assembler: () => this.assembler,
      turnParams: () => this.turnParams(),
    })
    this.sessionManager = new SessionManager({
      conversation: this.conversation,
      gate: this.gate,
      sessions: this.sessions,
      permission: () => this.permission,
      emit: (m) => this.emit(m),
    })
    this.configController = new ConfigController({
      gate: this.gate,
      editor: this.editor,
      configs: this.configs,
      emit: (m) => this.emit(m),
      onConfigChanged: (config) => this.onConfigChanged(config),
    })
    // 自订阅：UI 发来的消息都经 port 路由到 send。
    this.port.onMessage((msg) => { this.send(msg).catch(() => {}) })
  }

  // emitState：状态迁移的快捷方法——经 StateMachine 算下一态后 emit state 事件。
  // 同时附带 status_state（含最新 token 估算），让 StatusBar 在每次状态变化时实时更新。
  private emitState(input: TransitionInput): void {
    const prev = this.machine.state
    const next = this.machine.fire(input)
    if (next !== prev) {
      this.emit({ type: 'state', from: prev, to: next })
      // 状态变化时同步推送 token 信息（thinking→responding→tool_calling 等都会触发）。
      try {
        const { provider, model } = resolveCurrent(this.config)
        const cur = this.current()
        this.emit({ type: 'status_state', sessionId: this.conversation.getId(), provider: provider.name, model: model.name, cwd: this.conversation.getCwd(), state: next, estimatedTokens: this.estimateCurrentTokens(), windowTokens: cur.contextWindow })
      } catch { /* 配置未就绪时跳过 */ }
    }
  }

  // emit = port.post + 日志埋点。日志按消息类型分 scope，便于 /log 面板按类型过滤。
  private emit(m: AgentToUiMessage): void {
    if (m.type === 'state') {
      this.machine.sync(m.to)
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
    return this.assembler.estimate(this.conversation.getContext())
  }

  // 统一的 status_state 发射——status_request 与 set_cwd 共用，避免字段重复。
  private emitStatusState(): void {
    const { provider, model } = resolveCurrent(this.config)
    const cur = this.current()
    this.emit({ type: 'status_state', sessionId: this.conversation.getId(), provider: provider.name, model: model.name, cwd: this.conversation.getCwd(), state: this.machine.state, estimatedTokens: this.estimateCurrentTokens(), windowTokens: cur.contextWindow })
  }

  // 向 UI 提出权限请求，返回一个在收到 permission_decision 时才决议的 Promise。
  private requestPermission(tool: string, input: unknown): Promise<'allow_once' | 'allow_always' | 'reject'> {
    return new Promise((resolve, reject) => {
      const id = newId()
      this.pending.add(id, { resolve, reject })
      this.emit({ type: 'permission_request', id, tool, input })
    })
  }

  // 压缩回调：供 Compactor / loop 的 summarize 注入用。从当前 config 解析 provider/model，调 LLM 做摘要。
  // signal 接收外部 signal 让取消能中断摘要调用（非无人持有的 new AbortController）。
  private summarize = (old: Message[], signal?: AbortSignal): Promise<string> => {
    const { provider } = resolveCurrent(this.config)
    const cur = this.current()
    const client = this.clientOverride ?? clientFor(provider.protocol, { baseURL: cur.baseURL, apiKey: cur.apiKey })
    return summarizeHistory({ client, model: cur.model }, old, signal)
  }

  // 当前轮次的 provider 连接与模型参数（测试 client 覆盖在此生效）。
  private turnParams(): TurnParams {
    const cur = this.current()
    const { provider } = resolveCurrent(this.config)
    return {
      client: this.clientOverride ?? clientFor(provider.protocol, { baseURL: cur.baseURL, apiKey: cur.apiKey }),
      model: cur.model,
      maxOutput: cur.maxOutput,
      maxRetries: this.config.maxRetries,
      reasoning: cur.reasoning,
      windowTokens: cur.contextWindow,
    }
  }

  // 配置编辑成功后的运行时联动：重建 PermissionManager（保留 allow_always 授权）与 ContextAssembler（新 prompt 路径生效）。
  private onConfigChanged(config: Config): void {
    this.config = config
    const savedAllowed = this.permission.snapshot()
    this.permission = new PermissionManager(config.permission)
    for (const t of savedAllowed) this.permission.apply(t, 'allow_always')
    this.assembler = new ContextAssembler(config.systemPrompt, this.registry)
  }

  // 命令分发：动工作集类在 running 时发 notice 不静默丢弃；纯查询类始终放行。
  async send(cmd: UiToAgentMessage): Promise<void> {
    switch (cmd.type) {
      // ── 动 loop 工作集 / 轮次（运行中阻塞）──
      case 'submit':
        await this.turnRunner.submit(cmd.text)
        break
      case 'compact_request':
        await this.turnRunner.compact()
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
        this.gate.cancel()
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
        try { this.emit({ type: 'log_state', path: this.logger.path(this.conversation.getId()) ?? '~/.dogegg/logs/<session>.log', tail: this.logger.tail(this.conversation.getId()) }) }
        catch { this.emit({ type: 'notice', text: '日志读取失败' }) }
        break
      case 'permissions_request':
        // /permissions：返回当前会话的 allow_always 授权列表。
        this.emit({ type: 'permissions_list', tools: this.permission.listAllowed() })
        break
      case 'permission_revoke':
        // 撤销某工具的 allow_always 授权。
        this.permission.revoke(cmd.tool)
        this.emit({ type: 'permissions_list', tools: this.permission.listAllowed() })
        break
      case 'set_cwd': {
        // 运行时切换工作目录——运行中阻塞（避免 in-flight 工具写到错误目录）。
        if (this.gate.busy) { this.emit({ type: 'notice', text: '运行中，请稍候' }); return }
        try {
          const resolved = resolve(cmd.path)
          const stat = statSync(resolved)
          if (!stat.isDirectory()) {
            this.emit({ type: 'notice', text: `${cmd.path} 不是目录` })
            break
          }
          this.conversation.setCwd(resolved)
          this.emit({ type: 'notice', text: `工作目录已切换到 ${resolved}` })
          // 复用 status_state 通知 UI 更新 cwd 显示（不需要 provider 配置——cwd 独立于 config）。
          if (isConfigured(this.config)) { this.emitStatusState() }
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
