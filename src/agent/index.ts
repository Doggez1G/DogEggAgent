import type { UiToAgentMessage } from '../events/ui-to-agent'
import type { AgentToUiMessage } from '../events/agent-to-ui'
import type { Message, PermissionDecision, State } from '../events/types'
import { getAllTools } from '../tools/registry'
import { ProviderRegistry, openAiAdapter } from '../llm/provider/openai'
import { PermissionManager } from './permission'
import { loadSystemPrompt, estimateContextTokens, splitForCompaction } from './context'
import { saveSession, loadSession, listSessions } from './session'
import { runLoop, summarizeHistory } from './loop'
import { transition } from './state'
import { configSchema, isConfigured, type Config, type ProviderConfig, type ModelConfig } from '../config/schema'
import { saveConfig } from '../config/loader'
import { newId } from '../common/utils/id'
import { log, readLogTail, sessionLogPath } from '../common/utils/logger'
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
    if (m.type === 'state') {
      this.state = m.to
      log(this.sessionId, 'state', `${m.from} → ${m.to}`)
    } else if (m.type === 'message') {
      log(this.sessionId, 'message', m.role)
    } else if (m.type === 'tool_start') {
      log(this.sessionId, 'tool', `${m.name} ${JSON.stringify(m.input)}`)
    } else if (m.type === 'tool_end') {
      log(this.sessionId, 'tool', `${m.name} ${m.error ? '✕ ' + m.error : '✓'}`)
    } else if (m.type === 'permission_request') {
      log(this.sessionId, 'permission', `ask ${m.tool}`)
    } else if (m.type === 'error') {
      log(this.sessionId, 'error', m.error.message)
    } else if (m.type === 'compaction') {
      log(this.sessionId, 'compact', `${m.before_tokens} → ${m.after_tokens}`)
    } else if (m.type === 'finished') {
      log(this.sessionId, 'state', 'finished')
    }
    this.listeners.forEach((l) => l(m))
  }

  private currentProvider() {
    return this.providers.get(this.config.defaultProvider!) ?? this.config.providers[0]!
  }

  private currentModel() {
    const p = this.currentProvider()
    return p.models.find((m) => m.name === this.config.defaultModel) ?? p.models[0]!
  }

  private estimateCurrentTokens(): number {
    return estimateContextTokens(loadSystemPrompt(this.config.systemPrompt), this.history, getAllTools().map((t) => t.parameters))
  }

  // 手工触发压缩（/compact）：复用与自动压缩相同的总结逻辑，压最旧历史为摘要 + 保留最近 4 条。
  private async compactNow(): Promise<void> {
    const provider = this.currentProvider()
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
        const provider = this.currentProvider()
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
            history: this.history,
            systemPrompt: loadSystemPrompt(this.config.systemPrompt),
            windowTokens: model.contextWindow,
            maxIterations: this.config.maxIterations,
            permission: this.permission,
            cwd: this.cwd,
            shellProgram: this.config.shellProgram,
            signal: this.controller.signal,
            emit: (e) => this.emit(e),
            requestPermission: (tool, input) => this.requestPermission(tool, input),
            checkCancelled: () => this.cancelled,
          })
        } catch (e) {
          // loop 已在抛出前经 transition 进入 cancelled/error；这里补非取消错误的提示，并按设计复位回 idle。
          if (!(e instanceof CancelledError)) this.emit({ type: 'error', error: e as Error })
          this.emit({ type: 'state', from: this.state, to: transition(this.state, { kind: 'reset' }) })
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
          log(this.sessionId, 'permission', `decision ${cmd.decision}`)
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
        this.emit({ type: 'log_state', path: sessionLogPath(this.sessionId) ?? '~/.dogegg/logs/<session>.log', tail: readLogTail(this.sessionId) })
        break
      case 'config_set':
        this.applyConfigSet(cmd.path, cmd.value)
        break
      case 'config_add':
        this.applyConfigAdd(cmd.path, cmd.value)
        break
      case 'config_remove':
        this.applyConfigRemove(cmd.path, cmd.index, cmd.providerIndex)
        break
      case 'quit':
        process.exit(0)
    }
  }

  // 配置编辑后统一：先重校验、再判 name 唯一性，任一失败则回滚到最后一次合法快照，避免半写坏状态。
  private afterConfigEdit(): void {
    const parsed = configSchema.safeParse(this.config)
    if (!parsed.success) {
      this.config = JSON.parse(this.lastGoodConfig)
      this.emit({ type: 'error', error: new Error('配置校验失败，已回滚：' + parsed.error.issues[0]?.message) })
      return
    }
    const dup = this.findDuplicateName()
    if (dup) {
      this.config = JSON.parse(this.lastGoodConfig)
      this.emit({ type: 'error', error: new Error('名称重复，已回滚：' + dup) })
      return
    }
    this.config = parsed.data
    this.lastGoodConfig = JSON.stringify(this.config)
    this.providers = new ProviderRegistry(this.config.providers)
    this.permission = new PermissionManager(this.config.permission)
    saveConfig(this.config)
    this.emit({ type: 'config_updated', config: this.config })
  }

  // 返回重复的 provider/model 名。仅非空名判重（编辑期的新空节点允许多个共存）。
  private findDuplicateName(): string | null {
    const seen = new Set<string>()
    for (const p of this.config.providers) {
      if (p.name) {
        if (seen.has(p.name)) return `provider「${p.name}」`
        seen.add(p.name)
      }
      const models = new Set<string>()
      for (const m of p.models) {
        if (m.name) {
          if (models.has(m.name)) return `model「${m.name}」`
          models.add(m.name)
        }
      }
    }
    return null
  }

  // config_set 的点号路径约定（provider/model 用下标定位，与 config_add/remove 的 index 语义一致）：
  //   'defaultProvider' | 'defaultModel' | 'maxIterations' | 'maxRetries' | 'systemPrompt' | 'shellProgram'
  //   'permission.allow' | 'permission.reject' | 'permission.ask'
  //   'providers.<index>.<field>'，field ∈ { name, baseURL, apiKey }
  //   'providers.<index>.models.<modelIndex>.<field>'，field ∈ { name, contextWindow, maxOutput, reasoning }
  private applyConfigSet(path: string, value: unknown): void {
    const seg = path.split('.')
    if (seg.length === 1) {
      if (path === 'defaultProvider') this.config.defaultProvider = value as string
      else if (path === 'defaultModel') this.config.defaultModel = value as string
      else if (path === 'maxIterations') this.config.maxIterations = value as number
      else if (path === 'maxRetries') this.config.maxRetries = value as number
      else if (path === 'systemPrompt') this.config.systemPrompt = value as string
      else if (path === 'shellProgram') this.config.shellProgram = value as string
      else return
    } else if (seg.length === 2 && seg[0] === 'permission') {
      const bucket = seg[1] as 'allow' | 'reject' | 'ask'
      if (bucket === 'allow' || bucket === 'reject' || bucket === 'ask') this.config.permission[bucket] = value as string[]
      else return
    } else if (seg.length === 3 && seg[0] === 'providers') {
      const idx = Number(seg[1])
      if (!Number.isInteger(idx) || idx < 0) return
      const p = this.config.providers[idx]
      if (!p) return
      const field = seg[2]
      if (field === 'name') p.name = value as string
      else if (field === 'baseURL') p.baseURL = value as string
      else if (field === 'apiKey') p.apiKey = value as string
      else return
    } else if (seg.length === 5 && seg[0] === 'providers' && seg[2] === 'models') {
      const idx = Number(seg[1])
      const midx = Number(seg[3])
      if (!Number.isInteger(idx) || idx < 0 || !Number.isInteger(midx) || midx < 0) return
      const m = this.config.providers[idx]?.models[midx]
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

  // config_add：'providers' 追加 provider；'providers.<index>.models' 追加 model。
  private applyConfigAdd(path: string, value: unknown): void {
    if (path === 'providers') {
      this.config.providers.push(value as ProviderConfig)
    } else if (path.startsWith('providers.') && path.endsWith('.models')) {
      const idx = Number(path.split('.')[1])
      if (!Number.isInteger(idx) || idx < 0) return
      this.config.providers[idx]?.models.push(value as ModelConfig)
    } else {
      return
    }
    this.afterConfigEdit()
  }

  // config_remove：'providers' 按 name 删 provider；'providers.<name>.models' 按 name 删 model。
  private applyConfigRemove(path: string, index: number, providerIndex?: number): void {
    if (path === 'providers') {
      this.config.providers.splice(index, 1)
    } else if (path === 'models' && providerIndex !== undefined) {
      this.config.providers[providerIndex]?.models.splice(index, 1)
    } else {
      return
    }
    this.afterConfigEdit()
  }
}