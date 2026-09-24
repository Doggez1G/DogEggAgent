import type { Message, State } from '@dogegg/bridge'
import { COMPACTION_THRESHOLD } from '@dogegg/bridge'
import type { TransitionInput } from './state'
import { estimateContextTokens } from '../context'
import { CancelledError, newId } from '../shared'
import type { LlmUsage } from '../llm'
import type { LoopServices, TurnInput, LoopResult } from './types'
import { ToolExecutor } from './tool-executor'

// 核心Agent Loop：问模型 → 有 tool_calls 就串行执行 → 结果回填 → 再问，直到无 tool_calls 或触发停止。
// 构造注入跨轮次稳定的服务（registry/emit/权限/取消/摘要），run() 收单轮参数；状态由 StateMachine 驱动。
//
// R1：loop 只操作 context（发给模型的消息），不碰 history。
// 本轮新增的 assistant/tool 消息收集到 newMessages，供 core 同步 append 到 history。
// 压缩只改 context（丢旧消息换摘要），history 不受影响。
//
// 打断（cancel）：catch CancelledError 时返回部分结果（已 push 到 context/newMessages 的消息），
// 并补全未配对的 tool_calls（补 tool: cancelled 消息），保证 context 是完整的对话状态。
export class AgentLoop {
  constructor(private readonly services: LoopServices) {}

  async run(turn: TurnInput): Promise<LoopResult> {
    const context = [...turn.context]
    const newMessages: Message[] = []
    // 本轮真实用量累计（一次提交可能多次调用模型：工具轮回）。精确值来自 API，
    // 与本地粗估并排展示可见校准误差（context_state.lastTurn）。
    const turnUsage = { promptTokens: 0, completionTokens: 0 }
    let turnCompactions = 0
    const machine = this.services.machine
    let iterations = 0
    // 每轮新建执行器：permission 是轮次参数（config 编辑重建的实例要在下一轮生效）。
    const executor = new ToolExecutor({
      registry: this.services.registry,
      permission: turn.permission,
      emit: this.services.emit,
      requestPermission: this.services.requestPermission,
    })
    // 思考内容收集——每个 assistant 回复的 reasoning，不进 history/context，单独持久化。
    const thinking: { text: string }[] = []

    // 状态迁移的唯一出口：先经 StateMachine 算下一态，变化才 emit（让 UI 据此同步）。
    const trans = (input: TransitionInput): State => {
      const prev = machine.state
      const next = machine.fire(input)
      if (next !== prev) this.services.emit({ type: 'state', from: prev, to: next })
      return next
    }

    // 补全未配对的 tool_calls：扫描 msgs 找最后一条带 tool_calls 的 assistant 消息（不要求在数组尾部），
    // 检查其每个 tool_call_id 是否有配对的 tool 结果消息。缺的补一条 tool: cancelled 消息。
    // OpenAI API 要求 assistant 的每个 tool_call 必须有配对的 tool 消息，否则报 400。
    // 多工具批量调用时，tool 1 执行完、tool 2 被取消，尾部是 tool1_result（role:tool），
    // 旧版只查尾部会漏掉——必须向后扫描找最后一条 assistant。
    const patchUnpairedToolCalls = (msgs: Message[]): void => {
      // 向后扫描找最后一条带 tool_calls 的 assistant 消息。
      let lastAssistantIdx = -1
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]!
        if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) { lastAssistantIdx = i; break }
      }
      if (lastAssistantIdx < 0) return
      const assistant = msgs[lastAssistantIdx]!
      // 收集此 assistant 之后所有已配对的 tool_call_id。
      const paired = new Set<string>()
      for (let i = lastAssistantIdx + 1; i < msgs.length; i++) {
        const m = msgs[i]!
        if (m.role === 'tool') paired.add(m.tool_call_id)
      }
      // 为每个未配对的 tool_call 补 cancelled 消息。
      const toolCalls = assistant.role === 'assistant' ? (assistant.tool_calls ?? []) : []
      for (const tc of toolCalls) {
        if (!paired.has(tc.id)) {
          const cancelledMsg: Message = { role: 'tool', tool_call_id: tc.id, content: 'cancelled（用户打断了操作）' }
          msgs.push(cancelledMsg)
          newMessages.push(cancelledMsg)
        }
      }
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
        const used = estimateContextTokens(turn.systemPrompt, context, this.services.registry.schemas())
        if (used > turn.windowTokens * COMPACTION_THRESHOLD) {
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
            this.services.emit({ type: 'compaction', before_tokens: result.before, after_tokens: result.after, source: 'auto' })
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
                this.services.emit({ type: 'text_delta', delta: e.text })
              } else if (e.type === 'thought_delta' && turn.reasoning) {
                this.services.emit({ type: 'thought_delta', delta: e.text })
              } else if (e.type === 'stream_reset') {
                // 请求层重试从零重发增量：UI 必须先清空流式 partial，否则第 2 次尝试的 delta 会追加在第 1 次残文后（展示与持久化分叉）。
                this.services.emit({ type: 'stream_reset' })
              } else if (e.type === 'tool_call_start') {
                // 模型开始生成工具调用参数——立即告知 UI（大参数的流式生成期间界面原本无任何反馈）。
                this.services.emit({ type: 'tool_pending', name: e.name })
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
        // 每轮 LLM 调用都 push 一个 thinking 条目——保持与 assistant 消息数一一对应。
        // 只在 turn.reasoning（当前模型开启了思考）时才记录实际 reasoning 内容；
        // 关闭思考时即使模型返回了 reasoning 也存空字符串——不记录、不显示。
        // 空字符串条目在 rebuildBlocksFromHistory 中被跳过（不显示思考气泡）。
        thinking.push({ text: turn.reasoning ? (result.reasoning ?? '') : '' })

        if (assistant.role !== 'assistant') throw new Error('模型未返回 assistant 消息')
        // 推理模型只返回 tool_calls 而无 text_delta 时，此处补上 thinking → responding 的收尾。
        if (state === 'thinking') state = trans({ kind: 'thought_done' })
        context.push(assistant)
        newMessages.push(assistant)
        this.services.emit({ type: 'message', role: 'assistant', id: newId() })

        const calls = assistant.tool_calls ?? []
        if (calls.length === 0) {
          trans({ kind: 'final_answer' })
          this.services.emit({ type: 'finished', usage: { ...turnUsage } })
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
        }
      }
    } catch (e) {
      // 打断或错误：补全未配对的 tool_calls，返回部分结果（含已完成的 assistant/tool 消息）。
      // 之前错误路径直接 throw 导致 newMessages 丢失——现在统一返回部分结果，agent 保存已完成的工具执行。
      patchUnpairedToolCalls(context)
      // 兜底状态迁移：try 内的检查点不覆盖所有抛出点——挂起权限被 cancel 时，CancelledError 从
      // requestPermission 的 reject（pending.rejectAll）绕过所有检查点直抛到这里；自动压缩中的 abort
      // 同理（AbortError 从 compactor 直抛）。catch 不补迁移的话状态机永久卡死在 waiting_permission /
      // compacting（reset 与 submit 的 VALID_FROM 都不含它们，下一轮 submit 也进不去）。
      // 迁移幂等：try 内已 fire 过 cancel/error 时这里是同态非法组合、原地不动，不会重复发射。
      // AbortError 归一为 cancel（与主请求路径的 catch 同口径）——用户取消不该被误报为 error。
      const cancelled = e instanceof CancelledError || (e as Error).name === 'AbortError'
      trans(cancelled ? { kind: 'cancel' } : { kind: 'error' })
      if (cancelled) {
        return { context, newMessages, thinking, usage: { ...turnUsage }, compactions: turnCompactions, cancelled: true }
      }
      return { context, newMessages, thinking, usage: { ...turnUsage }, compactions: turnCompactions, error: (e as Error).message }
    }
  }
}
