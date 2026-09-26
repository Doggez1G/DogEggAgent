import type { Message, ToolPermission } from '@dogegg/bridge'
import type { SessionSnapshot } from './store'
import { newId } from '../shared'
// P1-6 配对毒化修补：修补的是「OpenAI 契约级不变量」（assistant.tool_calls 必须有配对 tool 消息），
// 纯函数收口在 bridge/contract/message-pairing——引擎与存储同源引用，不引入 session→turn 依赖边。
import { patchUnpairedToolCalls, INTERRUPTED_TOOL_CONTENT } from '@dogegg/bridge'

// 轮次增量：turn 特征回传的工作集变更（LoopResult 的结构子集——session 不依赖 turn）。
export interface TurnDelta {
  context: Message[]
  newMessages: Message[]
  thinking: { text: string }[]
  /** 本轮真实用量（API 返回）——累计进会话用量并记为 lastTurn。 */
  usage?: { promptTokens: number; completionTokens: number }
  /** 本轮自动压缩次数——累计进会话统计。 */
  compactions?: number
}

// 会话用量统计：跨轮累计（持久化进会话文件，resume 续计）+ 最近一轮快照（与估算并排对照）。
export interface SessionUsage {
  promptTokens: number
  completionTokens: number
  turns: number
}

// 会话工作集：Agent 运行期的可变对话状态，轮次/压缩/会话生命周期三方共用的唯一数据归属。
// R1 双写分离：history = 完整原文（永不压缩，UI 显示用）；context = 发给模型的消息（可压缩）。
export class Conversation {
  private history: Message[] = []
  private context: Message[] = []
  private thinking: { text: string }[] = []
  private sessionId = newId()
  private cwdValue: string
  private usage: SessionUsage = { promptTokens: 0, completionTokens: 0, turns: 0 }
  private lastTurn: { promptTokens: number; completionTokens: number } | undefined
  private compactions = 0
  private title: string | undefined

  constructor(cwd: string) {
    this.cwdValue = cwd
  }

  getId(): string {
    return this.sessionId
  }

  getCwd(): string {
    return this.cwdValue
  }

  setCwd(path: string): void {
    this.cwdValue = path
  }

  getHistory(): Message[] {
    return this.history
  }

  getContext(): Message[] {
    return this.context
  }

  getThinking(): { text: string }[] {
    return this.thinking
  }

  // R1 双写：user 消息同时进 history 与 context。
  pushUserMessage(text: string): void {
    const msg: Message = { role: 'user', content: text }
    this.history.push(msg)
    this.context.push(msg)
  }

  // 轮次收尾：loop 返回的 context 替换工作集（loop 内部可能已压缩）；新增消息 append 到 history；
  // thinking 累积；真实用量累计并记为 lastTurn；压缩计数累加。
  applyTurnResult(result: TurnDelta): void {
    this.context = result.context
    this.history.push(...result.newMessages)
    this.thinking.push(...result.thinking)
    if (result.usage) {
      this.usage.promptTokens += result.usage.promptTokens
      this.usage.completionTokens += result.usage.completionTokens
      this.usage.turns += 1
      this.lastTurn = { ...result.usage }
    }
    this.compactions += result.compactions ?? 0
  }

  getUsage(): SessionUsage {
    return { ...this.usage }
  }

  getLastTurn(): { promptTokens: number; completionTokens: number } | undefined {
    return this.lastTurn ? { ...this.lastTurn } : undefined
  }

  getCompactions(): number {
    return this.compactions
  }

  getTitle(): string | undefined {
    return this.title
  }

  // setTitle：/rename 手动命名或自动标题写入；有值后自动生成跳过（手动命名优先）。
  setTitle(title: string): void {
    this.title = title
  }

  // 手动 /compact 的计数入口（自动压缩的计数随 LoopResult.compactions 走 applyTurnResult）。
  incrementCompaction(): void {
    this.compactions += 1
  }

  // 手动压缩后替换 context（History 不动——R1）。
  replaceContext(context: Message[]): void {
    this.context = context
  }

  // /clear：清空对话消息。thinking 一并清空——/clear 的语义是「全新对话」，思考块随对话消失；
  // 若只清消息而保留 thinking，resume 恢复链 rebuildBlocksFromHistory 会按序消费思考条目，
  // 旧对话的思考块会错位挂到新对话的 assistant 消息上（思考张冠李戴）。
  clearMessages(): void {
    this.history = []
    this.context = []
    this.thinking = []
  }

  // 新会话：全新 id + 空工作集（含 thinking）。
  reset(): void {
    this.history = []
    this.context = []
    this.thinking = []
    this.sessionId = newId()
    this.usage = { promptTokens: 0, completionTokens: 0, turns: 0 }
    this.lastTurn = undefined
    this.compactions = 0
    this.title = undefined
  }

  // resume：整体替换工作集；快照带 cwd 时一并恢复（项目→会话切换恢复目录）。
  load(s: SessionSnapshot): void {
    // 【立法 P1-6 检查点配对毒化兜底】旧版本写入的检查点可能以「带 tool_calls 且无 tool 结果」
    // 的 assistant 结尾（onProgress 在 assistant push 后立即触发检查点，工具尚在执行时崩溃/断电）。
    // 恢复后下一轮请求把该 context 发给严格实现的 OpenAI API 会被 400 拒绝（协议要求每个
    // tool_call 必须有配对的 tool 消息）。load 时对 history 与 context 应用与 writeCheckpoint
    // 同款的纯函数修补——新写入的检查点已在落盘前修补，这里是兜底：修复历史遗留的毒化文件，
    // 并让「配对完整性」规则在读写两端单点收口。修补返回副本，不改动快照入参数组。
    this.history = patchUnpairedToolCalls(s.history, INTERRUPTED_TOOL_CONTENT)
    this.context = patchUnpairedToolCalls(s.context, INTERRUPTED_TOOL_CONTENT)
    this.thinking = s.thinking
    this.sessionId = s.id
    if (s.cwd) this.cwdValue = s.cwd
    this.usage = s.usage ?? { promptTokens: 0, completionTokens: 0, turns: 0 }
    this.lastTurn = undefined
    this.compactions = s.compactions ?? 0
    this.title = s.title
  }

  // 落盘快照——组装的唯一入口（三个落盘调用点共用；sessionPermissions/usage 归各自提供方传入）。
  snapshotFull(sessionPermissions: ToolPermission[], usage: SessionUsage, compactions: number): SessionSnapshot {
    return { id: this.sessionId, history: this.history, context: this.context, sessionPermissions, cwd: this.cwdValue, thinking: this.thinking, usage, compactions, title: this.title }
  }

  // 轮次中途检查点快照（B：长任务崩溃/断电保护）——与 snapshotFull 同形的落盘对象，但【不改内存】：
  // - history' = 现有 history + 轮内已完成的 newMessages（轮末 applyTurnResult 前它们只在 loop 手里）；
  // - context' = loop 的实时 context 引用（压缩后的最新口径；save 时同步序列化当时内容，接收方只读）；
  // - thinking' = 现有 thinking + 轮内已产生的 thinking；
  // - usage' = 会话累计 + 轮内已累计的真实用量（turns 不 +1——轮未完成，不计轮次）。
  // 轮末正常 saveOrNotice 会以内存真相覆盖同一会话文件，检查点无残留风险；lastTurn 不写（中途无「上一轮」）。
  checkpoint(
    live: { context: Message[]; newMessages: Message[]; thinking: { text: string }[]; usage: { promptTokens: number; completionTokens: number } },
    sessionPermissions: ToolPermission[],
    compactions: number,
  ): SessionSnapshot {
    const cumulative = this.getUsage()
    return {
      id: this.sessionId,
      history: [...this.history, ...live.newMessages],
      context: live.context,
      sessionPermissions,
      cwd: this.cwdValue,
      thinking: [...this.thinking, ...live.thinking],
      usage: { promptTokens: cumulative.promptTokens + live.usage.promptTokens, completionTokens: cumulative.completionTokens + live.usage.completionTokens, turns: cumulative.turns },
      compactions,
      title: this.title,
    }
  }
}
