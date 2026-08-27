import type { AgentToUiMessage } from '@dogegg/bridge'
import { ICON, COLOR, type Block } from './block'

// UI 的聊天状态：已落盘的块 + 当前状态 + 进行中的流式块（未落盘的 partial）。
export interface ChatState {
  blocks: Block[]
  status: string
  partial: { kind: 'assistant' | 'thinking'; text: string } | null
}

// reducer 的输入：后端消息 + UI 本地动作（local_user 本地即时显示、local_help 显示帮助）。
export type Action = AgentToUiMessage | { type: 'local_user'; text: string } | { type: 'local_help' }

export const HELP = '/new /session /model /config /clear /compact /context /tools /system /status /log /help /quit'

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
  return {
    ...state,
    partial: null,
    blocks: [...state.blocks, {
      icon: isThinking ? ICON.thinking : ICON.assistant,
      role: isThinking ? '思考' : '助手',
      color: isThinking ? COLOR.thinking : COLOR.assistant,
      text: isThinking ? summary : fullText,
      // 思考块设 full 供展开；助手块不需要 full（不可折叠）。
      ...(isThinking ? { full: fullText } : {}),
    }],
  }
}

// 信息块：/status /context 等只读面板的内容，渲染成一个灰色块。
function infoBlock(state: ChatState, role: string, text: string): ChatState {
  return { ...state, blocks: [...state.blocks, { icon: '🥚', role, color: 'gray', text }] }
}

// reducer：AgentToUiMessage → ChatState 的纯函数。★ 可单测。
// R4：message 事件带真 id，reducer 不直接用 id（块定位靠数组顺序），但 id 保证后续可做精确块操作。
export function reducer(state: ChatState, msg: Action): ChatState {
  switch (msg.type) {
    case 'local_user':
      return { ...state, blocks: [...state.blocks, { icon: ICON.user, role: '你', color: COLOR.user, text: msg.text }] }
    case 'local_help':
      return infoBlock(state, '帮助', HELP)
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
      return { ...flushed, status: 'executing', blocks: [...flushed.blocks, { icon: ICON.tool, role: '工具', color: COLOR.tool, text: `${msg.name} ${JSON.stringify(msg.input)}` }] }
    }
    case 'tool_end': {
      // R3：拒绝/失败工具也有 tool_end（error 标记），此处统一渲染为 ✕ 或 ✓。
      const blocks = [...state.blocks]
      const last = blocks[blocks.length - 1]
      if (last && last.icon === ICON.tool) {
        const summary = msg.error ? `✕ ${msg.error}` : `✓ 完成（${msg.output.slice(0, 120)}${msg.output.length > 120 ? '…' : ''}）`
        const fullText = msg.error ? `✕ ${msg.error}` : `✓ 完成\n${msg.output}`
        blocks[blocks.length - 1] = { ...last, text: `${last.text}\n${summary}`, full: `${last.text}\n${fullText}` }
      }
      return { ...state, blocks }
    }
    case 'state':
      return { ...state, status: msg.to }
    case 'finished':
      return { ...flush(state), status: 'finished' }
    case 'error':
      return { ...state, status: 'error', blocks: [...state.blocks, { icon: '🐶', role: '错误', color: 'red', text: msg.error.message }] }
    case 'notice':
      return { ...state, blocks: [...state.blocks, { icon: '🥚', role: '提示', color: 'yellow', text: msg.text }] }
    case 'session_ready':
      // R1：session_ready 带的是 history（完整原文），UI 据此渲染完整历史消息。
      return {
        ...state,
        status: 'idle',
        blocks: msg.messages.flatMap((m): Block[] => {
          if (m.role === 'assistant') {
            const content = (m as { content: string | null }).content
            if (!content) return [] // 纯 tool_calls 的 assistant 消息：其后紧跟工具块，跳过避免空块
            return [{ icon: ICON.assistant, role: '助手', color: COLOR.assistant, text: content }]
          }
          if (m.role === 'tool') return [{ icon: ICON.tool, role: '工具结果', color: COLOR.tool, text: m.content }]
          return [{ icon: ICON.user, role: '你', color: COLOR.user, text: m.content }]
        }),
      }
    case 'tools_list':
    case 'status_state':
    case 'context_state':
    case 'system_state':
    case 'compaction':
    case 'log_state':
      // 这些命令响应改为 info overlay 呈现（App 的 onMessage 拦截切换），reducer 不再产生消息块。
      return state
    case 'history_cleared':
      return { ...state, blocks: [] }
    default:
      return state
  }
}
