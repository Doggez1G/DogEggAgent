import type { UiToAgentMessage } from '../events/ui-to-agent'
import type { AgentToUiMessage } from '../events/agent-to-ui'
import type { Message, PermissionDecision, State } from '../events/types'
import { getAllTools } from '../tools/registry'
import { ProviderRegistry, openAiAdapter } from '../llm/provider/openai'
import { PermissionManager } from './permission'
import { loadSystemPrompt, estimateContextTokens, splitForCompaction } from './context'
import { saveSession, loadSession, listSessions } from './session'
import { runLoop, summarizeHistory } from './loop'
import { configSchema, isConfigured, type Config, type ProviderConfig, type ModelConfig } from '../config/schema'
import { saveConfig } from '../config/loader'
import { newId } from '../common/utils/id'
import { CancelledError } from '../common/errors'

interface PendingPermission {
  resolve: (d: PermissionDecision) => void
  reject: (e: Error) => void
}

// Agent 是后端对外的唯一入口：持有会话历史、provider/permission 运行时状态，emit 事件、收命令。
// 它不依赖 ui，只通过 AgentToUi/UiToAgent 消息与前端交互。
export class Agent {
  private listeners = new Set<(m: AgentToUiMessage) => void>()
  private history: Message[] = []
  private sessionId = newId()
  private pending = new Map<string, PendingPermission>()
  private cancelled = false
  private running = false
  private state: State = 'idle'
  private controller: AbortController | null = null
  private lastGoodConfig: string
  private providers: ProviderRegistry
  private permission: PermissionManager

  constructor(private config: Config, private cwd: string) {
    this.providers = new ProviderRegistry(config.providers)
    this.permission = new PermissionManager(config.permission)
    this.lastGoodConfig = JSON.stringify(config)
  }

  on(listener: (m: AgentToUiMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(m: AgentToUiMessage): void {
    if (m.type === 'state') this.state = m.to
    this.listeners.forEach((l) => l(m))
  }

  private currentModel() {
    const p = this.providers.get(this.config.defaultProvider!) ?? this.config.providers[0]!
    return p.models.find((m) => m.name === this.config.defaultModel) ?? p.models[0]!
  }

  private estimateCurrentTokens(): number {
    return estimateContextTokens(loadSystemPrompt(this.config.systemPrompt), this.history, getAllTools().map((t) => t.parameters))
  }

  // 手工触发压缩（/compact）：复用与自动压缩相同的总结逻辑，压最旧历史为摘要 + 保留最近 4 条。
  private async compactNow(): Promise<void> {
    const provider = this.providers.get(this.config.defaultProvider!)!
    const model = this.currentModel()
    const params = getAllTools().map((t) => t.parameters)
    const system = loadSystemPrompt(this.config.systemPrompt)
    const before = estimateContextTokens(system, this.history, params)
    const { old, fresh } = splitForCompaction(this.history)
    if (old.length === 0) {
      this.emit({ type: 'compaction', before_tokens: before, after_tokens: before })
      return
    }
    const summary = await summarizeHistory({ adapter: openAiAdapter(), providerBaseURL: provider.baseURL, apiKey: provider.apiKey, model: model.name }, old)
    this.history = [{ role: 'user', content: `[前文摘要]\n${summary}` }, ...fresh]
    saveSession(this.sessionId, this.history)
    this.emit({ type: 'compaction', before_tokens: before, after_tokens: estimateContextTokens(system, this.history, params) })
  }

  // 向 UI 提出权限请求，返回一个在收到 permission_decision 时才决议的 Promise。
  private requestPermission(tool: string, input: unknown): Promise<PermissionDecision> {
    return new Promise((resolve, reject) => {
      const id = newId()
      this.pending.set(id, { resolve, reject })
      this.emit({ type: 'permission_request', id, tool, input })
    })
  }

  async send(cmd: UiToAgentMessage): Promise<void> {
    switch (cmd.type) {
      case 'submit': {
        if (this.running) return
        if (!isConfigured(this.config)) {
          this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config 添加并保存后重试' })
          return
        }
        this.cancelled = false
        this.controller = new AbortController()
        this.running = true
        this.history.push({ role: 'user', content: cmd.text })
        this.emit({ type: 'message', role: 'user', id: '' })
        const provider = this.providers.get(this.config.defaultProvider!)!
        const model = this.currentModel()
        try {
          this.history = await runLoop({
            adapter: openAiAdapter(),
            providerBaseURL: provider.baseURL,
            apiKey: provider.apiKey,
            model: model.name,
            maxOutput: model.maxOutput,
            maxRetries: this.config.maxRetries,
            reasoning: model.reasoning,
            tools: getAllTools(),
            systemPrompt: loadSystemPrompt(this.config.systemPrompt),
            windowTokens: model.contextWindow,
            maxIterations: this.config.maxIterations,
            permission: this.permission,
            cwd: this.cwd,
            signal: this.controller.signal,
            emit: (e) => this.emit(e),
            requestPermission: (tool, input) => this.requestPermission(tool, input),
            checkCancelled: () => this.cancelled,
          })
        } catch (e) {
          if (!(e instanceof CancelledError)) this.emit({ type: 'error', error: e as Error })
          this.emit({ type: 'state', from: this.state, to: 'idle' })
        } finally {
          this.running = false
          saveSession(this.sessionId, this.history)
        }
        break
      }
      case 'cancel': {
        this.cancelled = true
        this.controller?.abort()
        // 挂起中的权限请求全部拒绝，让 loop 立刻以 CancelledError 退出，避免悬挂。
        for (const [, p] of this.pending) p.reject(new CancelledError())
        this.pending.clear()
        break
      }
      case 'permission_decision': {
        const p = this.pending.get(cmd.id)
        if (p) {
          this.pending.delete(cmd.id)
          p.resolve(cmd.decision)
        }
        break
      }
      case 'new_session':
        if (this.running) return
        this.history = []
        this.sessionId = newId()
        this.emit({ type: 'session_ready', id: this.sessionId, messages: [] })
        break
      case 'list_sessions':
        this.emit({ type: 'session_list', sessions: listSessions() })
        break
      case 'resume_session': {
        if (this.running) return
        const s = loadSession(cmd.id)
        this.history = s.messages
        this.sessionId = s.id
        this.emit({ type: 'session_ready', id: s.id, messages: s.messages })
        break
      }
      case 'tools_request':
        this.emit({ type: 'tools_list', tools: getAllTools().map((t) => ({ name: t.name, description: t.description })) })
        break
      case 'config_request':
        this.emit({ type: 'config_state', config: this.config })
        break
      case 'context_request': {
        if (!isConfigured(this.config)) { this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config' }); break }
        const m = this.currentModel()
        const tokens = this.estimateCurrentTokens()
        this.emit({ type: 'context_state', estimatedTokens: tokens, windowTokens: m.contextWindow, percent: m.contextWindow ? Math.round((tokens / m.contextWindow) * 100) : 0 })
        break
      }
      case 'status_request': {
        if (!isConfigured(this.config)) { this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config' }); break }
        const m = this.currentModel()
        this.emit({ type: 'status_state', sessionId: this.sessionId, provider: this.config.defaultProvider!, model: this.config.defaultModel!, cwd: this.cwd, state: this.state, estimatedTokens: this.estimateCurrentTokens(), windowTokens: m.contextWindow })
        break
      }
      case 'system_request':
        this.emit({ type: 'system_state', path: this.config.systemPrompt ?? '内置', content: loadSystemPrompt(this.config.systemPrompt) })
        break
      case 'clear_history':
        if (this.running) return
        this.history = []
        this.emit({ type: 'history_cleared' })
        break
      case 'compact_request':
        if (!isConfigured(this.config)) { this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config' }); break }
        await this.compactNow()
        break
      case 'log_request':
        this.emit({ type: 'log_state', path: '~/.dogegg/logs/latest.log', tail: '' })
        break
      case 'config_set':
        this.applyConfigSet(cmd.path, cmd.value)
        break
      case 'config_add':
        this.applyConfigAdd(cmd.path, cmd.value)
        break
      case 'config_remove':
        this.applyConfigRemove(cmd.path, cmd.key, cmd.match)
        break
      case 'quit':
        process.exit(0)
    }
  }

  // 配置编辑后统一：先重校验，无效则回滚到最后一次合法快照并报错，避免半写坏状态；有效则重建运行时并落盘。
  private afterConfigEdit(): void {
    const parsed = configSchema.safeParse(this.config)
    if (!parsed.success) {
      this.config = JSON.parse(this.lastGoodConfig)
      this.emit({ type: 'error', error: new Error('配置校验失败，已回滚：' + parsed.error.issues[0]?.message) })
      return
    }
    this.config = parsed.data
    this.lastGoodConfig = JSON.stringify(this.config)
    this.providers = new ProviderRegistry(this.config.providers)
    this.permission = new PermissionManager(this.config.permission)
    saveConfig(this.config)
    this.emit({ type: 'config_updated', config: this.config })
  }

  // config_set 的点号路径约定：
  //   'defaultProvider' | 'defaultModel' | 'maxIterations' | 'maxRetries' | 'systemPrompt'
  //   'permission.allow' | 'permission.reject' | 'permission.ask'
  //   'providers.<name>.<field>'，field ∈ { name, baseURL, apiKey }
  //   'providers.<name>.models.<modelName>.<field>'，field ∈ { name, contextWindow, maxOutput, reasoning }
  private applyConfigSet(path: string, value: unknown): void {
    const seg = path.split('.')
    if (seg.length === 1) {
      if (path === 'defaultProvider') this.config.defaultProvider = value as string
      else if (path === 'defaultModel') this.config.defaultModel = value as string
      else if (path === 'maxIterations') this.config.maxIterations = value as number
      else if (path === 'maxRetries') this.config.maxRetries = value as number
      else if (path === 'systemPrompt') this.config.systemPrompt = value as string
      else return
    } else if (seg.length === 2 && seg[0] === 'permission') {
      const bucket = seg[1] as 'allow' | 'reject' | 'ask'
      if (bucket === 'allow' || bucket === 'reject' || bucket === 'ask') this.config.permission[bucket] = value as string[]
      else return
    } else if (seg.length === 3 && seg[0] === 'providers') {
      const p = this.config.providers.find((x) => x.name === seg[1])
      if (!p) return
      const field = seg[2]
      if (field === 'name') p.name = value as string
      else if (field === 'baseURL') p.baseURL = value as string
      else if (field === 'apiKey') p.apiKey = value as string
      else return
    } else if (seg.length === 5 && seg[0] === 'providers' && seg[2] === 'models') {
      const m = this.config.providers.find((x) => x.name === seg[1])?.models.find((x) => x.name === seg[3])
      if (!m) return
      const field = seg[4]
      if (field === 'name') m.name = value as string
      else if (field === 'contextWindow') m.contextWindow = value as number
      else if (field === 'maxOutput') m.maxOutput = value as number
      else if (field === 'reasoning') m.reasoning = value as boolean
      else return
    } else {
      return
    }
    this.afterConfigEdit()
  }

  // config_add：'providers' 追加 provider；'providers.<name>.models' 追加 model。
  private applyConfigAdd(path: string, value: unknown): void {
    if (path === 'providers') {
      this.config.providers.push(value as ProviderConfig)
    } else if (path.startsWith('providers.') && path.endsWith('.models')) {
      const name = path.split('.')[1]!
      this.providers.get(name)?.models.push(value as ModelConfig)
    } else {
      return
    }
    this.afterConfigEdit()
  }

  // config_remove：'providers' 按 name 删 provider；'providers.<name>.models' 按 name 删 model。
  private applyConfigRemove(path: string, key: string, match: string): void {
    if (path === 'providers') {
      this.config.providers = this.config.providers.filter((p) => p.name !== match)
    } else if (path.startsWith('providers.') && path.endsWith('.models')) {
      const name = path.split('.')[1]!
      const p = this.providers.get(name)
      if (p) p.models = p.models.filter((m) => (m as unknown as Record<string, unknown>)[key] !== match)
    } else {
      return
    }
    this.afterConfigEdit()
  }
}