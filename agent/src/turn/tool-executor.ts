import type { Message } from '@dogegg/bridge'
import type { PermissionResolution } from './pending'
import type { AgentToUiMessage } from '@dogegg/bridge'
import type { Tool, ToolContext } from '../tools'
import type { ToolRegistry } from '../tools'
import type { PermissionManager } from '../permission'
import type { TransitionInput } from './state'
import { truncate } from '../context'

// 单个工具的执行结果：要回填的 tool 消息 + 状态迁移输入。
// isLast 决定迁移到 tool_done（继续下一个）还是 result_back/reject（重新请求模型）。
export interface ToolStep {
  toolMessage: Message
  transitionInput: TransitionInput
}

// 工具执行器：处理单个 tool_call 的完整流程（参数解析 → 权限分支 → 执行/拒绝 → 回填 tool 消息）。
// permission 每轮注入——config 编辑会重建 PermissionManager 实例，必须用最新。
//
// ⚠️ R3：拒绝（reject 桶 / 用户 reject）、未知工具、参数校验失败——这四种也发 tool_end（带 error 标记），
// 不再像旧代码那样静默塞消息。让 UI 能渲染「🐾 tool ✕ denied」。
export class ToolExecutor {
  constructor(private readonly services: {
    registry: ToolRegistry
    permission: PermissionManager
    emit: (e: AgentToUiMessage) => void
    requestPermission: (tool: string, input: unknown) => Promise<PermissionResolution>
  }) {}

  // trans：状态迁移回调（由 loop 接到自己的状态机上）。
  // reasoning 决定 reject/result_back 后回到 thinking（推理模型）还是 responding（普通模型）。
  // isLast 决定是 tool_done（还有后续工具）还是 result_back/reject（本轮最后一个，重新请求模型）。
  async execute(
    call: { id: string; function: { name: string; arguments: string } },
    ctx: ToolContext,
    opts: { isLast: boolean; reasoning: boolean },
    trans: (input: TransitionInput) => void,
  ): Promise<ToolStep> {
    const rejectOrDone = (): TransitionInput => (opts.isLast ? { kind: 'reject', reasoning: opts.reasoning } : { kind: 'tool_done' })
    const backOrDone = (): TransitionInput => (opts.isLast ? { kind: 'result_back', reasoning: opts.reasoning } : { kind: 'tool_done' })

    // 未知工具：发 tool_end 带错误，回填消息，迁移到 reject/tool_done。
    const tool: Tool | undefined = this.services.registry.get(call.function.name)
    if (!tool) {
      const content = `未知工具 ${call.function.name}`
      this.services.emit({ type: 'tool_end', id: call.id, name: call.function.name, output: content, error: content })
      return { toolMessage: { role: 'tool', tool_call_id: call.id, content }, transitionInput: rejectOrDone() }
    }

    // 参数解析校验：LLM 给的 arguments 是 JSON 字符串，先解析再用 zod schema 校验。
    let args: unknown
    try {
      args = tool.schema.parse(JSON.parse(call.function.arguments || '{}'))
    } catch {
      const content = '参数校验失败'
      this.services.emit({ type: 'tool_end', id: call.id, name: tool.name, output: content, error: content })
      return { toolMessage: { role: 'tool', tool_call_id: call.id, content }, transitionInput: rejectOrDone() }
    }

    // 权限判定：args（zod 解析后）与 cwd 一并交给 manager——参数化规则需要参数值，
    // cwd 用于把路径类规则/参数归一到同一坐标系（见 PermissionManager.classify）。
    const verdict = this.services.permission.classify(tool.name, args as Record<string, unknown>, ctx.cwd)

    // 拒绝/失败的回填消息——明确告诉模型发生了什么，避免模型盲目重试同一工具。
    // 用户拒绝时尤其要说明「不要再次调用此工具」，否则模型可能在下一轮重新请求权限，造成循环。
    const deniedMessage = '用户拒绝了此工具调用，请勿再次尝试同一工具，改用其它方式或询问用户。'

    // reject 桶：配置层直接拒绝，发 tool_end。
    if (verdict === 'reject') {
      this.services.emit({ type: 'tool_end', id: call.id, name: tool.name, output: 'denied', error: 'denied' })
      return { toolMessage: { role: 'tool', tool_call_id: call.id, content: deniedMessage }, transitionInput: rejectOrDone() }
    }

    // ask 桶：需用户审批，挂起等待决议。用户 reject 同样发 tool_end。
    if (verdict === 'ask') {
      trans({ kind: 'tool_needs_permission' })
      const { decision, scopePattern } = await this.services.requestPermission(tool.name, args)
      // 提升落库：allow_always = 整工具；allow_always_scoped 用挂起项带回的范围模式（path 落库时解析为绝对）。
      this.services.permission.apply(tool.name, decision, scopePattern, ctx.cwd)
      if (decision === 'reject') {
        this.services.emit({ type: 'tool_end', id: call.id, name: tool.name, output: 'denied', error: 'denied' })
        return { toolMessage: { role: 'tool', tool_call_id: call.id, content: deniedMessage }, transitionInput: rejectOrDone() }
      }
      // allow_once / allow_always：执行工具
      trans({ kind: 'allow' })
      const message = await this.runAndEmit(call, tool, args, ctx)
      return { toolMessage: message, transitionInput: backOrDone() }
    }

    // allow 桶：自动执行
    trans({ kind: 'tool_auto' })
    const message = await this.runAndEmit(call, tool, args, ctx)
    return { toolMessage: message, transitionInput: backOrDone() }
  }

  // 实际执行工具并产出 tool 消息（ask 放行后与 auto 分支共用此逻辑——消除旧代码两分支的逐行重复）。
  // emit tool_start → execute → truncate → emit tool_end（带 error 标记）→ 返回 tool 消息。
  // 工具 execute 可能抛异常（非返回 {error}），用 try/catch 兜底——保证 tool_start 总有配对的 tool_end。
  private async runAndEmit(
    call: { id: string; function: { name: string } },
    tool: Tool,
    args: unknown,
    ctx: ToolContext,
  ): Promise<Message> {
    this.services.emit({ type: 'tool_start', id: call.id, name: tool.name, input: args })
    let result
    try {
      result = await tool.execute(args, ctx)
    } catch (e) {
      const errMsg = String(e)
      this.services.emit({ type: 'tool_end', id: call.id, name: tool.name, output: errMsg, error: errMsg })
      return { role: 'tool', tool_call_id: call.id, content: errMsg }
    }
    const content = 'content' in result ? truncate(result.content) : `ERROR: ${result.error}`
    this.services.emit({ type: 'tool_end', id: call.id, name: tool.name, output: content, error: 'error' in result ? result.error : undefined })
    return { role: 'tool', tool_call_id: call.id, content }
  }
}
