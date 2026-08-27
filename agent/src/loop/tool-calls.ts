import type { Message, State, PermissionDecision } from '@dogegg/bridge'
import type { AgentToUiMessage } from '@dogegg/bridge'
import type { Tool, ToolContext } from '../tools/types'
import type { PermissionManager } from '../permission'
import type { TransitionInput } from '../core/state'
import { truncate } from '../context/message'

// 单个工具的执行结果：要回填的 tool 消息 + 状态迁移输入。
// isLast 决定迁移到 tool_done（继续下一个）还是 result_back/reject（重新请求模型）。
interface ToolStep {
  toolMessage: Message
  transitionInput: TransitionInput
}

// 实际执行工具并产出 tool 消息（ask 放行后与 auto 分支共用此逻辑——消除旧代码两分支的逐行重复）。
// emit tool_start → execute → truncate → emit tool_end（带 error 标记）→ 返回 tool 消息。
async function runAndEmit(
  call: { id: string; function: { name: string } },
  tool: Tool,
  args: unknown,
  ctx: ToolContext,
  emit: (e: AgentToUiMessage) => void,
): Promise<Message> {
  emit({ type: 'tool_start', id: call.id, name: tool.name, input: args })
  const result = await tool.execute(args, ctx)
  const content = 'content' in result ? truncate(result.content) : `ERROR: ${result.error}`
  emit({ type: 'tool_end', id: call.id, name: tool.name, output: content, error: 'error' in result ? result.error : undefined })
  return { role: 'tool', tool_call_id: call.id, content }
}

// 处理单个 tool_call：参数解析 → 权限分支 → 执行/拒绝 → 回填 tool 消息 → 返回迁移输入。
//
// ⚠️ R3：拒绝（reject 桶 / 用户 reject）、未知工具、参数校验失败——这四种也发 tool_end（带 error 标记），
// 不再像旧代码那样静默塞消息。让 UI 能渲染「🐾 tool ✕ denied」。
//
// reasoning 决定 reject/result_back 后回到 thinking（推理模型）还是 responding（普通模型）。
// isLast 决定是 tool_done（还有后续工具）还是 result_back/reject（本轮最后一个，重新请求模型）。
export async function executeOneTool(
  call: { id: string; function: { name: string; arguments: string } },
  deps: {
    tools: Tool[]
    permission: PermissionManager
    cwd: string
    shellProgram: string | undefined
    signal: AbortSignal
    emit: (e: AgentToUiMessage) => void
    requestPermission: (tool: string, input: unknown) => Promise<PermissionDecision>
  },
  isLast: boolean,
  reasoning: boolean,
): Promise<ToolStep> {
  const rejectOrDone = (): TransitionInput => (isLast ? { kind: 'reject', reasoning } : { kind: 'tool_done' })
  const backOrDone = (): TransitionInput => (isLast ? { kind: 'result_back', reasoning } : { kind: 'tool_done' })
  const toolCtx: ToolContext = { cwd: deps.cwd, signal: deps.signal, shellProgram: deps.shellProgram }

  // 未知工具：发 tool_end 带错误，回填消息，迁移到 reject/tool_done。
  const tool = deps.tools.find((t) => t.name === call.function.name)
  if (!tool) {
    const content = `未知工具 ${call.function.name}`
    deps.emit({ type: 'tool_end', id: call.id, name: call.function.name, output: content, error: content })
    return { toolMessage: { role: 'tool', tool_call_id: call.id, content }, transitionInput: rejectOrDone() }
  }

  // 参数解析校验：LLM 给的 arguments 是 JSON 字符串，先解析再用 zod schema 校验。
  let args: unknown
  try {
    args = tool.schema.parse(JSON.parse(call.function.arguments || '{}'))
  } catch {
    const content = '参数校验失败'
    deps.emit({ type: 'tool_end', id: call.id, name: tool.name, output: content, error: content })
    return { toolMessage: { role: 'tool', tool_call_id: call.id, content }, transitionInput: rejectOrDone() }
  }

  const verdict = deps.permission.classify(tool.name)

  // reject 桶：配置层直接拒绝，发 tool_end。
  if (verdict === 'reject') {
    deps.emit({ type: 'tool_end', id: call.id, name: tool.name, output: 'denied', error: 'denied' })
    return { toolMessage: { role: 'tool', tool_call_id: call.id, content: 'denied' }, transitionInput: rejectOrDone() }
  }

  // ask 桶：需用户审批，挂起等待决议。用户 reject 同样发 tool_end。
  if (verdict === 'ask') {
    const decision = await deps.requestPermission(tool.name, args)
    deps.permission.apply(tool.name, decision)
    if (decision === 'reject') {
      deps.emit({ type: 'tool_end', id: call.id, name: tool.name, output: 'denied', error: 'denied' })
      return { toolMessage: { role: 'tool', tool_call_id: call.id, content: 'denied' }, transitionInput: rejectOrDone() }
    }
    // allow_once / allow_always：执行工具
    const message = await runAndEmit(call, tool, args, toolCtx, deps.emit)
    return { toolMessage: message, transitionInput: backOrDone() }
  }

  // allow 桶：自动执行
  const message = await runAndEmit(call, tool, args, toolCtx, deps.emit)
  return { toolMessage: message, transitionInput: backOrDone() }
}
