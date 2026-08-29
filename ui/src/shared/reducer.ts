import type { AgentToUiMessage, Message, ToolCall, State } from '@dogegg/bridge'
import { type Block, type BlockKind, type ColorToken, isExpandable } from './block'

// UI 的聊天状态：已落盘的块 + 当前状态 + 进行中的流式块（未落盘的 partial）。
export interface ChatState {
  blocks: Block[]
  status: State
  partial: { kind: 'assistant' | 'thinking'; text: string } | null
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
function rebuildBlocksFromHistory(messages: Message[]): Block[] {
  const pendingCalls = new Map<string, ToolCall>()
  const blocks: Block[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      blocks.push({ kind: 'user', color: 'accent', text: m.content })
    } else if (m.role === 'assistant') {
      // 暂存 tool_calls 供后续 tool 消息配对。
      if (m.tool_calls) for (const tc of m.tool_calls) pendingCalls.set(tc.id, tc)
      // 有正文的 assistant 单独成块；纯 tool_calls（content 为 null）不产生块（避免空块）。
      if (m.content) {
        blocks.push({ kind: 'assistant', color: 'text', text: m.content })
      }
    } else if (m.role === 'tool') {
      // 用 tool_call_id 找到对应的 tool_call，提取工具名+参数。
      const call = pendingCalls.get(m.tool_call_id)
      const toolName = call?.function.name ?? '工具'
      const argsStr = call ? ` ${call.function.arguments}` : ''
      const callLine = `${toolName}${argsStr}`
      // 与实时 tool_end 一致：text = 调用+摘要，full = 调用+完整结果。
      const summary = m.content.length > 120 ? m.content.slice(0, 120) + '…' : m.content
      blocks.push({
        kind: 'tool',
        color: 'cyan',
        text: `${callLine}\n✓ ${summary}`,
        full: `${callLine}\n✓ 完成\n${m.content}`,
      })
      pendingCalls.delete(m.tool_call_id)
    }
  }
  return blocks
}

// 从工具名和 input 参数格式化 diff 预览文本（展开时显示在工具块的 full 里）。
// edit_file: 显示 -old_string / +new_string；write_file: 显示 +content；shell: 显示命令。
function formatToolDiff(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const inp = input as Record<string, unknown>
  if (toolName === 'edit_file') {
    const path = String(inp.path ?? '')
    const oldStr = String(inp.old_string ?? '')
    const newStr = String(inp.new_string ?? '')
    return `变更预览 (${path}):\n- ${oldStr.slice(0, 500)}\n+ ${newStr.slice(0, 500)}`
  }
  if (toolName === 'write_file') {
    const path = String(inp.path ?? '')
    const content = String(inp.content ?? '')
    return `写入预览 (${path}):\n+ ${content.slice(0, 500)}`
  }
  if (toolName === 'shell') {
    return `命令: ${String(inp.command ?? '')}`
  }
  return null
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
    case 'message':
      return msg.role === 'assistant' ? flush(state) : state
    case 'tool_start': {
      const flushed = flush(state)
      return { ...flushed, status: 'executing', blocks: [...flushed.blocks, { kind: 'tool', color: 'cyan', text: `${msg.name} ${JSON.stringify(msg.input)}`, toolId: msg.id, toolInput: msg.input }] }
    }
    case 'tool_end': {
      // 拒绝/失败工具也有 tool_end（error 标记），此处统一渲染为 ✕ 或 ✓。
      // 用 toolId 精确匹配 tool_start 的块——不靠数组尾部（notice/compaction 块可能插在中间）。
      // full 里附带 diff 预览（edit_file/write_file/shell 的参数格式化），不只是工具返回的 content。
      const blocks = [...state.blocks]
      const idx = blocks.findIndex((b) => b.toolId === msg.id)
      if (idx >= 0) {
        const target = blocks[idx]!
        const summary = msg.error ? `✕ ${msg.error}` : `✓ 完成（${msg.output.slice(0, 120)}${msg.output.length > 120 ? '…' : ''}）`
        // 构建 full：工具调用 + 结果 + diff 预览（从 toolInput 格式化）
        const diffPreview = formatToolDiff(msg.name, target.toolInput)
        const fullParts = [target.text, msg.error ? `✕ ${msg.error}` : `✓ 完成\n${msg.output}`]
        if (diffPreview) fullParts.push(diffPreview)
        blocks[idx] = { ...target, text: `${target.text}\n${summary}`, full: fullParts.join('\n') }
      }
      return { ...state, blocks }
    }
    case 'state':
      return { ...state, status: msg.to }
    case 'finished':
      return { ...flush(state), status: 'finished' }
    case 'error': {
      // flush partial——错误时把流式中的 partial 落盘，避免永久显示"流式"幽灵块 + 丢失部分文本。
      const f = flush(state)
      return { ...f, status: 'error', blocks: [...f.blocks, { kind: 'error', color: 'red', text: msg.error.message }] }
    }
    case 'notice':
      return { ...state, blocks: [...state.blocks, { kind: 'notice', color: 'subtext', text: msg.text }] }
    case 'session_ready':
      // session_ready 带的是 history（完整原文），UI 据此渲染完整历史消息。
      // resume 重建块时，从 assistant.tool_calls 提取工具名+参数，与后续 tool 消息配对，
      // 组成完整工具块（工具名+参数+结果），与实时 tool_start+tool_end 逻辑一致，保证可折叠展开。
      // 注意：思考块是流式 thought_delta 产生的，不持久化进 history，resume 后无法恢复（固有限制）。
      // 清空 partial——否则切换会话时旧会话的流式文本残留显示。
      return {
        ...state,
        status: 'idle',
        partial: null,
        blocks: rebuildBlocksFromHistory(msg.messages),
      }
    case 'compaction':
      // 手动压缩弹 overlay/面板（App 处理），reducer 不产生块。
      // 自动压缩插一条 dim 提示块（不打断对话流），让用户知道发生了压缩。
      if (msg.source === 'auto') {
        return { ...state, blocks: [...state.blocks, { kind: 'auto_compact', color: 'subtext', text: `${msg.before_tokens} → ${msg.after_tokens} tokens` }] }
      }
      return state
    case 'tools_list':
    case 'status_state':
    case 'context_state':
    case 'system_state':
    case 'log_state':
      // 这些命令响应改为 info overlay/面板呈现（App 的 onMessage 拦截切换），reducer 不再产生消息块。
      return state
    case 'history_cleared':
      return { ...state, blocks: [], partial: null }
    default:
      return state
  }
}
