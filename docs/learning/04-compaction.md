# 04 · 压缩：策略与机制的分离

> 上下文窗口有限，对话越来越长怎么办？——把旧消息压成一段摘要。这个功能横跨两个文件夹：
> **纯策略在 `context/`（何时压、怎么切、硬上限），编排在 `turn/`（调 LLM、发事件）**。
> 本章解释为什么这么切，以及压缩的全部规则。

## 策略/机制分离（本域最重要的设计决策）

「压缩」其实是两件事：

- **策略**（policy）：纯函数——给一堆消息和窗口大小，回答「该压吗？怎么切？」。没有 LLM、没有事件、可以穷举测试 → 归 `context/`。
- **机制**（mechanism）：编排——真的去调 LLM 做摘要、改 context、发 `compaction` 事件、处理取消 → 归 `turn/`。

```
context/compaction/{trigger,split}.ts   # 何时压（80%）、怎么切（keep=4）
context/token/{estimate,budget,enforce}.ts  # 估算、组合预算、硬上限兜底
turn/compactor.ts + turn/summarize.ts   # 编排：Compactor 类 + 摘要的 LLM 调用
```

混在一起（重构前的状态）会让策略文件里出现 LLM 回调参数，测试就要 mock 网络。

## 何时压：80% 阈值

```ts
// context/compaction/trigger.ts
export function shouldCompact(used: number, windowTokens: number): boolean {
  return used > windowTokens * COMPACTION_THRESHOLD   // 0.8，常量在 bridge 契约
}
```

阈值定 80% 而非 100%——留缓冲，避免模型刚好要回答时才触发压缩。这个常量放 bridge 契约是**立法**的：TUI 状态栏和 WebUI 信息面板的进度条变色也依赖它，两端必须一致（注释在 `bridge/src/contract/shared.ts`）。

token 怎么算？`token/estimate.ts` 用粗估：CJK 字符 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token。精度足够做预算判断，不值得为此引入 tokenizer。

## 怎么切：keep=4

```ts
// context/compaction/split.ts
export function splitForCompaction(messages: Message[], keep = 4) {
  if (messages.length <= keep) return { old: [], fresh: [...messages] }
  return { old: messages.slice(0, -keep), fresh: messages.slice(-keep) }
}
```

压缩结果 = `[摘要消息, ...最近 4 条原文]`——旧消息进摘要，最近几条保留原文让模型能续接。

**force 语义**（手动 `/compact` 与自动触发共用一个入口）：
- 自动（loop 内）：仅超 80% 才压；
- 手动（`/compact`）：无条件压，且消息太少时把全部交给摘要（keep 降为 0）。

## R1 铁律：只压 Context，绝不碰 History

```ts
// turn/compactor.ts
export class Compactor {
  constructor(private readonly summarize: (old: Message[], signal?: AbortSignal) => Promise<string>) {}

  async compact(input: { context, systemPrompt, tools, windowTokens, force?, signal? }): Promise<CompactResult> {
    // 空 → 不压；未达阈值且非 force → 不压；切分 → this.summarize(old) → 重组 context
    return { compacted: true, context, before, after }
  }
}
```

注意签名：**函数只接收 context、返回新 context**——它结构上就碰不到 history。这是 R1（history 单调增长、UI 显示完整原文）的编译期保证，`test/turn/compactor.test.ts` 专门验证「传入数组不被原地修改」。

`summarize` 回调由门面注入（闭合在 ctx 上，调用时读**当前**配置解析 provider）——压缩机制因此不直接依赖 llm 域，测试注入一个假回调即可。

## 硬上限兜底：enforceContextLimit

压缩是「软」手段。但若单条消息极大（一次 shell 输出几万 token），或压缩失败降级，压缩后 context 可能**仍超 80%**。此时 `token/enforce.ts` 从头部丢弃最旧消息直到降到阈值下（至少保留 1 条）。被丢弃的消息在 history 里仍完整保留——只是不再发给模型，UI 显示不受影响。

## 触发链路（在 loop 里的位置）

```
loop 每次迭代开头：
  used = estimateContextTokens(systemPrompt, context, registry.schemas())
  if (used > windowTokens * 0.8) {
    trans({ kind: 'compact_start' })            // → compacting（UI 可感知）
    try { Compactor.compact() → 替换 context → emit compaction 事件 }
    catch { /* 压缩失败降级：继续用未压缩 context，不中断轮次 */ }
    trans({ kind: 'compact_done', next: ... })  // 回 thinking/responding
    enforceContextLimit()                        // 硬上限兜底
  }
```

压缩失败**不 abort 轮次**——模型仍能用未压缩 context 回答，只是窗口紧张。这是可用性优先的取舍。

## 手动压缩（/compact）与自动压缩的关系

两者都走 `Compactor.compact()`，仅参数不同（force=true / 事件 source='manual'）。编排差异在 `turn/turn-runner.ts`：自动压缩在 loop 内、手动压缩独立占闸门（防止压缩期间 submit 写入 context），完成后落盘并回 idle。
