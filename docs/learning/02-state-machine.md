# 02 · 10 态状态机

## 为什么需要状态机

Agent 的运行过程不是线性的——模型可能流式返回文本、可能调工具、工具可能需要审批、用户可能打断。每个时刻 agent 处于什么状态，决定了 UI 状态栏显示什么、哪些操作合法。

DogEggAgent 用一个**纯函数状态机**管理所有状态迁移。状态完全由输入驱动，当前态参与合法性判断。

## 10 个状态

```ts
// bridge/src/contract/shared.ts
type State =
  | 'idle'               // 空闲，等待输入
  | 'thinking'           // 推理模型吐 reasoning token
  | 'responding'         // 流式吐最终答案
  | 'tool_calling'       // 模型返回了 tool_calls，准备执行
  | 'waiting_permission' // 某个工具等待审批
  | 'executing'          // 工具执行中
  | 'finished'           // 本轮正常结束
  | 'cancelled'          // 用户取消
  | 'error'              // 出错
  | 'compacting'         // 压缩上下文中
```

## 迁移输入（TransitionInput）

每个迁移由一个输入事件触发。用 discriminated union 定义，15 个变体：

```ts
// agent/src/core/state/events.ts
type TransitionInput =
  | { kind: 'submit'; reasoning: boolean }        // 用户提交 → thinking/responding
  | { kind: 'thought_done' }                     // reasoning 结束 → responding
  | { kind: 'final_answer' }                     // 无 tool_calls → finished
  | { kind: 'tool_calls' }                       // 模型返回 tool_calls → tool_calling
  | { kind: 'tool_needs_permission' }            // 需审批 → waiting_permission
  | { kind: 'allow' }                             // 审批通过 → executing
  | { kind: 'tool_auto' }                        // 自动放行 → executing
  | { kind: 'tool_done' }                        // 单个工具完成 → tool_calling（继续下一个）
  | { kind: 'reject'; reasoning: boolean }       // 拒绝 → thinking/responding（重新请求）
  | { kind: 'result_back'; reasoning: boolean }  // 最后一个工具完成 → thinking/responding
  | { kind: 'compact_start' }                    // 开始压缩 → compacting
  | { kind: 'compact_done'; next: State }        // 压缩完成 → 调用方指定态
  | { kind: 'cancel' }                           // 用户取消 → cancelled
  | { kind: 'error' }                             // 出错 → error
  | { kind: 'reset' }                             // 复位 → idle
```

`reasoning` 标志在 `submit`/`reject`/`result_back` 上——因为这三个输入都会导致"重新请求模型"，而推理模型回到 `thinking`、普通模型回到 `responding`。

## 迁移函数 + VALID_FROM 守卫

```ts
// agent/src/turn/state.ts

// 合法迁移来源表：每个 input kind 只能从特定状态触发。
// 不在表中的 (input, state) 组合返回原态（不迁移），防止逻辑错误导致非法状态序列。
const VALID_FROM: Record<TransitionInput['kind'], ReadonlySet<State>> = {
  submit: new Set(['idle', 'finished', 'cancelled', 'error']),
  thought_done: new Set(['thinking']),
  final_answer: new Set(['responding']),
  tool_calls: new Set(['responding', 'thinking']),
  tool_auto: new Set(['tool_calling']),
  tool_needs_permission: new Set(['tool_calling']),
  allow: new Set(['waiting_permission']),
  tool_done: new Set(['executing', 'waiting_permission']),
  reject: new Set(['executing', 'waiting_permission', 'tool_calling']),
  result_back: new Set(['executing']),
  compact_start: new Set(['thinking', 'responding', 'idle', ...]),
  compact_done: new Set(['compacting']),
  cancel: new Set(['thinking', 'responding', 'tool_calling', ...]),
  error: new Set(['thinking', 'responding', 'tool_calling', ...]),
  reset: new Set(['finished', 'cancelled', 'error', 'idle', 'compacting']),
}

export function transition(s: State, input: TransitionInput): State {
  const allowed = VALID_FROM[input.kind]
  if (allowed && !allowed.has(s)) return s  // 非法组合 → 不迁移
  switch (input.kind) {
    case 'submit': return input.reasoning ? 'thinking' : 'responding'
    case 'final_answer': return 'finished'
    case 'tool_calls': return 'tool_calling'
    case 'allow':
    case 'tool_auto': return 'executing'
    case 'compact_start': return 'compacting'
    case 'compact_done': return input.next  // 调用方决定回哪
    case 'cancel': return 'cancelled'
    case 'error': return 'error'
    case 'reset': return 'idle'
    ...
  }
}
```

**VALID_FROM 守卫的意义**：当前所有调用序列都合法，守卫不会拦截。但如果未来某处逻辑错误发了非法迁移（比如在 `idle` 态发 `final_answer`），守卫会让状态不变，而非产生 `finished` 这种荒谬状态。

## 迁移图

```
idle ──submit──▶ thinking | responding
thinking ──thought_done──▶ responding
responding ──final_answer──▶ finished
responding ──tool_calls──▶ tool_calling
tool_calling ──tool_auto──▶ executing
tool_calling ──tool_needs_permission──▶ waiting_permission
waiting_permission ──allow──▶ executing
executing ──tool_done──▶ tool_calling（继续下一个工具）
executing ──result_back──▶ thinking | responding（重新请求模型）
executing ──reject──▶ thinking | responding（拒绝后重新请求）
任意运行态 ──compact_start──▶ compacting
compacting ──compact_done──▶ thinking | responding | idle
任意运行态 ──cancel──▶ cancelled
任意运行态 ──error──▶ error
finished / cancelled / error / compacting ──reset──▶ idle
```

## 谁调用 transition

两个地方：

1. **agent.ts 的 `emitState(input)`**：算下一态后 emit `state` 事件，并**附带发一条 `status_state`**（含最新 token 估算）——状态栏在每次状态迁移时实时更新（见 `agent/src/agent.ts`）。
2. **loop/run.ts 的 `trans` 闭包**：loop 内部每次迁移都经 `trans`，确保状态事件 emit + 日志记录。

```ts
// agent/src/agent.ts
private emitState(input: TransitionInput): void {
  const next = transition(this.state, input)
  if (next !== this.state) this.emit({ type: 'state', from: this.state, to: next })
}

// agent/src/loop/run.ts
const trans = (input: TransitionInput): State => {
  const next = transition(state, input)
  if (next !== state) deps.emit({ type: 'state', from: state, to: next })
  return next
}
```

两处都先检查 `next !== state`，避免无变化时发冗余事件。

## 设计要点

- **纯函数**：`transition(s, input)` 无副作用，只返回下一态。emit 由调用方做。
- **输入驱动**：状态完全由输入事件决定，不依赖时间或外部变量。
- **守卫表**：VALID_FROM 防御非法迁移，是安全网而非主逻辑。
- **reasoning 分支**：推理模型的 `thinking` 态 + `thought_delta` 事件，让 UI 可以分开显示"思考"和"回答"。
