import type { Message } from './shared'

// 未配对 tool_calls 的补齐消息文案（两个使用场景、两种归因，不可混用）：
// - CANCELLED_TOOL_CONTENT（缺省）：loop 的取消/错误 catch 路径——多数场景是用户主动打断，沿用既有口径。
// - INTERRUPTED_TOOL_CONTENT：检查点落盘与会话加载——会话在工具执行中被崩溃/断电等中断，并非用户取消。
//   文案如实描述，避免给模型「用户打断」的错误归因诱导其在恢复后改变行为策略（如过度道歉、放弃原任务）。
export const CANCELLED_TOOL_CONTENT = 'cancelled（用户打断了操作）'
export const INTERRUPTED_TOOL_CONTENT = '会话在工具执行中被中断，未记录到该工具的结果'

/**
 * 补全未配对的 tool_calls（纯函数）：输入消息数组，返回修补后的数组，不改动入参。
 *
 * 为什么住在 bridge（立法）：「assistant 的每个 tool_call 必须有配对的 tool 消息，否则严格
 * 实现直接 400」是 OpenAI 协议的**契约级约束**，本函数是对该契约的修复——边界所有者是 bridge，
 * 故与 permission/config 等契约级纯函数同层。引擎（turn）、存储（session）双方从同一真源引用，
 * 依赖矩阵中不新增 session→turn 的边。
 *
 * 修补语义：
 * - 向后扫描找【最后一条】带 tool_calls 的 assistant 消息（不要求在数组尾部）；
 * - 检查它的每个 tool_call_id 是否有配对的 tool 结果消息（扫描范围：该 assistant 之后到数组尾部）；
 * - 缺的补一条 role:'tool' 消息追加到数组尾部。
 *
 * 为什么必须向后扫描而不能只查尾部：多工具批量调用时，tool 1 执行完、tool 2 被取消，尾部是
 * tool1_result（role:tool）——只查尾部会漏掉未配对的 tool 2。
 *
 * 纯度约定：
 * - 无修补必要时【原样返回入参引用】（零拷贝零开销；入参未被改动，调用方可安全继续使用）；
 * - 有修补时返回浅拷贝副本，补齐消息追加在尾部——调用方若需同步增量（如 loop 的 newMessages，
 *   R1 要求 history 与 context 同构），取 `out.slice(原数组长度)` 即得全部追加消息。
 *
 * 使用方（同一修补规则的三处收口，均在 agent 包）：
 * 1. loop 的 catch 路径（文案 = 缺省的取消归因）；
 * 2. turn-runner 的 writeCheckpoint：落盘前对快照的 history/context 修补（检查点配对毒化防护）；
 * 3. Conversation.load：恢复后对 history/context 修补（兜底修复旧版本写入的毒化文件）。
 */
export function patchUnpairedToolCalls(msgs: Message[], content: string = CANCELLED_TOOL_CONTENT): Message[] {
  // 向后扫描找最后一条带 tool_calls 的 assistant 消息。
  let lastAssistantIdx = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) { lastAssistantIdx = i; break }
  }
  if (lastAssistantIdx < 0) return msgs
  const assistant = msgs[lastAssistantIdx]!
  // 收集此 assistant 之后所有已配对的 tool_call_id。
  const paired = new Set<string>()
  for (let i = lastAssistantIdx + 1; i < msgs.length; i++) {
    const m = msgs[i]!
    if (m.role === 'tool') paired.add(m.tool_call_id)
  }
  // 找出未配对的 tool_call（assistant.role 守卫是防御式冗余：lastAssistantIdx 的判定已保证角色）。
  const toolCalls = assistant.role === 'assistant' ? (assistant.tool_calls ?? []) : []
  const missing = toolCalls.filter((tc) => !paired.has(tc.id))
  // 无修补必要：原样返回（不拷贝——调用方拿到的就是「修补后」的数组）。
  if (missing.length === 0) return msgs
  // 有修补：浅拷贝 + 尾部追加补齐消息（不改动入参数组）。
  return [...msgs, ...missing.map((tc) => ({ role: 'tool' as const, tool_call_id: tc.id, content }))]
}
