import type { AgentToUiMessage } from '@dogegg/bridge'
import { newId } from '../shared'
import type { TransitionInput } from './state'
import type { Conversation } from '../session'
import type { AgentLoop } from './loop'
import type { Compactor } from './compactor'
import { generateTitle } from './title'
import type { SessionStore } from '../session'
import type { ToolRegistry } from '../tools'
import type { LlmClient } from '../llm'
import type { AgentContext } from '../ctx'

// 单轮参数：从当前 config 解析的 provider 连接与模型参数。
// 由门面在「命令时刻」解析成值传入——控制器不持任何回指门面内脏的探针（所有权立法见 spec §4）。
export interface TurnParams {
  client: LlmClient
  model: string
  maxOutput: number
  maxRetries: number
  reasoning: boolean
  windowTokens: number
}

// 轮次执行器：submit / cancel / compact 三命令的实现归属。
// R2 阻塞语义与并发控制都在 ctx.gate；数据变更都落在 Conversation；压缩走 Compactor。
export class TurnRunner {
  constructor(private readonly deps: {
    ctx: AgentContext
    conversation: Conversation
    loop: AgentLoop
    compactor: Compactor
    sessions: SessionStore
    registry: ToolRegistry
    emit: (m: AgentToUiMessage) => void
    emitState: (input: TransitionInput) => void
  }) {}

  async submit(text: string, params: TurnParams): Promise<void> {
    if (this.deps.ctx.gate.busy) { this.deps.emit({ type: 'notice', text: '运行中，请稍候' }); return }
    await this.runTurn(text, params)
    // 首轮成功结束后台生成标题（fire-and-forget：不阻塞下一轮提交，失败静默——标题是装饰）。
    void this.maybeAutoTitle(params)
  }

  // 自动标题：仅在会话尚无标题、首轮已有用户+助手消息、且 gate 空闲时生成一次；
  // 生成中再次完成轮次会因 in-flight 去重跳过。写回前再查一次标题——
  // 生成期间 /rename 手动命名可能已落（竞态窗口），手动命名优先，自动结果直接丢弃。
  private titleGenerating = false
  private maybeAutoTitle(params: TurnParams): void {
    if (this.titleGenerating) return
    if (this.deps.conversation.getTitle()) return
    if (this.deps.ctx.gate.busy) return
    const history = this.deps.conversation.getHistory()
    const user = history.find((m) => m.role === 'user')
    const assistant = history.find((m) => m.role === 'assistant')
    if (!user || !assistant || typeof user.content !== 'string') return
    this.titleGenerating = true
    // 生成前捕获会话 id：LLM 返回后写回前比对——生成期间 /new 或 resume 过（id 已变）直接丢弃，
    // 否则旧会话的标题会写进新会话（跨会话竞态；标题存在性守卫拦不住它——新会话标题恰为空）。
    const sessionId = this.deps.conversation.getId()
    void (async () => {
      try {
        const title = await generateTitle(
          { client: params.client, model: params.model },
          user.content,
          String(assistant.content ?? ''),
        )
        // 写回前双守卫：会话 id 未变（跨会话竞态）+ 标题仍为空（同会话 /rename 竞态，保留不动）。
        if (!title || this.deps.conversation.getId() !== sessionId || this.deps.conversation.getTitle()) return
        this.deps.conversation.setTitle(title)
        try {
          this.deps.sessions.save(
            this.deps.conversation.snapshotFull(
              this.deps.ctx.permission.snapshotPermissions(),
              this.deps.conversation.getUsage(),
              this.deps.conversation.getCompactions(),
            ),
          )
        } catch { /* 标题落盘失败静默 */ }
        this.deps.emit({ type: 'notice', text: `已自动生成会话标题「${title}」（/rename 可重命名）` })
        this.deps.emit({ type: 'session_list', sessions: this.deps.sessions.list() })
      } finally {
        this.titleGenerating = false
      }
    })()
  }

  cancel(): void {
    this.deps.ctx.gate.cancel()
  }

  async compact(params: TurnParams): Promise<void> {
    if (this.deps.ctx.gate.busy) { this.deps.emit({ type: 'notice', text: '运行中，请稍候' }); return }
    await this.compactNow(params)
  }

  // 一轮对话：push user 消息到 history+context（R1 双写）→ loop 作用于 context → 同步 newMessages 到 history → 落盘。
  private async runTurn(text: string, params: TurnParams): Promise<void> {
    const controller = this.deps.ctx.gate.enter()
    this.deps.conversation.pushUserMessage(text)
    this.deps.emit({ type: 'message', role: 'user', id: newId() })
    try {
      const result = await this.deps.loop.run({
        client: params.client,
        model: params.model,
        maxOutput: params.maxOutput,
        maxRetries: params.maxRetries,
        reasoning: params.reasoning,
        systemPrompt: this.deps.ctx.assembler.systemPrompt(),
        windowTokens: params.windowTokens,
        context: this.deps.conversation.getContext(),
        permission: this.deps.ctx.permission,
        maxIterations: this.deps.ctx.config.maxIterations,
        cwd: this.deps.conversation.getCwd(),
        shellProgram: this.deps.ctx.config.shellProgram,
        signal: controller.signal,
      })
      // R1：loop 返回更新后的 context + 本轮新增消息 + thinking（成功/取消/错误都返回部分结果）。
      // context 已被 loop 修改（含压缩）；newMessages 同步 append 到 history。
      // thinking 累积到工作集（resume 时恢复，不进 history/context）。
      this.deps.conversation.applyTurnResult(result)
      if (result.cancelled) {
        this.deps.emit({ type: 'notice', text: '已打断当前操作' })
      } else if (result.error) {
        this.deps.emitState({ kind: 'error' })
        this.deps.emit({ type: 'error', error: { message: result.error } })
      }
    } catch (e) {
      // 兜底：loop 内部未 catch 的意外错误（理论上不应到达，loop 已 catch 全部）。
      this.deps.emitState({ kind: 'error' })
      this.deps.emit({ type: 'error', error: { message: (e as Error).message, name: (e as Error).name } })
    } finally {
      // 无论成功/失败/取消，turn 结束后状态回到 idle（成功路径 loop 停在 finished，需复位）。
      this.deps.ctx.gate.leave()
      this.deps.emitState({ kind: 'reset' })
      this.saveOrNotice()
    }
  }

  // 手动压缩（/compact）：复用 Compactor，只改 context、不动 history，落盘。
  // 压缩期间 emit state → compacting 让 UI 可感知，完成后回 idle。
  // 占用闸门防止压缩期间 submit 并发写入 context（R2 阻塞）。
  // 失败时 emit error 而非让外层 .catch(() => {}) 静默吞掉。
  private async compactNow(params: TurnParams): Promise<void> {
    const controller = this.deps.ctx.gate.enter()
    this.deps.emitState({ kind: 'compact_start' })
    try {
      const result = await this.deps.compactor.compact({
        context: this.deps.conversation.getContext(),
        systemPrompt: this.deps.ctx.assembler.systemPrompt(),
        tools: this.deps.registry.schemas(),
        windowTokens: params.windowTokens,
        force: true,
        signal: controller.signal,
      })
      if (result.compacted) {
        this.deps.conversation.replaceContext(result.context)
        this.deps.conversation.incrementCompaction() // 手动压缩的计数入口（自动压缩走 LoopResult.compactions）
        // 落盘单独 try/catch：压缩成功但保存失败是两个独立故障——保存失败应报「会话保存失败」
        //（与 saveOrNotice 口径一致），误报「压缩失败」会误导用户去重试压缩。
        try {
          this.deps.sessions.save(
            this.deps.conversation.snapshotFull(
              this.deps.ctx.permission.snapshotPermissions(),
              this.deps.conversation.getUsage(),
              this.deps.conversation.getCompactions(),
            ),
          )
        } catch {
          this.deps.emit({ type: 'notice', text: '会话保存失败（磁盘空间不足或权限问题）' })
        }
        this.deps.emit({ type: 'compaction', before_tokens: result.before, after_tokens: result.after, source: 'manual' })
      } else {
        // context 为空，或摘要不比原文短（非劣原则）——都没有压缩的意义。
        this.deps.emit({ type: 'notice', text: '当前上下文无需压缩' })
      }
    } catch (e) {
      // AbortError 是用户取消——走 cancelled 态而非 error（与 runTurn catch 一致）。
      if ((e as Error).name === 'AbortError') {
        this.deps.emitState({ kind: 'cancel' })
        this.deps.emit({ type: 'notice', text: '已打断压缩' })
      } else {
        this.deps.emitState({ kind: 'error' })
        this.deps.emit({ type: 'error', error: { message: '压缩失败：' + (e as Error).message, name: (e as Error).name } })
      }
    } finally {
      this.deps.ctx.gate.leave()
      // 如果还在 compacting（成功路径），用 compact_done 回 idle；
      // 如果已 cancelled/error，用 reset 回 idle（compact_done 的 VALID_FROM 不含 cancelled/error）。
      this.deps.emitState(this.deps.ctx.machine.state === 'compacting' ? { kind: 'compact_done', next: 'idle' } : { kind: 'reset' })
    }
  }

  // 落盘（轮次结束）：失败发 notice 提醒用户，不静默。
  private saveOrNotice(): void {
    try {
      this.deps.sessions.save(
        this.deps.conversation.snapshotFull(
          this.deps.ctx.permission.snapshotPermissions(),
          this.deps.conversation.getUsage(),
          this.deps.conversation.getCompactions(),
        ),
      )
    } catch {
      this.deps.emit({ type: 'notice', text: '会话保存失败（磁盘空间不足或权限问题）' })
    }
  }
}
