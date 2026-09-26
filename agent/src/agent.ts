import type { AgentPort } from '@dogegg/bridge'
import type { UiToAgentMessage } from '@dogegg/bridge'
import type { AgentToUiMessage } from '@dogegg/bridge'
import type { Message, Config, McpServerConfig } from '@dogegg/bridge'
import { isConfigured } from '@dogegg/bridge'
import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { StateMachine, type TransitionInput, PendingPermissions, TurnRunner, type TurnParams, AgentLoop, Compactor, summarizeHistory, type PermissionResolution } from './turn'
import { BusyGate, newId, CancelledError, Logger } from './shared'
import { Conversation, SessionManager, SessionStore } from './session'
import { ConfigController, ConfigStore, ConfigEditor, resolveCurrent } from './config'
import { ContextAssembler, breakdownContextTokens } from './context'
import { ToolRegistry, resolveShell, shellGuidance } from './tools'
import { clientFor, type LlmClient } from './llm'
import { PermissionManager, deriveAlwaysScope } from './permission'
import { SkillsManager } from './skills'
import { McpManager, readProjectMcp, writeProjectMcp, mergeMcpServers, type McpMergedEntry } from './mcp'
import { homedir } from 'node:os'
import type { AgentContext } from './ctx'

// dispose 等待运行轮收尾的宽限上限：取消路径全部有 AbortSignal / 挂起审批 rejection 兜底，
// 正常应在毫秒级收尾；但 dispose 是退出路径，绝不能因单个收尾环节意外卡住而挂死信号处理——
// 到点即放弃等待，继续停 MCP 与落盘（轮次自身仍在后台尽力收尾）。
const DISPOSE_TURN_GRACE_MS = 5_000

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
  /** 用户级 skills 目录——缺省 ~/.dogegg/skills（测试注入临时目录）。 */
  skillsUserDir?: string
  /** 配置落盘路径——缺省真实配置文件。⚠️ 会触发配置保存的测试必须注入临时路径。 */
  configPath?: string
  /** MCP 启动超时（connect/listTools 两阶段各自计时）——缺省 30s；测试接缝（挂死 server 用例注入小值）。 */
  mcpStartupTimeoutMs?: number
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
  private readonly skills: SkillsManager
  private readonly mcp: McpManager

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
    this.skills = new SkillsManager(opts.skillsUserDir ?? join(homedir(), '.dogegg', 'skills'))
    this.skills.setProjectDir(cwd)
    this.ctx = {
      config,
      permission: new PermissionManager(config.permission, [this.skills.userDirPath()], () => this.registry.identities()),
      assembler: new ContextAssembler(config.systemPrompt, this.registry, () => this.skills.promptSection() + shellGuidance(resolveShell(config.shellProgram))),
      machine: new StateMachine('idle'),
      gate: new BusyGate(),
    }
    this.editor = new ConfigEditor(config)
    this.configs = new ConfigStore(opts.configPath)
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
      // 会话切换（new/resume）联动重挂项目级资源——与 set_cwd 分支的联动集同口径（见 onSessionSwitched）。
      onSessionSwitched: (cwd) => this.onSessionSwitched(cwd),
    })
    this.configController = new ConfigController({
      ctx: this.ctx,
      editor: this.editor,
      configs: this.configs,
      emit: (m) => this.emit(m),
      onConfigChanged: (config) => this.onConfigChanged(config),
    })
    this.mcp = new McpManager({
      registry: this.registry,
      // 启动超时测试接缝透传（缺省 30s，见 AgentOptions）。
      startupTimeoutMs: opts.mcpStartupTimeoutMs,
      // MCP 工具集变化（生命周期广播的 tools_list）直接改变工具 schema 占用——
      // 联动刷新状态栏与 Context 卡的 token 数字（见 refreshTokenDisplays 立法）。
      emit: (m) => { this.emit(m); if (m.type === 'tools_list') this.refreshTokenDisplays() },
    })
    // 启动即拉起已配置的 MCP server（异步——不阻塞消息循环；失败在 mcp_list 里可见）。
    void this.rebuildMcp().catch(() => {})
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
    // notice 落入有界环形缓冲——SSE 单播恢复时重放（启动期告警发出时连接集为空，见 resendSessionState）。
    if (m.type === 'notice') {
      this.recentNotices.push(m)
      if (this.recentNotices.length > 20) this.recentNotices.shift()
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
    // 运行中轮读 loop 的实时上下文（onProgress 同步的只读引用）——否则长任务期间
    // 状态迁移推送的 status_state 与 WebUI 轮询的 context_state 都停留在轮前旧值。
    // 空闲期（live 为 null）回落 conversation 的工作集，口径不变。
    const live = this.turnRunner.getLiveContext()
    return this.ctx.assembler.estimate(live ?? this.conversation.getContext())
  }

  // 统一的 status_state 发射——status_request 与 set_cwd 共用，避免字段重复。
  private emitStatusState(): void {
    const cur = this.current()
    this.emit({ type: 'status_state', sessionId: this.conversation.getId(), provider: cur.providerName, model: cur.modelName, cwd: this.conversation.getCwd(), state: this.ctx.machine.state, estimatedTokens: this.estimateCurrentTokens(), windowTokens: cur.contextWindow, usage: this.conversation.getUsage() })
  }

  // skills 清单广播：扫描两级目录（项目级随 cwd），供面板/命令联想/系统提示段共用同一事实源。
  private emitSkillsList(): void {
    // 失效缓存强制重扫——面板/命令联想的清单永远反映磁盘事实（外部手改文件也在此可见）。
    this.skills.invalidate()
    this.emit({ type: 'skills_list', skills: this.skills.list() })
  }

  // 会话切换（newSession/resume）后的项目级资源重挂——联动集与 set_cwd 分支完全一致：
  // 项目级 skills 目录随会话 cwd 走（跨项目 resume 后若不重挂，skills 面板/系统提示段显示
  // 旧项目，toggle 还会写错项目的 .skills.json）；项目级 .mcp.json 同理需要 diff 重建。
  // 钩子在 gate 占用期内被调用也无碍——这些操作自身不检查 gate（new/resume 本身已被 R2 阻塞语义保护，
  // 到达此处时必然不在轮次中；deleteSession 的替换路径复用 newSession 亦然）。
  private onSessionSwitched(cwd: string): void {
    this.skills.setProjectDir(cwd)
    this.emitSkillsList()
    this.emitSystemState()
    this.refreshTokenDisplays()
    void this.rebuildMcp().catch(() => {})
  }

  // system_state 消息构造——system_request 拉取与变更主动推送共用同一形状与同一现算来源。
  private systemStateMessage() {
    return { type: 'system_state' as const, path: this.ctx.config.systemPrompt ?? '内置', content: this.ctx.assembler.systemPrompt() }
  }

  // 系统提示词主动推送。prompt 是每次请求现算的（skills 增删启停、systemPrompt/shellProgram
  // 配置变更、cwd 切换都会改变下一轮实际下发的内容），而右侧面板展示的是最近一次拉取的
  // 快照——变更后不推送就会一直展示旧 prompt，误导「设置没生效」。凡 prompt 输入变化的
  // 事件都必须伴随一次推送。失败保持上一帧快照（system_request 拉取路径的 notice 语义不变）。
  private emitSystemState(): void {
    try { this.emit(this.systemStateMessage()) }
    catch { /* 保持上一帧快照 */ }
  }

  // context_state 消息构造——context_request 拉取与 token 显示刷新共用同一形状与同一估算口径。
  private contextStateMessage() {
    const m = this.current()
    // 总量与明细必须同源：breakdown 若仍取 conversation.getContext()（轮前数组），运行中会出现
    // 「总数实时跳动、分段明细静默过期」的撕裂。live 快照存在时，分段/会话用量/lastTurn/压缩
    // 计数全部取实时帧（usage 为轮末累计值 + 轮内已发生的部分）。
    const live = this.turnRunner.getLiveTurn()
    const context = live?.context ?? this.conversation.getContext()
    const tokens = this.ctx.assembler.estimate(context)
    const usage = this.conversation.getUsage()
    const sessionUsage = live
      ? { ...usage, promptTokens: usage.promptTokens + live.usage.promptTokens, completionTokens: usage.completionTokens + live.usage.completionTokens }
      : usage
    return {
      type: 'context_state' as const,
      estimatedTokens: tokens,
      windowTokens: m.contextWindow,
      percent: m.contextWindow ? Math.round((tokens / m.contextWindow) * 100) : 0,
      breakdown: breakdownContextTokens(this.ctx.assembler.systemPrompt(), context, this.registry.schemas()),
      lastTurn: live
        ? { promptTokens: live.usage.promptTokens, completionTokens: live.usage.completionTokens }
        : this.conversation.getLastTurn(),
      sessionUsage,
      compactions: this.conversation.getCompactions() + (live?.compactions ?? 0),
    }
  }

  // token 显示刷新推送。assembler.estimate = system prompt + context 消息 + 工具 schema——
  // skills 增删启停 / 配置变更 / cwd 切换改 system prompt，MCP 工具集变化改 schema，
  // 都会改变真实占用；但这些事件不经过状态机（无 state 广播），状态栏与 Context 卡的
  // 数字若不主动推送就停留在旧值，同样误导「设置没生效」。触发点都是空闲期事件
  // （运行中相关管理命令被 R2 阻塞），推送即当前真实占用。未配置 provider 无估算口径，跳过。
  private refreshTokenDisplays(): void {
    if (!isConfigured(this.ctx.config)) return
    try { this.emitStatusState(); this.emit(this.contextStateMessage()) }
    catch { /* 估算失败保持上一帧 */ }
  }

  // MCP 工具清单广播（tools_request 与 MCP 生命周期变化共用同一形状；身份随行供 UI 分组）。
  private emitToolsList(): void {
    this.emit({ type: 'tools_list', tools: this.registry.listTools() })
  }

  // 生效的 MCP server 列表 = 全局 config.mcpServers ⊕ 项目 .dogegg/.mcp.json（同名项目覆盖，scope 随条目下发）。
  private mergeMcp(): McpMergedEntry[] {
    return mergeMcpServers(this.ctx.config.mcpServers, readProjectMcp(this.conversation.getCwd()))
  }

  // MCP 权限键失配的运行时告警（P2-11 扩展，错误可见立法）：config 的 superRefine 只校验全局
  // mcpServers 名单（加载期拒绝），两类失配键此前是静默盲区——MCP 重建完成后用生效服务名单
  // （全局 ⊕ 项目）复查 permission 三桶键，让失配在运行时可见：
  // 1. 裸服务名键（如 "playwright" 而非 "mcp:playwright"）：前缀立法下不作为服务键匹配，
  //    用户的 allow/reject 意图丢失（回落默认 ask）；
  // 2. 遗留标签形态键（含 '__'，如 "mcp__playwright__browser_close"）：v3 前缀立法前的书写
  //    形态，不作为服务键生效——该键的 patterns 会按 path 主参数匹配，对 MCP 工具通常永不
  //    生效，应改用 mcp:<服务名> 键。与生效服务名单无关（内建工具名不含 '__'，无误报面），
  //    服务名单为空也要告警；标签第二段可提取时给出具体的改写建议。
  // 已警告键去重：重建链触发频繁（启动/config 变更/set_cwd/面板 manage），同键重复弹 notice 是噪音。
  // 去重集带键集合指纹复位：记录上次检查的三桶键集合指纹，变化时清空去重集——
  // 否则用户改回失配形态（曾把键改成合法写法又改回来）会因去重集残留而永远不再告警。
  private readonly warnedMcpKeys = new Set<string>()
  private warnedMcpKeysFingerprint = ''
  private warnMcpPermissionKeys(): void {
    const names = new Set(this.mergeMcp().map((e) => e.server.name))
    // 指纹在任何键集合变化时都更新——键被修正后又改坏时同样要能再告警。
    const fingerprint = JSON.stringify([this.ctx.config.permission.allow, this.ctx.config.permission.reject, this.ctx.config.permission.ask].map((b) => Object.keys(b).sort()))
    if (fingerprint !== this.warnedMcpKeysFingerprint) {
      this.warnedMcpKeysFingerprint = fingerprint
      this.warnedMcpKeys.clear()
    }
    for (const bucket of [this.ctx.config.permission.allow, this.ctx.config.permission.reject, this.ctx.config.permission.ask]) {
      for (const key of Object.keys(bucket)) {
        if (this.warnedMcpKeys.has(key)) continue
        // 前缀化键是合法服务键——即使服务名本身含 '__'（服务名零约束）也不告警。
        if (key.startsWith('mcp:')) continue
        // 遗留标签形态：先于裸名检查——它必然失配，不依赖生效服务名单。
        if (key.includes('__')) {
          this.warnedMcpKeys.add(key)
          // mcp__服务__工具 / mcp__服务 → 服务名取第二段；推不出具体名时给出占位写法。
          const parts = key.split('__')
          const suggest = parts[0] === 'mcp' && parts[1] ? `mcp:${parts[1]}` : 'mcp:<服务名>'
          this.emit({ type: 'notice', text: `权限键 "${key}" 是遗留标签形态——该键的 patterns 会按 path 主参数匹配，对 MCP 工具通常永不生效，应改用 "${suggest}" 键`, channel: 'mcp' })
          continue
        }
        // 裸服务名键：仅在名字确实撞上生效服务时告警（否则可能是普通写错的键，不属于本告警的职责）。
        if (!names.has(key)) continue
        this.warnedMcpKeys.add(key)
        this.emit({ type: 'notice', text: `权限键 "${key}" 应写作 "mcp:${key}"，当前不生效（裸服务名键不匹配 MCP 工具）`, channel: 'mcp' })
      }
    }
  }

  // diff 重建 MCP server（异步；变化后自动广播 mcp_list + tools_list）。
  // 串行化：触发源多（启动/config_updated/set_cwd/面板 manage），链式排队防交错重入——
  // 交错会让同一 server 被起两个进程、旧 client 变孤儿泄漏。merge 在执行时刻取值（总是最新配置）。
  private mcpRebuildChain: Promise<void> = Promise.resolve()
  private rebuildMcp(): Promise<void> {
    this.mcpRebuildChain = this.mcpRebuildChain
      .then(() => this.mcp.rebuild(this.mergeMcp()))
      // 重建完成后再查权限键失配（裸服务名 / 遗留标签形态）：此刻生效服务名单（含项目级）才是权威事实。
      .then(() => this.warnMcpPermissionKeys())
      .catch(() => { /* 重建失败不中断后续重建——状态在 mcp_list 可见 */ })
    return this.mcpRebuildChain
  }

  // 等待在飞的 MCP 重建收敛（P2-4）：busy 门只挡「新触发」的重建，不挡「已在飞」的——
  // 轮次若不等它，开轮时刻的工具清单与重建完成后的清单漂移（工具清单随 system 消息快照进轮），
  // 重建中停掉的 server 其在飞 MCP 工具会被断连。submit 前调用：等当前链尾；若等待期间又有
  // 新重建排队（消息在 await 点交错是常态），尾引用变化则继续等——直到「我们等的仍是尾」，
  // 保证提交时刻重建静止。只读链尾、绝不触发新重建；链自身不 await gate（无死锁面）；
  // 时长上限由启动超时兜底（每个 server 最坏 30s），此处不加额外超时。
  private async awaitMcpRebuildSettled(): Promise<void> {
    let tail = this.mcpRebuildChain
    for (;;) {
      await tail
      if (tail === this.mcpRebuildChain) return
      tail = this.mcpRebuildChain
    }
  }

  // 项目级 .mcp.json 落盘（失败发 notice 不静默）：磁盘只读/权限问题时面板状态与磁盘事实分叉，
  // 用户必须可见（错误可见立法；notice 形态与 skills 面板一致，channel 定位到 mcp 面板）。
  private writeProjectMcpOrNotice(cwd: string, servers: McpServerConfig[]): void {
    try {
      writeProjectMcp(cwd, servers)
    } catch (e) {
      this.emit({ type: 'notice', text: `项目级 MCP 配置写入失败：${(e as Error).message}`, channel: 'mcp' })
    }
  }

  private emitMcpList(): void {
    this.emit({ type: 'mcp_list', servers: this.mcp.listStatus() })
  }

  // /mcp 面板 CRUD 的实现归属：global 走 ConfigEditor（复用校验/落盘/广播链路），project 直写 .mcp.json。
  // 保存/启停后触发 rebuild（全局经 config_updated 钩子，项目显式触发）。
  private handleMcpManage(cmd: Extract<UiToAgentMessage, { type: 'mcp_manage' }>): void {
    if (cmd.scope === 'global') {
      const next = [...this.ctx.config.mcpServers]
      const findIdx = (name?: string): number => next.findIndex((s) => s.name === name)
      if (cmd.action === 'save') {
        if (!cmd.server) { this.emit({ type: 'notice', text: '缺少 server 配置', channel: 'mcp' }); return }
        const i = findIdx(cmd.server.name)
        if (i >= 0) next[i] = cmd.server; else next.push(cmd.server)
        this.configController.replaceMcpServers(next) // config_updated → onConfigChanged → rebuild
        return
      }
      if (cmd.action === 'delete') {
        this.configController.replaceMcpServers(next.filter((s) => s.name !== cmd.name))
        this.emitMcpList()
        return
      }
      if (cmd.action === 'toggle') {
        const i = findIdx(cmd.name)
        if (i < 0) { this.emit({ type: 'notice', text: `未找到 server：${cmd.name}`, channel: 'mcp' }); return }
        next[i] = { ...next[i]!, enabled: cmd.enabled ?? !next[i]!.enabled }
        this.configController.replaceMcpServers(next)
        return
      }
      return
    }
    // ── 项目级：直写 .dogegg/.mcp.json（落盘失败发 notice，不静默——见 writeProjectMcpOrNotice）──
    const cwd = this.conversation.getCwd()
    const list = readProjectMcp(cwd)
    if (cmd.action === 'save') {
      if (!cmd.server) { this.emit({ type: 'notice', text: '缺少 server 配置', channel: 'mcp' }); return }
      const i = list.findIndex((s) => s.name === cmd.server!.name)
      if (i >= 0) list[i] = cmd.server; else list.push(cmd.server)
      this.writeProjectMcpOrNotice(cwd, list)
    } else if (cmd.action === 'delete') {
      this.writeProjectMcpOrNotice(cwd, list.filter((s) => s.name !== cmd.name))
    } else if (cmd.action === 'toggle') {
      const i = list.findIndex((s) => s.name === cmd.name)
      if (i < 0) { this.emit({ type: 'notice', text: `未找到 server：${cmd.name}`, channel: 'mcp' }); return }
      list[i] = { ...list[i]!, enabled: cmd.enabled ?? !list[i]!.enabled }
      this.writeProjectMcpOrNotice(cwd, list)
    }
    void this.rebuildMcp().catch(() => {})
    this.emitMcpList()
  }

  // skills 面板 CRUD 的实现归属：create（骨架生成）/ update（全文替换）/ delete（删目录）/ get（回全文）。
  // 操作失败（名称非法/已存在/越界）转 notice——面板原地可见，不静默。
  private handleSkillsManage(cmd: Extract<UiToAgentMessage, { type: 'skills_manage' }>): void {
    try {
      switch (cmd.action) {
        case 'create':
          this.skills.create(cmd.scope, cmd.name, cmd.description ?? '')
          this.emit({ type: 'notice', text: `skill 已创建：${cmd.name}（${cmd.scope}）——正文记得用编辑器充实` })
          break
        case 'update':
          this.skills.update(cmd.scope, cmd.name, cmd.content ?? '')
          break
        case 'toggle': {
          // 对缺失态条目「启用」即清理孤儿记录——文案区分，避免误导为恢复了可用 skill。
          const wasMissing = this.skills.list().find((s) => s.scope === cmd.scope && s.name === cmd.name)?.missing === true
          this.skills.setEnabled(cmd.scope, cmd.name, cmd.enabled === true)
          const action = cmd.enabled ? (wasMissing ? '已清理（移除孤儿记录）' : '已启用') : '已停用'
          this.emit({ type: 'notice', text: `skill ${action}：${cmd.name}（${cmd.scope}）` })
          break
        }
        case 'delete':
          this.skills.remove(cmd.scope, cmd.name)
          this.emit({ type: 'notice', text: `skill 已删除：${cmd.name}（${cmd.scope}）` })
          break
        case 'get':
          this.emit({ type: 'skill_content', scope: cmd.scope, name: cmd.name, content: this.skills.read(cmd.scope, cmd.name) })
          return // get 的响应是 skill_content，不需要重播清单
      }
      this.emitSkillsList()
      // skills 增删启停改变系统提示的技能清单段——主动推送新快照（见 emitSystemState 立法），
      // 同时刷新状态栏与 Context 卡的 token 数字（见 refreshTokenDisplays 立法）。
      this.emitSystemState()
      this.refreshTokenDisplays()
    } catch (e) {
      this.emit({ type: 'notice', text: (e as Error).message, channel: 'skills' })
    }
  }

  // 向 UI 提出权限请求，返回一个在收到 permission_decision 时才决议的 Promise。
  // 【SDK 接缝】无头使用时可注入程序化 permissionHandler 替代此 Port 往返。
  private requestPermission(tool: string, input: unknown): Promise<PermissionResolution> {
    return new Promise((resolve, reject) => {
      const id = newId()
      // 推导「对此范围不再询问」的模式（deriveAlwaysScope）随请求下发；推导不出时 UI 维持三档。
      // tool/input 一并存入挂起项——snapshot 重发挂起审批时按原 id 还原 permission_request 载荷。
      const scopePattern = deriveAlwaysScope(tool, input, this.conversation.getCwd())
      this.pending.add(id, { resolve, reject, scopePattern, tool, input })
      // 【P2-3 立法】emit 包 try/catch：pending.add 之后 emit 一抛（如 emit 链路落盘 appendFileSync
      // 磁盘满），旧实现 Promise 永不 settle → 工具的 await 永久挂起、gate 永久 busy，进程锁死。
      // 捕获后用 PendingPermissions 的 reject 语义唤醒该等待（pending 只有 rejectAll——loop 串行
      // 执行工具，同一时刻至多一个挂起请求，rejectAll 不会误伤其他等待），异常沿 await 正常
      // 传播为工具失败（executor → loop catch → 轮次 error 收尾），并清空挂起表防泄漏。
      try {
        this.emit({ type: 'permission_request', id, tool, input, ...(scopePattern ? { alwaysScope: { pattern: scopePattern } } : {}) })
      } catch (e) {
        this.pending.rejectAll(e as Error)
      }
    })
  }

  // 挂起权限重发（恢复链的一部分）：刷新页面/断线重连后前端丢失挂起中的审批，
  // 按【原 id】重发 permission_request——同 id 幂等，UI 按 id 关联，决议照常送达。
  private resendPendingPermissions(): void {
    for (const p of this.pending.snapshot()) {
      this.emit({ type: 'permission_request', id: p.id, tool: p.tool, input: p.input, ...(p.alwaysScope ? { alwaysScope: p.alwaysScope } : {}) })
    }
  }

  // notice 有界环形缓冲（容量 20）：emit 时捕获、resendSessionState 单播恢复时重放。
  private readonly recentNotices: Extract<AgentToUiMessage, { type: 'notice' }>[] = []

  // P2-23：busy 期的运行现场（session_ready.live）——流式 partial 与进行中工具块。
  // 数据源是 TurnRunner.getLiveTurn()（onProgress 存档 + loop 实时直读覆盖，长工具执行中 /
  // 流式生成中也拿得到最新值）。partial 为空串/undefined、无进行中工具时不带对应字段；
  // 两者皆无（或当前 busy 的是 compact——无轮次现场）则整个 live 缺省（契约：live 各字段可选，
  // 空对象对 UI 无意义，不发）。非 busy 期一律不带——恢复后 partial/工具块从 history 重建即可。
  private liveSnapshot(): { partial?: string; runningTool?: { id: string; name: string; input: unknown } } | undefined {
    if (!this.ctx.gate.busy) return undefined
    const live = this.turnRunner.getLiveTurn()
    if (!live || (!live.partial && !live.runningTool)) return undefined
    return {
      ...(live.partial ? { partial: live.partial } : {}),
      ...(live.runningTool ? { runningTool: live.runningTool } : {}),
    }
  }

  // 重发当前会话的状态快照：session_ready（消息历史 + thinking）+ 近期 notice 重放 + 挂起中的
  // permission_request。
  // 【立法】SSE 重连/刷新后前端无后端重放——唯一恢复源是重发快照。server 在新 SSE 连接建立时
  // 调用此方法并传入**该连接的定向 sender**：恢复是新连接的私事，广播会把所有在看客户端的
  // 运行中界面整体重置（运行中的流式内容只存在于循环局部，未落 history）。近期 notice 重放
  // 解决「启动期告警发出时 SSE 连接集为空、WebUI 用户永远看不到」（如裸服务名权限键告警）。
  // out 直连 port.post 而不走 this.emit——避免重放的 notice 被再次捕进环形缓冲。
  resendSessionState(send?: (m: AgentToUiMessage) => void): void {
    const out = send ?? ((m: AgentToUiMessage) => this.port.post(m))
    const thinking = this.conversation.getThinking()
    const live = this.liveSnapshot()
    out({
      type: 'session_ready',
      id: this.conversation.getId(),
      messages: [...this.conversation.getHistory()],
      // busy 与 WP2 的 session_ready 契约同步（恢复链立法）：运行中重连时 UI 不被打回 idle。
      busy: this.ctx.gate.busy,
      // P2-23：busy 时附加运行现场——UI 恢复流式 partial 光标与进行中工具块（否则重连后
      // 长任务期间界面「看起来 idle」，与后端真实状态分叉）。
      ...(live ? { live } : {}),
      ...(thinking.length ? { thinking: [...thinking] } : {}),
    })
    for (const n of this.recentNotices) out(n)
    for (const p of this.pending.snapshot()) {
      out({ type: 'permission_request', id: p.id, tool: p.tool, input: p.input, ...(p.alwaysScope ? { alwaysScope: p.alwaysScope } : {}) })
    }
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
    this.ctx.permission = new PermissionManager(config.permission, [this.skills.userDirPath()], () => this.registry.identities())
    this.ctx.permission.restore(saved)
    this.ctx.assembler = new ContextAssembler(config.systemPrompt, this.registry, () => this.skills.promptSection() + shellGuidance(resolveShell(config.shellProgram)))
    // mcpServers 可能随配置变化——diff 重建（无变化时幂等空转，不广播）。
    void this.rebuildMcp().catch(() => {})
    // systemPrompt/shellProgram 配置变更即时推送系统提示词快照（同上，不等下一次拉取）。
    this.emitSystemState()
    // provider/model/systemPrompt/shellProgram 变更都改变 token 估算口径——状态栏与 Context 卡一并刷新。
    this.refreshTokenDisplays()
  }

  // 在飞运行轮句柄（dispose 的等待面）：submit / compact / invoke_skill 产生的轮次 Promise
  // 登记于此，dispose 据此等待运行轮收尾。TurnRunner 不暴露在飞句柄（其职责是轮次执行，
  // 并发语义已由 gate 承载），门面在调用点登记是改动最小的接缝。busy 时 submit/compact 自行
  // 发 notice 立即返回、不产生轮次——wasIdle 判定避免用「立即解决的空 Promise」覆盖真实
  // 在飞轮的登记；finally 的同一性判断防并发场景误清新登记（详见 runTrackedTurn）。
  private turnInFlight: Promise<void> | null = null

  // 轮次执行的登记包装：空闲时（本次调用真的会开轮）登记 Promise 再 await；busy 时直接透传
  //（内部自会发「运行中，请稍候」）。同一性判断：轮 A 收尾（gate 已 leave、轮 A 的 finally
  // 尚未执行）与轮 B 开轮之间存在微任务窗口，B 的登记会覆盖 A——A 清理时比对引用，
  // 只清理仍指向自己的登记，不误删 B 的。
  private async runTrackedTurn(run: () => Promise<void>): Promise<void> {
    if (this.ctx.gate.busy) { await run(); return }
    const turn = run()
    this.turnInFlight = turn
    try { await turn } finally { if (this.turnInFlight === turn) this.turnInFlight = null }
  }

  // 命令分发：动工作集类在 running 时发 notice 不静默丢弃；纯查询类始终放行。
  async send(cmd: UiToAgentMessage): Promise<void> {
    switch (cmd.type) {
      // ── 动 loop 工作集 / 轮次（运行中阻塞）──
      case 'submit': {
        if (!isConfigured(this.ctx.config)) { this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config 添加并保存后重试' }); break }
        // P2-4：开轮前先等在飞的 MCP 重建收敛——重建进行中提交会让轮中途工具清单漂移、
        // 在飞 MCP 工具被断连（详见 awaitMcpRebuildSettled 立法）。等待发生在 gate 占用之前，
        // 且重建链自身不 await gate——无死锁面。顺带让 resolveTurnParams 取到重建后的最新配置。
        await this.awaitMcpRebuildSettled()
        await this.runTrackedTurn(() => this.turnRunner.submit(cmd.text, this.resolveTurnParams()))
        break
      }
      case 'compact_request':
        if (!isConfigured(this.ctx.config)) { this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config' }); break }
        // 压缩同样登记（dispose 要等它收尾——压缩也占 gate）。
        await this.runTrackedTurn(() => this.turnRunner.compact(this.resolveTurnParams()))
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
        // /clear 后 context 已空——估算口径完整变化（回到裸 system prompt + 工具 schema），
        // 主动刷新状态栏与 Context 卡的 token 数字，否则显示停留在清空前的旧值。
        this.refreshTokenDisplays()
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

      // ── skills（查询放行；管理是文件写操作运行中阻塞；调用走轮次）──
      case 'skills_request':
        this.emitSkillsList()
        break
      case 'skills_manage':
        // busy 分支带 channel：WebUI 的 skills 面板 inline 展示该提示（不带 channel 会落到全局 toast 之外的面板盲区）。
        if (this.ctx.gate.busy) { this.emit({ type: 'notice', text: '运行中，请稍候', channel: 'skills' }); break }
        this.handleSkillsManage(cmd)
        break
      case 'invoke_skill':
        if (!isConfigured(this.ctx.config)) { this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config 添加并保存后重试' }); break }
        // 与 submit 同口径：开轮前等在飞 MCP 重建收敛（invoke_skill 也是开轮，同一漂移面）。
        await this.awaitMcpRebuildSettled()
        try {
          const skillText = this.skills.forInvocation(cmd.name, cmd.args)
          await this.runTrackedTurn(() => this.turnRunner.submit(skillText, this.resolveTurnParams()))
        } catch (e) {
          this.emit({ type: 'notice', text: (e as Error).message })
        }
        break

      // ── MCP（查询放行；管理写配置/文件，运行中阻塞）──
      case 'mcp_request':
        this.emitMcpList()
        break
      case 'mcp_manage':
        // busy 分支带 channel：WebUI 的 mcp 面板 inline 展示该提示（与 skills busy 同口径）。
        if (this.ctx.gate.busy) { this.emit({ type: 'notice', text: '运行中，请稍候', channel: 'mcp' }); break }
        this.handleMcpManage(cmd)
        break

      // ── 纯查询（任意时刻放行）──
      case 'tools_request':
        this.emitToolsList()
        break
      case 'context_request': {
        if (!isConfigured(this.ctx.config)) { this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config' }); break }
        try { this.emit(this.contextStateMessage()) }
        catch { this.emit({ type: 'notice', text: '上下文状态读取失败' }) }
        break
      }
      case 'status_request': {
        // 【TUI 头部依赖修复】TUI 的 headerReady 依赖 status_state 的 cwd——旧实现未配置 provider
        // 时只回 notice 不回 status_state，头部永不就绪。未配置也照常下发 status_state：
        // provider/model 是展示字段，空串即可渲染；windowTokens 0（无配置口径）；cwd 用会话
        // 当前值；estimatedTokens 走本地估算（不依赖 provider 配置）。原提示 notice 保留——
        // 两条消息不互斥（状态帧给头部，notice 给用户引导）。
        try {
          if (!isConfigured(this.ctx.config)) {
            this.emit({ type: 'status_state', sessionId: this.conversation.getId(), provider: '', model: '', cwd: this.conversation.getCwd(), state: this.ctx.machine.state, estimatedTokens: this.estimateCurrentTokens(), windowTokens: 0, usage: this.conversation.getUsage() })
            this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config' })
            break
          }
          this.emitStatusState()
        } catch { this.emit({ type: 'notice', text: '状态读取失败' }) }
        break
      }
      case 'system_request':
        try { this.emit(this.systemStateMessage()) }
        catch { this.emit({ type: 'notice', text: 'system prompt 加载失败（路径不存在或无法读取）' }) }
        break
      case 'log_request':
        try { this.emit({ type: 'log_state', path: this.logger.path(this.conversation.getId()) ?? '~/.dogegg/logs/<session>.log', tail: this.logger.tail(this.conversation.getId()) }) }
        catch { this.emit({ type: 'notice', text: '日志读取失败' }) }
        break
      case 'permissions_request':
        // /permissions：返回当前会话的提升清单（按工具分组；patterns 空 = 整工具）。
        this.emit({ type: 'permissions_list', permissions: this.ctx.permission.snapshotPermissions() })
        // 顺带重发挂起中的审批（恢复链）：权限面板重开/重连时，挂起请求借此恢复可见可决议。
        this.resendPendingPermissions()
        break
      case 'rename_session': {
        // P2-1：busy 门（对齐同文件 set_cwd/skills_manage 的 R2 阻塞语义）。轮中 rename 会把
        // 「轮前工作集」snapshotFull 落盘——轮内消息还在 loop 手里未同步进 history，落盘即把
        // 检查点刚写的轮内进度回退成旧态；busy 时拒绝执行，notice 不带 channel（TUI 对话流
        // 与 WebUI 全局 toast 都可见，与 set_cwd 的 busy 提示同口径）。
        if (this.ctx.gate.busy) { this.emit({ type: 'notice', text: '运行中，请稍候' }); break }
        // /rename：手动命名当前会话（手动命名优先于自动标题）。notice 让两端对话流都有可见回执。
        const title = cmd.title.trim()
        if (!title) { this.emit({ type: 'notice', text: '用法：/rename <名称>' }); break }
        this.conversation.setTitle(title)
        try {
          this.sessions.save(
            this.conversation.snapshotFull(
              this.ctx.permission.snapshotPermissions(),
              this.conversation.getUsage(),
              this.conversation.getCompactions(),
            ),
          )
        } catch { /* 命名落盘失败静默 */ }
        this.emit({ type: 'notice', text: `会话已命名「${title}」` })
        this.emit({ type: 'session_list', sessions: this.sessions.list() })
        break
      }
      case 'permission_revoke':
        // 撤销会话提升：带 pattern 撤单条模式，不带撤整工具；撤后重推清单。
        this.ctx.permission.revoke(cmd.tool, cmd.pattern)
        this.emit({ type: 'permissions_list', permissions: this.ctx.permission.snapshotPermissions() })
        break
      case 'set_cwd': {
        // 运行时切换工作目录——运行中阻塞（避免 in-flight 工具写到错误目录）。
        if (this.ctx.gate.busy) { this.emit({ type: 'notice', text: '运行中，请稍候' }); return }
        try {
          // 相对路径锚定会话 cwd 解析（与 cd 状态机预期一致：/cd 子目录相对当前会话目录，
          // 而非进程启动目录）；绝对路径语义不变（resolve 对绝对输入直接返回归一化结果）。
          const resolved = resolve(this.conversation.getCwd(), cmd.path)
          const stat = statSync(resolved)
          if (!stat.isDirectory()) {
            this.emit({ type: 'notice', text: `${cmd.path} 不是目录` })
            break
          }
          this.conversation.setCwd(resolved)
          // 项目级 skills 目录随 cwd 变化——重扫并广播（清单段下一轮请求自动生效）。
          this.skills.setProjectDir(resolved)
          this.emitSkillsList()
          this.emitSystemState()
          this.refreshTokenDisplays()
          void this.rebuildMcp().catch(() => {})
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

  // ── 优雅退出（P2-6b）────────────────────────────────────────────────────────
  // dispose：唯一调用方是组合根的信号处理（SIGINT/SIGTERM 接线在 bin/dogegg.ts；dev:web 在
  // main-web.ts）——消息通道里没有对应命令，正常消息流永远不会走到这里。
  // 流程：①运行中先取消（与 cancel 消息完全同款的双机制：gate.cancel 触发协作检查点 +
  // AbortSignal 中断在飞 fetch/工具，pending.rejectAll 唤醒挂起中的审批），随后等待运行轮
  // 收尾（有界宽限——轮次取消路径理论上限毫秒级，但退出路径绝不能被单个收尾环节挂死）；
  // ②停掉全部 MCP server（复用 stopOne 清理路径、等待 close 竞速完成，stdio 子进程不残留）；
  // ③尽力而为最终落盘（轮次正常结束已由 saveOrNotice 落盘，这里兜「空闲期直接退出」与
  // 「取消收尾后仍有未落盘变更」两种情形；失败吞掉——退出路径无处展示错误）。
  // 幂等立法：信号可能连发（用户狂按 Ctrl+C），二次调用直接返回，不重复取消/停服/落盘。
  // 已知边界：submit 正在 awaitMcpRebuildSettled 的窄缝里到达的 dispose 不会等它（此刻既无
  // 在飞轮也无在飞停服动作）——进程随即退出，组合根在 dispose 后 exit 即可终止一切。
  private disposed = false
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    // ① 与 cancel 消息分支同款：两路取消一次触发（gate 双机制 + 挂起审批唤醒）。
    if (this.ctx.gate.busy) {
      this.ctx.gate.cancel()
      this.pending.rejectAll(new CancelledError())
    }
    // 等运行轮收尾（轮次 Promise 由 runTrackedTurn 登记；catch 兜底——取消引发的 rejection
    // 已在轮内转成部分结果，这里吞掉防未处理拒绝）。宽限到点即放弃，不拖死信号处理。
    const turn = this.turnInFlight
    if (turn) {
      let grace: NodeJS.Timeout | undefined
      await Promise.race([
        turn.catch(() => { /* 轮内已兜底——防御性吞掉 */ }),
        new Promise<void>((r) => {
          grace = setTimeout(r, DISPOSE_TURN_GRACE_MS)
          grace.unref() // 宽限定时器不持有进程：dispose 之后组合根可能直接 exit
        }),
      ]).finally(() => clearTimeout(grace))
    }
    // ② 停 MCP：含注册表摘除与 stdio 子进程回收（close 竞速单个 1s 上限、并行）。
    await this.mcp.stopAll()
    // ③ 尽力而为最终落盘：有历史才写（空会话没有可落的内容）。
    try {
      if (this.conversation.getHistory().length > 0) {
        this.sessions.save(
          this.conversation.snapshotFull(
            this.ctx.permission.snapshotPermissions(),
            this.conversation.getUsage(),
            this.conversation.getCompactions(),
          ),
        )
      }
    } catch { /* 退出路径的落盘失败无从展示——尽力而为 */ }
  }
}
