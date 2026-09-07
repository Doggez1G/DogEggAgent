import type { Message } from '@dogegg/bridge'
import type { SessionSnapshot } from './store'
import { newId } from '../shared'

// 轮次增量：turn 特征回传的工作集变更（LoopResult 的结构子集——session 不依赖 turn）。
export interface TurnDelta {
  context: Message[]
  newMessages: Message[]
  thinking: { text: string }[]
}

// 会话工作集：Agent 运行期的可变对话状态，轮次/压缩/会话生命周期三方共用的唯一数据归属。
// R1 双写分离：history = 完整原文（永不压缩，UI 显示用）；context = 发给模型的消息（可压缩）。
export class Conversation {
  private history: Message[] = []
  private context: Message[] = []
  private thinking: { text: string }[] = []
  private sessionId = newId()
  private cwdValue: string

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

  // 轮次收尾：loop 返回的 context 替换工作集（loop 内部可能已压缩）；新增消息 append 到 history；thinking 累积。
  applyTurnResult(result: TurnDelta): void {
    this.context = result.context
    this.history.push(...result.newMessages)
    this.thinking.push(...result.thinking)
  }

  // 手动压缩后替换 context（History 不动——R1）。
  replaceContext(context: Message[]): void {
    this.context = context
  }

  // /clear：清空对话消息（thinking 不动，与旧行为一致）。
  clearMessages(): void {
    this.history = []
    this.context = []
  }

  // 新会话：全新 id + 空工作集（含 thinking）。
  reset(): void {
    this.history = []
    this.context = []
    this.thinking = []
    this.sessionId = newId()
  }

  // resume：整体替换工作集；快照带 cwd 时一并恢复（项目→会话切换恢复目录）。
  load(s: SessionSnapshot): void {
    this.history = s.history
    this.context = s.context
    this.thinking = s.thinking
    this.sessionId = s.id
    if (s.cwd) this.cwdValue = s.cwd
  }

  // 落盘快照——组装的唯一入口（三个落盘调用点共用；allowedTools 归 ctx.permission 提供）。
  snapshotFull(allowedTools: string[]): SessionSnapshot {
    return { id: this.sessionId, history: this.history, context: this.context, allowedTools, cwd: this.cwdValue, thinking: this.thinking }
  }
}
