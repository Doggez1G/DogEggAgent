import type { AgentToUiMessage, Config, State } from '@dogegg/bridge'
import { isConfigured } from '@dogegg/bridge'
import { newId } from '../shared'
import type { TransitionInput } from './state'
import type { BusyGate } from './busy-gate'
import type { Conversation } from './conversation'
import type { AgentLoop } from '../loop'
import type { Compactor, ContextAssembler } from '../context'
import type { ToolRegistry } from '../tools'
import type { SessionStore } from '../session'
import type { PermissionManager } from '../permission'
import type { LlmClient } from '../llm'

// 单轮参数：从当前 config 解析的 provider 连接与模型参数（由 Agent 组装，测试 client 覆盖在此生效）。
export interface TurnParams {
  client: LlmClient
  model: string
  maxOutput: number
  maxRetries: number
  reasoning: boolean
  windowTokens: number
}

// 轮次执行器：submit / cancel / compact 三命令的实现归属。
// R2 阻塞语义与并发控制都在 BusyGate；数据变更都落在 Conversation；压缩走 Compactor。
export class TurnRunner {
  constructor(private readonly deps: {
    conversation: Conversation
    gate: BusyGate
    loop: AgentLoop
    compactor: Compactor
    sessions: SessionStore
    registry: ToolRegistry
    emit: (m: AgentToUiMessage) => void
    emitState: (input: TransitionInput) => void
    state: () => State
    config: () => Config
    permission: () => PermissionManager
    assembler: () => ContextAssembler
    turnParams: () => TurnParams
  }) {}

  async submit(text: string): Promise<void> {
    if (this.deps.gate.busy) { this.deps.emit({ type: 'notice', text: '运行中，请稍候' }); return }
    if (!isConfigured(this.deps.config())) {
      this.deps.emit({ type: 'notice', text: '尚未配置 provider，请先 /config 添加并保存后重试' })
      return
    }
    await this.runTurn(text)
  }

  cancel(): void {
    this.deps.gate.cancel()
  }

  async compact(): Promise<void> {
    if (this.deps.gate.busy) { this.deps.emit({ type: 'notice', text: '运行中，请稍候' }); return }
    if (!isConfigured(this.deps.config())) { this.deps.emit({ type: 'notice', text: '尚未配置 provider，请先 /config' }); return }
    await this.compactNow()
  }

  // 一轮对话：push user 消息到 history+context（R1 双写）→ loop 作用于 context → 同步 newMessages 到 history → 落盘。
  private async runTurn(text: string): Promise<void> {
    const controller = this.deps.gate.enter()
    const params = this.deps.turnParams()
    this.deps.conversation.pushUserMessage(text)
    this.deps.emit({ type: 'message', role: 'user', id: newId() })
    try {
      const result = await this.deps.loop.run({
        client: params.client,
        model: params.model,
        maxOutput: params.maxOutput,
        maxRetries: params.maxRetries,
        reasoning: params.reasoning,
        systemPrompt: this.deps.assembler().systemPrompt(),
        windowTokens: params.windowTokens,
        context: this.deps.conversation.getContext(),
        permission: this.deps.permission(),
        maxIterations: this.deps.config().maxIterations,
        cwd: this.deps.conversation.getCwd(),
        shellProgram: this.deps.config().shellProgram,
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
      this.deps.gate.leave()
      this.deps.emitState({ kind: 'reset' })
      this.saveOrNotice()
    }
  }

  // 手动压缩（/compact）：复用 Compactor，只改 context、不动 history，落盘。
  // 压缩期间 emit state → compacting 让 UI 可感知，完成后回 idle。
  // 占用闸门防止压缩期间 submit 并发写入 context（R2 阻塞）。
  // 失败时 emit error 而非让外层 .catch(() => {}) 静默吞掉。
  private async compactNow(): Promise<void> {
    const controller = this.deps.gate.enter()
    const params = this.deps.turnParams()
    this.deps.emitState({ kind: 'compact_start' })
    try {
      const result = await this.deps.compactor.compact({
        context: this.deps.conversation.getContext(),
        systemPrompt: this.deps.assembler().systemPrompt(),
        tools: this.deps.registry.schemas(),
        windowTokens: params.windowTokens,
        force: true,
        signal: controller.signal,
      })
      if (result.compacted) {
        this.deps.conversation.replaceContext(result.context)
        this.deps.sessions.save({ ...this.deps.conversation.snapshot(), allowedTools: this.deps.permission().listAllowed() })
        this.deps.emit({ type: 'compaction', before_tokens: result.before, after_tokens: result.after, source: 'manual' })
      } else {
        // context 为空——没有消息可压。
        this.deps.emit({ type: 'notice', text: '上下文为空，无需压缩' })
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
      this.deps.gate.leave()
      // 如果还在 compacting（成功路径），用 compact_done 回 idle；
      // 如果已 cancelled/error，用 reset 回 idle（compact_done 的 VALID_FROM 不含 cancelled/error）。
      this.deps.emitState(this.deps.state() === 'compacting' ? { kind: 'compact_done', next: 'idle' } : { kind: 'reset' })
    }
  }

  // 落盘（轮次结束）：失败发 notice 提醒用户，不静默。
  private saveOrNotice(): void {
    try {
      this.deps.sessions.save({ ...this.deps.conversation.snapshot(), allowedTools: this.deps.permission().listAllowed() })
    } catch {
      this.deps.emit({ type: 'notice', text: '会话保存失败（磁盘空间不足或权限问题）' })
    }
  }
}
