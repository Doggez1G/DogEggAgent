import type { AgentToUiMessage, Message, State } from '@dogegg/bridge'
import { COMPACTION_THRESHOLD } from '@dogegg/bridge'
import type { TransitionInput } from './state'
import { estimateContextTokens } from '../context'
import { CancelledError, newId } from '../shared'
import type { LlmUsage } from '../llm'
import type { LoopServices, TurnInput, LoopResult } from './types'
import { ToolExecutor } from './tool-executor'
import { patchUnpairedToolCalls } from '@dogegg/bridge'

// 核心Agent Loop：问模型 → 有 tool_calls 就串行执行 → 结果回填 → 再问，直到无 tool_calls 或触发停止。
// 构造注入跨轮次稳定的服务（registry/emit/权限/取消/摘要），run() 收单轮参数；状态由 StateMachine 驱动。
//
// R1：loop 只操作 context（发给模型的消息），不碰 history。
// 本轮新增的 assistant/tool 消息收集到 newMessages，供 core 同步 append 到 history。
// 压缩只改 context（丢旧消息换摘要），history 不受影响。
//
// 打断（cancel）：catch CancelledError 时返回部分结果（已 push 到 context/newMessages 的消息），
// 并补全未配对的 tool_calls（补 tool: cancelled 消息），保证 context 是完整的对话状态。
// 修补逻辑已提炼为契约级纯函数 patchUnpairedToolCalls（bridge/contract/message-pairing）——
// 检查点落盘与会话加载复用同一规则（P1-6 配对毒化防护），修补语义单点收口。
export class AgentLoop {
  constructor(private readonly services: LoopServices) {}

  // ── P2-23 运行现场跟踪（live partial / runningTool）──
  // busy 期快照重发（agent.resendSessionState）借它恢复 UI 的流式光标与进行中工具块。
  // loop 是这些事件的必经点：text_delta/thought_delta/stream_reset/tool_pending 在 chat 流回调里
  // 转发，tool_start/tool_end 经 ToolExecutor 的 emit（构造执行器时注入跟踪包装 trackEmit）。
  // 用实例字段而非 run 局部：长工具执行中 / 流式生成中 onProgress 并不触发（它只在 assistant
  // 定稿与工具 step 完成时回调），turn-runner 需在重发时刻直接读取【最新】现场。
  // 单 loop 同一时刻至多承载一轮（gate 串行化），无并发覆写。
  private liveActive = false
  private livePartial = ''
  private liveRunningTool: { id: string; name: string; input: unknown } | undefined

  // 运行中现场读取口：轮中任意时刻可调。空闲返回 null——与 TurnRunner.getLiveTurn 的 null 语义对齐
  //（空闲期 UI 从 history 重建即可，无现场可补）。
  getLive(): { partial: string; runningTool: { id: string; name: string; input: unknown } | undefined } | null {
    if (!this.liveActive) return null
    return { partial: this.livePartial, runningTool: this.liveRunningTool }
  }

  // 现场收口：轮次结束（成功/取消/错误）后不再有「流式 partial / 进行中工具」可言。
  private clearLive(): void {
    this.liveActive = false
    this.livePartial = ''
    this.liveRunningTool = undefined
  }

  async run(turn: TurnInput): Promise<LoopResult> {
    const context = [...turn.context]
    const newMessages: Message[] = []
    // 本轮真实用量累计（一次提交可能多次调用模型：工具轮回）。精确值来自 API，
    // 与本地粗估并排展示可见校准误差（context_state.lastTurn）。
    const turnUsage = { promptTokens: 0, completionTokens: 0 }
    let turnCompactions = 0
    const machine = this.services.machine
    let iterations = 0
    // 现场清零开局 + 打开跟踪开关（轮末收口见 try 出口与 catch 的 clearLive）。
    this.clearLive()
    this.liveActive = true
    // 跟踪型 emit：转发前捕获流式现场（P2-23）。run 体内所有 UI 事件统一经它出站——
    // 事件形态不变，仅多一层旁路记录（text_delta 累积 / stream_reset 归零 / tool_start 记录 / tool_end 清空）。
    const trackEmit = (e: AgentToUiMessage): void => {
      if (e.type === 'text_delta') this.livePartial += e.delta
      else if (e.type === 'stream_reset') this.livePartial = '' // 重试从零重发增量：partial 同步归零重来
      else if (e.type === 'tool_start') this.liveRunningTool = { id: e.id, name: e.name, input: e.input }
      else if (e.type === 'tool_end') this.liveRunningTool = undefined
      this.services.emit(e)
    }
    // 每轮新建执行器：permission 是轮次参数（config 编辑重建的实例要在下一轮生效）。
    // emit 注入跟踪包装——tool_start/tool_end 必经此处，runningTool 现场借此维护。
    const executor = new ToolExecutor({
      registry: this.services.registry,
      permission: turn.permission,
      emit: trackEmit,
      requestPermission: this.services.requestPermission,
    })
    // 思考内容收集——每个 assistant 回复的 reasoning，不进 history/context，单独持久化。
    const thinking: { text: string }[] = []

    // 状态迁移的唯一出口：先经 StateMachine 算下一态，变化才 emit（让 UI 据此同步）。
    const trans = (input: TransitionInput): State => {
      const prev = machine.state
      const next = machine.fire(input)
      if (next !== prev) trackEmit({ type: 'state', from: prev, to: next })
      return next
    }

    try {
      // 每次「重新请求模型」进入 thinking（推理）或 responding（普通）——首次提交亦由此进入。
      let state = trans({ kind: 'submit', reasoning: turn.reasoning })

      for (;;) {
        if (this.services.checkCancelled()) {
          trans({ kind: 'cancel' })
          throw new CancelledError()
        }
        // maxIterations = -1 表示无限轮次（默认）——只有正整数上限才参与比较。
        if (turn.maxIterations >= 0 && iterations++ >= turn.maxIterations) {
          trans({ kind: 'error' })
          throw new Error('达到 maxIterations 上限')
        }

        // 上下文窗口管理：逼近上限时压缩 context（只改 context，不动 history）。
        // 压缩 = 把整个 context 交给模型总结、替换为一条摘要消息（无保留尾巴、无淘汰、无硬丢弃——
        // 诚实失败：压缩失败异常上抛，轮次以 error 收尾，由用户决定 /compact 重试或 /new）。
        // 压缩期间 emit state → compacting 让 UI 可感知，完成后回到 thinking/responding（继续本轮请求）。
        //
        // 压缩护栏（每迭代至多一次）：非劣原则保证压缩产出收敛，但极小 windowTokens 下固定开销
        // （system prompt + 工具 schema）本身就恒超阈值——每迭代都会进压缩分支，若未来迭代体内
        // 出现第二个压缩点（如工具执行后再查一次），就会退化成同迭代多次全量压缩、成倍烧 summarize
        // 的 token。迭代内加 compactedThisIteration 标志把上界锁死在「每迭代至多压缩一次」：
        // 一次压缩加本轮新消息若仍超阈值，说明已到窗口物理下限，同迭代再压无增益（该由用户
        // /new 或调大 contextWindow），每迭代一次即可自愈上下文、又不放大固定开销。
        let compactedThisIteration = false
        const used = estimateContextTokens(turn.systemPrompt, context, this.services.registry.schemas())
        if (!compactedThisIteration && used > turn.windowTokens * COMPACTION_THRESHOLD) {
          compactedThisIteration = true
          trans({ kind: 'compact_start' })
          const result = await this.services.compactor.compact({
            context,
            systemPrompt: turn.systemPrompt,
            tools: this.services.registry.schemas(),
            windowTokens: turn.windowTokens,
            signal: turn.signal,
          })
          if (result.compacted) {
            context.length = 0
            context.push(...result.context)
            turnCompactions++
            trackEmit({ type: 'compaction', before_tokens: result.before, after_tokens: result.after, source: 'auto' })
          }
          state = trans({ kind: 'compact_done', next: turn.reasoning ? 'thinking' : 'responding' })
        }

        // 用外部传入的 signal（由 Agent 持有，cancel 时 abort），使取消能真正中断在飞的 fetch 与工具。
        let result
        try {
          result = await turn.client.chat(
            {
              model: turn.model,
              systemPrompt: turn.systemPrompt,
              messages: context,
              tools: this.services.registry.schemas(),
              maxOutput: turn.maxOutput,
              maxRetries: turn.maxRetries,
            },
            turn.signal,
            (e) => {
              if (e.type === 'text_delta') {
                // 推理模型的 reasoning 阶段结束、开始吐正文：thinking → responding。
                if (state === 'thinking') state = trans({ kind: 'thought_done' })
                trackEmit({ type: 'text_delta', delta: e.text })
              } else if (e.type === 'thought_delta' && turn.reasoning) {
                trackEmit({ type: 'thought_delta', delta: e.text })
              } else if (e.type === 'stream_reset') {
                // 请求层重试从零重发增量：UI 必须先清空流式 partial，否则第 2 次尝试的 delta 会追加在第 1 次残文后（展示与持久化分叉）。
                trackEmit({ type: 'stream_reset' })
              } else if (e.type === 'tool_call_start') {
                // 模型开始生成工具调用参数——立即告知 UI（大参数的流式生成期间界面原本无任何反馈）。
                trackEmit({ type: 'tool_pending', name: e.name })
              }
            },
          )
        } catch (e) {
          // 取消引发的 AbortError 视为取消而非错误，统一转成 CancelledError 上抛。
          if ((e as Error).name === 'AbortError') {
            trans({ kind: 'cancel' })
            throw new CancelledError()
          }
          trans({ kind: 'error' })
          throw e
        }

        if (result.usage) {
          turnUsage.promptTokens += result.usage.promptTokens
          turnUsage.completionTokens += result.usage.completionTokens
        }
        const assistant = result.message
        // 思考内容 push 放在 assistant 角色断言之后（顺序立法）：thinking 与 assistant 消息必须
        // 一一对应——若角色断言失败抛错，thinking 已多 push 一条而 history 无对应 assistant，
        // resume 后 rebuildBlocksFromHistory 按序消费会让思考块张冠李戴（对齐缺口）。
        // 只在 turn.reasoning（当前模型开启了思考）时才记录实际 reasoning 内容；
        // 关闭思考时即使模型返回了 reasoning 也存空字符串——不记录、不显示。
        // 空字符串条目在 rebuildBlocksFromHistory 中被跳过（不显示思考气泡）。
        if (assistant.role !== 'assistant') throw new Error('模型未返回 assistant 消息')
        thinking.push({ text: turn.reasoning ? (result.reasoning ?? '') : '' })
        // 推理模型只返回 tool_calls 而无 text_delta 时，此处补上 thinking → responding 的收尾。
        if (state === 'thinking') state = trans({ kind: 'thought_done' })
        context.push(assistant)
        newMessages.push(assistant)
        // assistant 消息定稿：流式现场清零——partial 已物化为 history/context 里的完整消息，
        // 下一段流式文本（若有）从零累积；live 只表达「尚未定稿的生成中内容」。
        this.livePartial = ''
        trackEmit({ type: 'message', role: 'assistant', id: newId() })
        // 轮次进度回调：assistant 消息已落位——轮中检查点/标题/实时估算的触发点（接收方只读）。
        // partial/runningTool 随行（P2-23）：此刻 partial 恒为空串、runningTool 恒缺省（工具尚未
        // 开始），真正的「进行中」现场由 turn-runner 经 getLive() 在重发时刻直读（见 getLiveTurn）。
        turn.onProgress?.({
          context,
          newMessages,
          thinking,
          usage: turnUsage,
          compactions: turnCompactions,
          partial: this.livePartial,
          runningTool: this.liveRunningTool,
        })

        const calls = assistant.tool_calls ?? []
        if (calls.length === 0) {
          trans({ kind: 'final_answer' })
          trackEmit({ type: 'finished', usage: { ...turnUsage } })
          this.clearLive()
          return { context, newMessages, thinking, usage: { ...turnUsage }, compactions: turnCompactions }
        }

        state = trans({ kind: 'tool_calls' })

        // 串行执行本次响应的工具，逐个回填 tool 消息。每个工具处理完回到 tool_calling；
        // 最后一个处理完（执行或拒绝）才进入 result_back/reject → 重新请求模型。
        for (let i = 0; i < calls.length; i++) {
          const call = calls[i]!
          const isLast = i === calls.length - 1
          if (this.services.checkCancelled()) {
            trans({ kind: 'cancel' })
            throw new CancelledError()
          }

          const step = await executor.execute(
            call,
            { cwd: turn.cwd, signal: turn.signal, shellProgram: turn.shellProgram },
            { isLast, reasoning: turn.reasoning },
            (input) => { state = trans(input) },
          )
          context.push(step.toolMessage)
          newMessages.push(step.toolMessage)
          state = trans(step.transitionInput)
          // 轮次进度回调：工具 step 已完成回填——长工具任务期间每个 step 都推进检查点进度。
          turn.onProgress?.({
            context,
            newMessages,
            thinking,
            usage: turnUsage,
            compactions: turnCompactions,
            partial: this.livePartial,
            runningTool: this.liveRunningTool,
          })
        }
      }
    } catch (e) {
      // 现场收口：轮次以取消/错误结束后无「运行中现场」可言（clearLive 复位 liveActive，
      // turn-runner 的 getLiveTurn 回落 onProgress 存下的最后一帧并停用实时覆盖）。
      this.clearLive()
      // 打断或错误：补全未配对的 tool_calls，返回部分结果（含已完成的 assistant/tool 消息）。
      // 修补已提炼为契约级纯函数（bridge/contract/message-pairing）：返回修补副本、不改入参——补齐消息在副本尾部，
      // 用长度差同步进 newMessages，保持 history 与 context 同构（R1）。
      // 之前错误路径直接 throw 导致 newMessages 丢失——现在统一返回部分结果，agent 保存已完成的工具执行。
      const patchedContext = patchUnpairedToolCalls(context)
      for (const m of patchedContext.slice(context.length)) newMessages.push(m)
      // 兜底状态迁移：try 内的检查点不覆盖所有抛出点——挂起权限被 cancel 时，CancelledError 从
      // requestPermission 的 reject（pending.rejectAll）绕过所有检查点直抛到这里；自动压缩中的 abort
      // 同理（AbortError 从 compactor 直抛）。catch 不补迁移的话状态机永久卡死在 waiting_permission /
      // compacting（reset 与 submit 的 VALID_FROM 都不含它们，下一轮 submit 也进不去）。
      // 迁移幂等：try 内已 fire 过 cancel/error 时这里是同态非法组合、原地不动，不会重复发射。
      // AbortError 归一为 cancel（与主请求路径的 catch 同口径）——用户取消不该被误报为 error。
      const cancelled = e instanceof CancelledError || (e as Error).name === 'AbortError'
      trans(cancelled ? { kind: 'cancel' } : { kind: 'error' })
      if (cancelled) {
        return { context: patchedContext, newMessages, thinking, usage: { ...turnUsage }, compactions: turnCompactions, cancelled: true }
      }
      // 【立法 P2-6】最终失败出口【不发 stream_reset】：UI reducer 的 error 分支会先 flush——
      // 把流式中的 partial 落成可见的 assistant 块再置 error（避免丢字与「流式幽灵块」）。
      // 若此处补发 stream_reset 清空 partial，flush 变 no-op，模型已生成的文本直接丢失。
      // 因模型未产出完整消息，本轮不入 history：刷新页面后 session_ready 以 history 重建，
      // partial 文本随之消失（刷新后以 history 为准）——错误场景下这是既定取舍，不是缺陷。
      return { context: patchedContext, newMessages, thinking, usage: { ...turnUsage }, compactions: turnCompactions, error: (e as Error).message }
    }
  }
}
