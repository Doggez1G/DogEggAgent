import type { UiToAgentMessage } from '../events/ui-to-agent'
import type { AgentToUiMessage } from '../events/agent-to-ui'
import type { Message, PermissionDecision, State } from '../events/types'
import { getAllTools } from '../tools/registry'
import { ProviderRegistry, openAiAdapter } from '../llm/provider/openai'
import { PermissionManager } from './permission'
import { loadSystemPrompt } from './context'
import { saveSession, loadSession, listSessions } from './session'
import { runLoop } from './loop'
import type { Config } from '../config/schema'
import { newId } from '../common/utils/id'
import { CancelledError } from '../common/errors'

interface PendingPermission {
  resolve: (d: PermissionDecision) => void
  reject: (e: Error) => void
}

export class Agent {
  private listeners = new Set<(m: AgentToUiMessage) => void>()
  private history: Message[] = []
  private sessionId = newId()
  private pending = new Map<string, PendingPermission>()
  private cancelled = false
  private running = false
  private state: State = 'idle'
  private providers: ProviderRegistry
  private permission: PermissionManager

  constructor(private config: Config, private cwd: string) {
    this.providers = new ProviderRegistry(config.providers)
    this.permission = new PermissionManager(config.permission)
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
        this.cancelled = false
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
        this.history = []
        this.sessionId = newId()
        this.emit({ type: 'session_ready', id: this.sessionId, messages: [] })
        break
      case 'list_sessions':
        this.emit({ type: 'session_list', sessions: listSessions() })
        break
      case 'resume_session': {
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
        const m = this.currentModel()
        this.emit({ type: 'context_state', estimatedTokens: 0, windowTokens: m.contextWindow, percent: 0 })
        break
      }
      case 'status_request': {
        const m = this.currentModel()
        this.emit({ type: 'status_state', sessionId: this.sessionId, provider: this.config.defaultProvider!, model: this.config.defaultModel!, cwd: this.cwd, state: this.state, estimatedTokens: 0, windowTokens: m.contextWindow })
        break
      }
      case 'system_request':
        this.emit({ type: 'system_state', path: this.config.systemPrompt ?? '内置', content: loadSystemPrompt(this.config.systemPrompt) })
        break
      case 'clear_history':
        this.history = []
        this.emit({ type: 'history_cleared' })
        break
      case 'compact_request':
        this.emit({ type: 'compaction', before_tokens: 0, after_tokens: 0 })
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
      case 'log_request':
        this.emit({ type: 'log_state', path: '~/.dogegg/logs/latest.log', tail: '' })
        break
      case 'quit':
        process.exit(0)
    }
  }

  private afterConfigEdit(): void {
    this.providers = new ProviderRegistry(this.config.providers)
    this.permission = new PermissionManager(this.config.permission)
    this.emit({ type: 'config_updated', config: this.config })
  }

  private applyConfigSet(path: string, value: unknown): void {
    if (path === 'defaultProvider') this.config.defaultProvider = value as string
    else if (path === 'defaultModel') this.config.defaultModel = value as string
    else if (path === 'maxIterations') this.config.maxIterations = value as number
    else if (path === 'maxRetries') this.config.maxRetries = value as number
    else if (path === 'systemPrompt') this.config.systemPrompt = value as string
    else if (path === 'permission.allow') this.config.permission.allow = value as string[]
    else if (path === 'permission.reject') this.config.permission.reject = value as string[]
    else if (path === 'permission.ask') this.config.permission.ask = value as string[]
    else return
    this.afterConfigEdit()
  }

  private applyConfigAdd(path: string, value: unknown): void {
    if (path === 'providers') this.config.providers.push(value as any)
    else if (path.startsWith('providers.')) {
      const name = path.split('.')[1]!
      const p = this.providers.get(name)
      if (p) p.models.push(value as any)
    } else return
    this.afterConfigEdit()
  }

  private applyConfigRemove(path: string, key: string, match: string): void {
    if (path === 'providers') this.config.providers = this.config.providers.filter((p) => p.name !== match)
    else if (path.startsWith('providers.')) {
      const name = path.split('.')[1]!
      const p = this.providers.get(name)
      if (p) p.models = p.models.filter((m) => (m as any)[key] !== match)
    } else return
    this.afterConfigEdit()
  }
}