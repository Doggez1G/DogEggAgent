import type { AgentPort } from '@dogegg/bridge'
import type { UiToAgentMessage } from '@dogegg/bridge'
import type { AgentToUiMessage } from '@dogegg/bridge'
import type { Message, State, Config } from '@dogegg/bridge'
import { isConfigured } from '@dogegg/bridge'
import { transition } from './state'
import { PendingPermissions } from './pending'
import { ConfigEditor } from '../config/editor'
import { resolveCurrent } from '../config/resolve'
import { saveConfig } from '../config/loader'
import { loadSystemPrompt, estimateContextTokens, compactContext, summarizeHistory } from '../context'
import { getAllTools, toolSchemas } from '../tools'
import { adapterFor } from '../llm/adapter-for'
import { runLoop } from '../loop/run'
import { saveSession, loadSession, listSessions } from '../session'
import { PermissionManager } from '../permission'
import { newId } from '../shared/id'
import { log, readLogTail, sessionLogPath } from '../shared/logger'
import { CancelledError } from '../shared/errors'

// Agent 是后端对外的唯一入口：持有 history（完整原文）与 context（发给模型，可压缩），
// 通过 AgentPort 收发消息，不依赖 ui。
//
// 构造后自订阅 port 消息——外部不再调 send()，一切通过 port.post(UiToAgentMessage) 驱动。
// emit() 内部走 port.post()（加日志埋点），agent 只有消息这一个进出通道。
export class Agent {
  private history: Message[] = []
  private context: Message[] = []
  private sessionId = newId()
  private pending = new PendingPermissions()
  private cancelled = false
  private running = false
  private state: State = 'idle'
  private controller: AbortController | null = null
  private editor: ConfigEditor
  private permission: PermissionManager

  constructor(
    private port: AgentPort,
    private config: Config,
    private cwd: string,
  ) {
    this.editor = new ConfigEditor(config)
    this.permission = new PermissionManager(config.permission)
    // 自订阅：UI 发来的消息都经 port 路由到 send。
    this.port.onMessage((msg) => { this.send(msg).catch(() => {}) })
  }

  // emit = port.post + 日志埋点。日志按消息类型分 scope，便于 /log 面板按类型过滤。
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
    return estimateContextTokens(loadSystemPrompt(this.config.systemPrompt), this.context, toolSchemas())
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
  private summarize = (old: Message[]): Promise<string> => {
    const cur = this.current()
    return summarizeHistory(
      { adapter: adapterFor('openai'), providerBaseURL: cur.baseURL, apiKey: cur.apiKey, model: cur.model },
      old,
    )
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
        this.history = []
        this.context = []
        this.sessionId = newId()
        this.emit({ type: 'session_ready', id: this.sessionId, messages: this.history })
        break
      }
      case 'resume_session': {
        if (this.running) { this.emit({ type: 'notice', text: '运行中，请稍候' }); return }
        const s = loadSession(cmd.id)
        this.history = s.history // 完整原文（压缩前）
        this.context = s.context // 发给模型的（可能压缩过）
        this.sessionId = s.id
        this.emit({ type: 'session_ready', id: s.id, messages: this.history })
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
        log(this.sessionId, 'permission', `decision ${cmd.decision}`)
        this.pending.resolve(cmd.id, cmd.decision)
        break
      }

      // ── 纯查询（任意时刻放行）──
      case 'list_sessions':
        this.emit({ type: 'session_list', sessions: listSessions() })
        break
      case 'config_request':
        this.emit({ type: 'config_state', config: this.editor.getConfig() })
        break
      case 'tools_request':
        this.emit({ type: 'tools_list', tools: getAllTools().map((t) => ({ name: t.name, description: t.description })) })
        break
      case 'context_request': {
        if (!isConfigured(this.config)) { this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config' }); break }
        const cur = this.current()
        const tokens = this.estimateCurrentTokens()
        this.emit({ type: 'context_state', estimatedTokens: tokens, windowTokens: cur.contextWindow, percent: cur.contextWindow ? Math.round((tokens / cur.contextWindow) * 100) : 0 })
        break
      }
      case 'status_request': {
        if (!isConfigured(this.config)) { this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config' }); break }
        const cur = this.current()
        this.emit({ type: 'status_state', sessionId: this.sessionId, provider: this.config.defaultProvider!, model: this.config.defaultModel!, cwd: this.cwd, state: this.state, estimatedTokens: this.estimateCurrentTokens(), windowTokens: cur.contextWindow })
        break
      }
      case 'system_request':
        this.emit({ type: 'system_state', path: this.config.systemPrompt ?? '内置', content: loadSystemPrompt(this.config.systemPrompt) })
        break
      case 'log_request':
        this.emit({ type: 'log_state', path: sessionLogPath(this.sessionId) ?? '~/.dogegg/logs/<session>.log', tail: readLogTail(this.sessionId) })
        break

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
    try {
      const result = await runLoop({
        adapter: adapterFor('openai'),
        providerBaseURL: cur.baseURL,
        apiKey: cur.apiKey,
        model: cur.model,
        maxOutput: cur.maxOutput,
        maxRetries: this.config.maxRetries,
        reasoning: cur.reasoning,
        tools: getAllTools(),
        context: this.context,
        systemPrompt: loadSystemPrompt(this.config.systemPrompt),
        windowTokens: cur.contextWindow,
        maxIterations: this.config.maxIterations,
        permission: this.permission,
        cwd: this.cwd,
        shellProgram: this.config.shellProgram,
        signal: this.controller.signal,
        emit: (e) => this.emit(e),
        requestPermission: (tool, input) => this.requestPermission(tool, input),
        checkCancelled: () => this.cancelled,
        summarize: this.summarize,
      })
      // R1：loop 返回更新后的 context + 本轮新增消息。context 已被 loop 修改（含压缩）；
      // newMessages 是本轮产生的 assistant/tool，同步 append 到 history（history 不受压缩影响）。
      this.context = result.context
      this.history.push(...result.newMessages)
    } catch (e) {
      if (!(e instanceof CancelledError)) this.emit({ type: 'error', error: { message: (e as Error).message, name: (e as Error).name } })
      this.emit({ type: 'state', from: this.state, to: transition(this.state, { kind: 'reset' }) })
    } finally {
      this.running = false
      saveSession(this.sessionId, this.history, this.context)
    }
  }

  // 手动压缩（/compact）：复用 compactContext，只改 context、不动 history，落盘。
  // 失败时 emit error 而非让外层 .catch(() => {}) 静默吞掉。
  private async compactNow(): Promise<void> {
    const cur = this.current()
    try {
      const result = await compactContext({
        context: this.context,
        systemPrompt: loadSystemPrompt(this.config.systemPrompt),
        tools: toolSchemas(),
        windowTokens: cur.contextWindow,
        summarize: this.summarize,
        force: true, // 手动 /compact 无条件压缩（跳过 80% 阈值）；阈值仅 loop 自动触发用。
      })
      if (result.compacted) {
        this.context = result.context
        saveSession(this.sessionId, this.history, this.context)
        this.emit({ type: 'compaction', before_tokens: result.before, after_tokens: result.after })
      } else {
        // 无旧历史可压（消息太少）——给明确反馈而非显示 before==after 的空压缩。
        this.emit({ type: 'notice', text: '上下文消息太少，无需压缩（至少需要 5 条才有旧历史可压）' })
      }
    } catch (e) {
      this.emit({ type: 'error', error: { message: '压缩失败：' + (e as Error).message, name: (e as Error).name } })
    }
  }

  // 配置编辑统一入口：委托 ConfigEditor，成功后同步 permission/provider 运行时 + 落盘 + emit。
  private applyConfigEdit(fn: (e: ConfigEditor) => { ok: boolean; error?: string }): void {
    const result = fn(this.editor)
    if (!result.ok) {
      this.emit({ type: 'error', error: { message: result.error ?? '配置编辑失败' } })
      return
    }
    this.config = this.editor.getConfig()
    this.permission = new PermissionManager(this.config.permission)
    saveConfig(this.config)
    this.emit({ type: 'config_updated', config: this.config })
  }
}
