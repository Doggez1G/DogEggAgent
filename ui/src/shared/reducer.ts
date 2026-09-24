import type { AgentToUiMessage, Message, ToolCall, State } from '@dogegg/bridge'
import { type Block, type BlockKind, type ColorToken, type ToolStatus } from './block'
import { formatToolTitle, formatToolBody } from './tool-display'

// UI 的聊天状态：已落盘的块 + 当前状态 + 进行中的流式块（未落盘的 partial）。
export interface ChatState {
  blocks: Block[]
  status: State
  partial: { kind: 'assistant' | 'thinking'; text: string } | null
  // 最后一个 tool 块是否尚未收到 tool_end——未完成的块内容还会变，
  // TUI（Static 输出模式）不能把它固化打印，需留在动态区渲染。
  toolActive: boolean
  // 模型正在生成工具调用参数（tool_pending → tool_start 之间）——两端 UI 显示准备中提示。
  pendingTool?: string | null
}

// reducer 的输入：后端消息 + UI 本地动作（local_user 本地即时显示）。
export type Action = AgentToUiMessage | { type: 'local_user'; text: string }

// 把进行中的 partial 块落盘成一个完整块（思考或助手），清空 partial。
// 思考块的 text 存完整推理；折叠时显示摘要（前几行），full 存全文供展开。
function flush(state: ChatState): ChatState {
  if (!state.partial) return state
  const isThinking = state.partial.kind === 'thinking'
  const fullText = state.partial.text
  // 折叠摘要：思考取前 3 行 + …；助手不需要折叠（无 full）。
  const summary = isThinking
    ? fullText.split('\n').slice(0, 3).join('\n') + (fullText.split('\n').length > 3 ? '\n…（回车展开完整思考）' : '')
    : fullText
  const kind: BlockKind = isThinking ? 'thinking' : 'assistant'
  const color: ColorToken = isThinking ? 'yellow' : 'text'
  return {
    ...state,
    partial: null,
    blocks: [...state.blocks, {
      kind,
      color,
      text: isThinking ? summary : fullText,
      // 思考块设 full 供展开；助手块不需要 full（不可折叠）。
      ...(isThinking ? { full: fullText } : {}),
    }],
  }
}

// 从持久化的 history 消息重建 UI 块——与实时 tool_start+tool_end 逻辑对齐。
// 遍历消息：assistant 带 tool_calls 时暂存（按 tool_call_id 索引）；tool 消息用 tool_call_id
// 找到对应的 tool_call，组成完整工具块（工具名+参数+结果摘要/全文）。
// assistant 的正文（content）单独成块；纯 tool_calls 的 assistant（content 为 null）不产生块。
// thinking 数组按轮次一一对应——每轮 LLM 调用产生一个 thinking 条目（有内容或空字符串）。
// 每条 assistant 消息消费一个 thinking 条目（含 content=null 的 tool_calls 消息），保证对齐。
// 空字符串条目跳过（不显示思考块）——这轮没开思考或模型没返回 reasoning。
function rebuildBlocksFromHistory(messages: Message[], thinking: { text: string }[] = []): Block[] {
  const pendingCalls = new Map<string, ToolCall>()
  const blocks: Block[] = []
  let thinkingIdx = 0
  for (const m of messages) {
    if (m.role === 'user') {
      blocks.push({ kind: 'user', color: 'accent', text: m.content })
    } else if (m.role === 'assistant') {
      // 暂存 tool_calls 供后续 tool 消息配对。
      if (m.tool_calls) for (const tc of m.tool_calls) pendingCalls.set(tc.id, tc)
      // 消费一个 thinking 条目——与这条 assistant 消息一一对应。
      if (thinkingIdx < thinking.length) {
        const t = thinking[thinkingIdx]!
        // 空字符串 = 这轮没开思考或没产生 reasoning，跳过不显示。
        if (t.text) {
          const summary = t.text.split('\n').slice(0, 3).join('\n') + (t.text.split('\n').length > 3 ? '\n…（展开查看完整思考）' : '')
          blocks.push({ kind: 'thinking', color: 'yellow', text: summary, full: t.text })
        }
      }
      thinkingIdx++
      if (m.content) {
        blocks.push({ kind: 'assistant', color: 'text', text: m.content })
      }
    } else if (m.role === 'tool') {
      // 用 tool_call_id 找到对应的 tool_call——结构化重建，与实时 tool_start/tool_end 同构。
      // 历史消息不区分成功/失败（无 error 标记），统一记 done。
      const call = pendingCalls.get(m.tool_call_id)
      const toolName = call?.function.name ?? '工具'
      let toolInput: unknown
      try {
        toolInput = JSON.parse(call?.function.arguments || '{}')
      } catch {
        toolInput = call?.function.arguments ?? ''
      }
      blocks.push({
        kind: 'tool',
        color: 'cyan',
        text: formatToolTitle(toolName, toolInput, m.content),
        toolId: m.tool_call_id,
        toolName,
        toolInput,
        toolStatus: 'done',
        toolOutput: m.content,
        toolBody: formatToolBody(toolName, toolInput, m.content),
      })
      pendingCalls.delete(m.tool_call_id)
    }
  }
  return blocks
}

// reducer：AgentToUiMessage → ChatState 的纯函数。★ 可单测。
// 产出语义 Block（kind + colorToken），不含具体视觉值——视觉映射归各 UI theme 层。
export function reducer(state: ChatState, msg: Action): ChatState {
  switch (msg.type) {
    case 'local_user':
      return { ...state, blocks: [...state.blocks, { kind: 'user', color: 'accent', text: msg.text }] }
    case 'text_delta': {
      // 推理模型的思考与回答是两种块：轮到 text_delta 时，若有未落盘的思考块，先 flush 再开新回答块。
      const base = state.partial?.kind === 'thinking' ? flush(state) : state
      return { ...base, status: 'responding', partial: { kind: 'assistant', text: (base.partial?.text ?? '') + msg.delta } }
    }
    case 'thought_delta': {
      const base = state.partial?.kind === 'assistant' ? flush(state) : state
      return { ...base, status: 'thinking', partial: { kind: 'thinking', text: (base.partial?.text ?? '') + msg.delta } }
    }
    case 'stream_reset':
      // 立法：请求层重试从零重发增量，UI 的 partial 必须先清空——否则第 2 次尝试的
      // delta 追加在第 1 次残文后，展示与持久化分叉。不落盘、不产生新块（残文本就是该丢弃的半成品）。
      return { ...state, partial: null }
    case 'message':
      return msg.role === 'assistant' ? flush(state) : state
    case 'tool_pending':
      // 模型正在生成工具调用参数——UI 显示准备中提示（tool_start 到达时清除）。
      return { ...state, pendingTool: msg.name }
    case 'tool_start': {
      const flushed = flush(state)
      // 工具块不预拼展示文本——结构化事实 + tool-display 格式化产物，渲染层零解析。
      const block: Block = {
        kind: 'tool',
        color: 'cyan',
        text: formatToolTitle(msg.name, msg.input),
        toolId: msg.id,
        toolName: msg.name,
        toolInput: msg.input,
        toolStatus: 'running',
      }
      return { ...flushed, status: 'executing', toolActive: true, pendingTool: null, blocks: [...flushed.blocks, block] }
    }
    case 'tool_end': {
      // 拒绝/失败工具也有 tool_end（error 标记）——status 结构化区分，渲染层据此选图标。
      // 用 toolId 精确匹配 tool_start 的块——不靠数组尾部（notice/compaction 块可能插在中间）。
      const idx = state.blocks.findIndex((b) => b.toolId === msg.id)
      if (idx < 0) {
        // 孤儿 tool_end（无配对 tool_start）：R3 立法——拒绝也发 tool_end，让 UI 能渲染 denied，
        // reducer 不能静默丢弃——否则聊天区零反馈、pendingTool 悬挂到下次 tool_start。
        // 兜底生成一个完整 tool 块（无 tool_start 的 input，参数段自然为空）；
        // 工具名缺失时回退 pendingTool 的标签。partial 先 flush——助手文本在工具调用之前，顺序落盘。
        const name = msg.name || state.pendingTool || '工具'
        const status: ToolStatus = msg.error === 'denied' ? 'rejected' : msg.error ? 'error' : 'done'
        const flushed = flush(state)
        const orphan: Block = {
          kind: 'tool',
          color: 'cyan',
          text: formatToolTitle(name, undefined, msg.output, msg.error),
          toolId: msg.id,
          toolName: name,
          toolStatus: status,
          toolOutput: msg.output,
          toolError: msg.error,
          toolBody: formatToolBody(name, undefined, msg.output, msg.error),
        }
        return { ...flushed, blocks: [...flushed.blocks, orphan], toolActive: false, pendingTool: null }
      }
      const blocks = [...state.blocks]
      const target = blocks[idx]!
      const status: ToolStatus = msg.error ? (msg.error === 'denied' ? 'rejected' : 'error') : 'done'
      blocks[idx] = {
        ...target,
        toolStatus: status,
        toolOutput: msg.output,
        toolError: msg.error,
        text: formatToolTitle(msg.name, target.toolInput, msg.output, msg.error),
        toolBody: formatToolBody(msg.name, target.toolInput, msg.output, msg.error),
      }
      // 找到匹配块才重置 toolActive——该块内容已固化，UI 可将其打印进缓冲区。
      return { ...state, blocks, toolActive: false }
    }
    case 'state':
      // 转换到 cancelled/idle 时 flush partial——避免取消后残留的流式文本被
      // 下一轮 text_delta 拼接（导致"先回答上一个问题"的 bug）。
      if (msg.to === 'cancelled' || msg.to === 'idle') {
        return { ...flush(state), status: msg.to, pendingTool: null }
      }
      return { ...state, status: msg.to }
    case 'finished':
      return { ...flush(state), status: 'finished', pendingTool: null }
    case 'error': {
      // flush partial——错误时把流式中的 partial 落盘，避免永久显示"流式"幽灵块 + 丢失部分文本。
      const f = flush(state)
      return { ...f, status: 'error', pendingTool: null, blocks: [...f.blocks, { kind: 'error', color: 'red', text: msg.error.message }] }
    }
    case 'notice':
      return { ...state, blocks: [...state.blocks, { kind: 'notice', color: 'subtext', text: msg.text }] }
    case 'session_ready':
      // session_ready 带的是 history（完整原文）+ thinking（每轮的推理内容，空字符串表示该轮无思考）。
      // rebuildBlocksFromHistory 按序一一对应 assistant 消息和 thinking 条目。
      // 空字符串的 thinking 条目被跳过——不显示思考气泡。
      // 清空 partial——否则切换会话时旧会话的流式文本残留显示。
      return {
        ...state,
        status: 'idle',
        partial: null,
        toolActive: false,
        pendingTool: null,
        blocks: rebuildBlocksFromHistory(msg.messages, msg.thinking),
      }
    case 'compaction':
      // 压缩（手动或自动）都在对话面板插入一条提示块，统一显示为「压缩」。
      return { ...state, blocks: [...state.blocks, { kind: 'auto_compact', color: 'subtext', text: `Context compacted: ${msg.before_tokens} → ${msg.after_tokens} tokens` }] }
    case 'tools_list':
    case 'status_state':
    case 'context_state':
    case 'system_state':
    case 'log_state':
      // 这些命令响应改为 info overlay/面板呈现（App 的 onMessage 拦截切换），reducer 不再产生消息块。
      return state
    case 'history_cleared':
      // 清空历史——先 flush partial，然后在对话面板插入一条提示，再清空。
      return { ...flush(state), blocks: [{ kind: 'notice', color: 'subtext', text: 'History cleared' }], partial: null, toolActive: false, pendingTool: null }
    default:
      return state
  }
}
