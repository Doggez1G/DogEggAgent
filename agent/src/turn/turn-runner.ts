import type { AgentToUiMessage, Message } from '@dogegg/bridge'
import { newId } from '../shared'
import type { TransitionInput } from './state'
import type { Conversation } from '../session'
import type { AgentLoop } from './loop'
import type { Compactor } from './compactor'
import { generateTitle } from './title'
import { patchUnpairedToolCalls, INTERRUPTED_TOOL_CONTENT } from '@dogegg/bridge'
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
    /** 检查点最小间隔（毫秒）——测试接缝，缺省 15s（见 runTurn 的 onProgress 检查点节流）。 */
    checkpointMs?: number
  }) {}

  // 轮次进行中的实时快照（loop 内部副本的只读引用；每条 assistant/工具 step 后经 onProgress 更新）。
  // 供门面的 token 估算与 Context 卡分段在运行中读到实时值（否则长任务期间停留在轮前旧值——
  // 总量与明细必须同源，只换总量会让 breakdown 明细静默过期）。context/usage/compactions 三者
  // 同帧更新。轮次结束（含失败/取消）在 finally 清空——空闲期一律回落 conversation 的轮末值。
  // partial/runningTool（P2-23）：onProgress 时刻的运行现场；重发时刻的最新值由 getLiveTurn
  // 向 loop 实时直读覆盖（onProgress 不发生在长工具执行中 / 流式生成中）。
  private liveTurn: {
    context: Message[]
    usage: { promptTokens: number; completionTokens: number }
    compactions: number
    partial?: string
    runningTool?: { id: string; name: string; input: unknown }
  } | null = null

  getLiveContext(): Message[] | null {
    return this.liveTurn?.context ?? null
  }

  getLiveTurn(): {
    context: Message[]
    usage: { promptTokens: number; completionTokens: number }
    compactions: number
    partial?: string
    runningTool?: { id: string; name: string; input: unknown }
  } | null {
    if (!this.liveTurn) return null
    // P2-23：partial/runningTool 以 loop 的【实时】现场为准——onProgress 只在 assistant 定稿与
    // 工具 step 完成时触发，长工具执行中 / 第 N 次流式生成中不刷新；busy 期快照重发发生在任意
    // 时刻，必须直读 loop 才能拿到进行中的工具块与已累积的 partial。loop 已收口（getLive() 为
    // null，loop.run 返回到 runTurn finally 之间的窄缝）时回落 onProgress 存下的最后一帧。
    // partial 为空串 / runningTool 缺省时同样缺省对应字段——由 agent 侧决定整个 live 是否携带。
    const live = this.deps.loop.getLive()
    if (!live) return this.liveTurn
    return {
      ...this.liveTurn,
      ...(live.partial ? { partial: live.partial } : {}),
      ...(live.runningTool ? { runningTool: live.runningTool } : {}),
    }
  }

  async submit(text: string, params: TurnParams): Promise<void> {
    if (this.deps.ctx.gate.busy) { this.deps.emit({ type: 'notice', text: '运行中，请稍候' }); return }
    await this.runTurn(text, params)
    // 首轮成功结束后台生成标题（fire-and-forget：不阻塞下一轮提交，失败静默——标题是装饰）。
    this.maybeAutoTitle(params)
  }

  // 自动标题：仅在会话尚无标题、已有用户+助手消息、且 gate 空闲时生成一次（轮中触发见 opts）。
  // C（per-id 并发）：互斥从布尔改为会话 id——会话 A 标题生成中切到 B 时，B 首轮的标题机会
  // 不再被吞（布尔互斥会一刀切跳过）；同会话生成中重复触发靠 id 相等去重。
  // 写回前再查一次标题——生成期间 /rename 手动命名可能已落（竞态窗口），手动命名优先，自动结果直接丢弃。
  private titleGeneratingId: string | null = null
  private maybeAutoTitle(params: TurnParams, opts?: { pendingNewMessages?: Message[] }): void {
    const sessionId = this.deps.conversation.getId()
    if (this.titleGeneratingId === sessionId) return // 同会话已在生成（in-flight 去重）
    if (this.deps.conversation.getTitle()) return
    // gate 空闲检查只约束轮末触发的常规路径；轮中触发（opts 在案）发生在 gate 占用期内，
    // 标题生成是与主轮次并行的独立离线 LLM 调用（不进 loop、不发 stream 事件），互不冲突。
    if (!opts && this.deps.ctx.gate.busy) return
    // 轮中触发时本轮新消息尚未同步进 history（applyTurnResult 在轮末）——合并成虚拟历史参与判定。
    const history = [...this.deps.conversation.getHistory(), ...(opts?.pendingNewMessages ?? [])]
    const user = history.find((m) => m.role === 'user')
    const assistant = history.find((m) => m.role === 'assistant')
    if (!user || !assistant || typeof user.content !== 'string') return
    this.titleGeneratingId = sessionId
    // 生成前捕获会话 id：LLM 返回后写回前比对——生成期间 /new 或 resume 过（id 已变）直接丢弃，
    // 否则旧会话的标题会写进新会话（跨会话竞态；标题存在性守卫拦不住它——新会话标题恰为空）。
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
        // P2-1（立法）：busy 期间只写内存、不落盘——snapshotFull 是「轮前工作集」，轮内消息还在
        // loop 手里（applyTurnResult 在轮末才同步进 history）；此刻落盘会把检查点刚写的轮内进度
        // 回退成旧态（丢轮内 tool/assistant 消息）。标题不会因此丢失：检查点快照与轮末 saveOrNotice
        // 组装时都读 conversation.getTitle()，轮中设置、轮末一并持久化。
        if (!this.deps.ctx.gate.busy) {
          try {
            this.deps.sessions.save(
              this.deps.conversation.snapshotFull(
                this.deps.ctx.permission.snapshotPermissions(),
                this.deps.conversation.getUsage(),
                this.deps.conversation.getCompactions(),
              ),
            )
          } catch { /* 标题落盘失败静默 */ }
        }
        this.deps.emit({ type: 'notice', text: `已自动生成会话标题「${title}」（/rename 可重命名）` })
        this.deps.emit({ type: 'session_list', sessions: this.deps.sessions.list() })
      } finally {
        // 只清理仍指向本会话的互斥 id——生成期间已切到别的会话并开始新一轮标题生成时，不能误清新会话的在途标记。
        if (this.titleGeneratingId === sessionId) this.titleGeneratingId = null
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
    // 【P2-2 finally 覆盖立法】gate.enter() 是「清理义务成立」的标记：enter 成功后 try 必须立即
    // 开始并覆盖其后全部段（pushUserMessage / emit(user) / loop.run）。旧实现这三段裸奔在 try
    // 之外——emit 链路一抛（如 port 落盘 appendFileSync 磁盘满），finally 不执行 → gate 永久
    // busy，进程锁死（后续 submit 全被 R2 拒绝）。enter 本身不放进 try：它是 leave 资格的判定点
    // （enter 未完成就不存在「要归还的占用」）；纯字段赋值不会抛，两处边界行为等价，取语义更严的一种。
    // 早失败下 finally 的清理语义依然正确：leave 归还刚 enter 的占用；liveTurn 本为 null；
    // reset 对 idle 是同态 no-op（VALID_FROM 含 idle，迁移表原地不动不发射）；saveOrNotice 落盘
    // 当前工作集（早失败时与轮前一致，无副作用放大）。
    const controller = this.deps.ctx.gate.enter()
    try {
      this.deps.conversation.pushUserMessage(text)
      // text 随行供 reducer 去重插入（invoke_skill 无本地乐观插入，多标签也靠它看见彼此的消息）。
      this.deps.emit({ type: 'message', role: 'user', id: newId(), text })
      // 检查点节流：距上次落盘超过 checkpointMs（缺省 15s）且本轮有新消息才写——
      // 每条消息都写盘会让高频工具轮把磁盘打成热点；15s 的粒度把崩溃损失上限压到 15s 进度。
      const checkpointMs = this.deps.checkpointMs ?? 15000
      let lastCheckpointAt = Date.now()
      // 轮中标题触发的一次性守卫：本会话（轮前）历史里没有 assistant 时，本轮出现的首条 assistant
      // 即触发（长任务首轮就命名，不等轮末）；后续 onProgress 靠 titleGeneratingId 去重。
      const historyHadAssistant = this.deps.conversation.getHistory().some((m) => m.role === 'assistant')
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
        onProgress: (snap) => {
          // (a) 实时上下文：供门面估算与轮中状态推送读到最新值（接收方只读，引用不拷贝）。
          // partial/runningTool 随行存档（P2-23）；重发时刻的最新现场由 getLiveTurn 向 loop 直读覆盖。
          this.liveTurn = {
            context: snap.context,
            usage: snap.usage,
            compactions: snap.compactions,
            partial: snap.partial,
            runningTool: snap.runningTool,
          }
          // (b) 检查点节流落盘：尽力而为，失败静默（崩溃保护是增量优化，不能反过来干扰轮次）。
          const now = Date.now()
          if (snap.newMessages.length > 0 && now - lastCheckpointAt >= checkpointMs) {
            lastCheckpointAt = now
            this.writeCheckpoint(snap)
          }
          // (c) 标题中途触发：本会话首条 assistant 已在轮内出现、无标题且未在生成 → 立即命名，
          // 不等轮末（长任务可能跑几十分钟，轮末触发意味着整个任务期间会话都是「未命名」）。
          if (!historyHadAssistant && snap.newMessages.some((m) => m.role === 'assistant')) {
            this.maybeAutoTitle(params, { pendingNewMessages: snap.newMessages })
          }
        },
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
      this.liveTurn = null
      this.deps.emitState({ kind: 'reset' })
      this.saveOrNotice()
    }
  }

  // 轮中检查点：把 loop 实时进度拼成快照落盘（不改内存；轮末 saveOrNotice 会覆盖同一文件）。
  // 检查点是尽力而为——保存失败静默（磁盘故障在轮末 saveOrNotice 会再暴露一次）。
  private writeCheckpoint(snap: {
    context: Message[]
    newMessages: Message[]
    thinking: { text: string }[]
    usage: { promptTokens: number; completionTokens: number }
  }): void {
    try {
      const snapshot = this.deps.conversation.checkpoint(
        snap,
        this.deps.ctx.permission.snapshotPermissions(),
        this.deps.conversation.getCompactions(),
      )
      // 【P1-6 检查点配对毒化修补】onProgress 在 assistant push 后立即触发——检查点快照可能以
      // 「带 tool_calls 且无 tool 结果」的 assistant 结尾（多工具批量调用时甚至可能部分配对）。
      // 直接落盘的话，崩溃恢复后下一轮请求把该 context 发给严格实现的 API 会被 400 拒绝
      //（OpenAI 协议要求每个 tool_call 必须有配对的 tool 消息）。落盘前对 history 与 context
      // 应用纯函数修补（patchUnpairedToolCalls 返回副本、不改入参）——尤其 context 是 loop 的
      // 实时工作数组引用，绝不原地追加污染内存真相；轮末 saveOrNotice 以未修补的内存真相
      // 覆盖本文件，补齐消息只在落盘视图存在。文案用「会话被中断」归因（非用户取消）。
      this.deps.sessions.save({
        ...snapshot,
        history: patchUnpairedToolCalls(snapshot.history, INTERRUPTED_TOOL_CONTENT),
        context: patchUnpairedToolCalls(snapshot.context, INTERRUPTED_TOOL_CONTENT),
      })
    } catch { /* 检查点失败静默（尽力而为） */ }
  }

  // 手动压缩（/compact）：复用 Compactor，只改 context、不动 history，落盘。
  // 压缩期间 emit state → compacting 让 UI 可感知，完成后回 idle。
  // 占用闸门防止压缩期间 submit 并发写入 context（R2 阻塞）。
  // 失败时 emit error 而非让外层 .catch(() => {}) 静默吞掉。
  private async compactNow(params: TurnParams): Promise<void> {
    // 【P2-2 finally 覆盖立法】与 runTurn 同口径：enter 之后的 emitState(compact_start) 纳入 try
    // 覆盖——emit 链路一抛旧实现 gate 永久 busy。早失败时 machine 停在 idle，finally 的兜底
    // 迁移 reset 对 idle 是同态 no-op（VALID_FROM 含 idle），清理语义不受影响。
    const controller = this.deps.ctx.gate.enter()
    try {
      this.deps.emitState({ kind: 'compact_start' })
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
