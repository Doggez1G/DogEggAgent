# 05 · session：工作集、持久化与生命周期

> session/ 回答三个问题：一轮对话正在改动的数据放哪（conversation）、怎么存到磁盘（store）、
> 新建/恢复/删除的流程是什么（manager）。

## conversation：R1 双写分离的落地

`session/conversation.ts` 是 agent 运行期的**工作集**——轮次改它、压缩改它、生命周期重置它：

```ts
export class Conversation {
  private history: Message[] = []      // 完整原文：永不压缩，给 UI 显示
  private context: Message[] = []      // 发给模型的消息：会被压缩
  private thinking: { text: string }[] // 推理模型的思考内容（不进 history/context）
  private sessionId = newId()
  private cwdValue: string

  pushUserMessage(text: string): void      // R1 双写：user 消息同时进两个数组
  applyTurnResult(result: TurnDelta): void // 轮次收尾：context 替换 + history 增量 + thinking 累积
  replaceContext(context: Message[]): void // 手动压缩后替换（History 不动）
  clearMessages(): void                    // /clear（thinking 不动，与旧行为一致）
  reset(): void                            // 新会话：全新 id + 清空一切
  load(s: SessionSnapshot): void           // resume：整体替换 + 恢复 cwd
  snapshotFull(allowedTools: string[]): SessionSnapshot  // 落盘组装的唯一入口
}
```

**history 与 context 为什么要分开？** 这是 R1 需求：UI 上用户永远看到完整对话原文（history），而发给模型的 context 会被压缩丢旧换摘要。合并成一个数组的实现里，两者只能选一——要么 UI 丢失历史，要么窗口爆掉。双写分离让两边各自演化，压缩在结构上碰不到 history。

**TurnDelta 是什么？** conversation 的 `applyTurnResult` 接收的是 turn 域 `LoopResult` 的结构子集：

```ts
export interface TurnDelta {
  context: Message[]
  newMessages: Message[]
  thinking: { text: string }[]
}
```

用结构类型而不是直接 import `LoopResult`，是为了**避免 session → turn 的依赖**（依赖矩阵：turn → session 单向）。TypeScript 的结构类型让 LoopResult 天然满足 TurnDelta，零运行时成本。

## store：JSON 持久化与原子写

`session/store.ts` 把会话存为 `~/.dogegg/sessions/<id>.json`：

```json
{
  "id": "a1b2c3d4",
  "updatedAt": "2026-09-07T…",
  "history": [...],        // 完整原文
  "context": [...],        // 发给模型的（可压缩）
  "allowedTools": ["read_file"],  // 会话级 allow_always 授权（resume 恢复）
  "cwd": "/home/user/project",    // 创建时的工作目录（resume 恢复）
  "thinking": [{ "text": "…" }]   // 思考块（resume 恢复显示）
}
```

两个值得学的细节：

1. **原子写**：先写 `<id>.json.tmp` 再 `renameSync` 覆盖——崩溃时不会留下半写坏的原文件。
2. **旧格式迁移**：`load()` 里 `raw.history ?? raw.messages ?? []` 兼容只有 messages 字段的旧文件，且 `context = raw.context ?? [...history]` **必须拷贝**——否则旧格式下 context 与 history 指向同一数组，双写变三写。

损坏容错：`list()` 里单个文件损坏不阻断整个列表，返回「（文件损坏）」占位项。

## manager：生命周期与两条隐藏语义

`session/manager.ts` 处理五种命令（new/resume/delete/list/clear），逻辑都不复杂，但有三处容易忽略的语义：

1. **权限会话隔离**：`newSession` 调 `permission.reset()`——allow_always 授权只对当前会话生效，新建/切换会话清空；而 `resume` 是 reset 后**按存档恢复**（跨会话切换保留授权）。
2. **cwd 持久化**：会话记录创建时的工作目录，resume 时恢复——从项目 A 切到会话 B 再切回来，目录跟着会话走。
3. **新建会话立即落盘**：让 `list_sessions` 能立刻返回新会话（侧栏即时显示），保存失败静默（不打扰用户）——与轮次结束的落盘（失败发 notice）错误策略不同，这是刻意保留的差异。

## 落盘的三个时机（同一个组装入口）

```ts
// ① 新建会话（静默失败）—— session/manager.ts
try { this.deps.sessions.save(this.deps.conversation.snapshotFull(this.deps.ctx.permission.listAllowed())) } catch {}

// ② 轮次结束 finally（失败发 notice）—— turn/turn-runner.ts
this.deps.sessions.save(this.deps.conversation.snapshotFull(this.deps.ctx.permission.listAllowed()))

// ③ 手动压缩成功后（异常上抛进外层 catch）—— turn/turn-runner.ts
this.deps.sessions.save(this.deps.conversation.snapshotFull(this.deps.ctx.permission.listAllowed()))
```

三个时机错误策略不同（静默 / notice / 上抛），**刻意不收口成一个函数**；收口的是**组装**——`snapshotFull` 是构造快照的唯一入口，allowedTools 从 ctx.permission 取。
