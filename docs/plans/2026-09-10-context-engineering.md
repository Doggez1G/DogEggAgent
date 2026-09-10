# 上下文工程（M2）实施计划

> 日期：2026-09-10
> 规格：`docs/superpowers/specs/2026-09-10-context-engineering-design.md`。
> 每批次末尾 `npm run typecheck && npm run test:run` 全绿才进入下一批次。

## 批次 U1：压缩重构（全量总结）

- 删除：`context/compaction/split.ts`、`context/token/enforce.ts` 及全部导出与测试引用；
- 重写 `turn/compactor.ts`：阈值/force 判定 → summarize(整个 context) → context = [摘要 user 消息]
  （头标注常量）；空摘要视为失败抛错；
- 重写 `turn/summarize.ts`：结构化交接提示词（目标/已完成/文件/决策/待办/偏好），maxOutput 2000；
- `turn/loop.ts`：删 enforce 调用；压缩失败不再降级——移除内层 catch，异常上抛由外层按错误收尾；
- 测试：compactor 重写、context.test 删 split 用例、删 enforce.test、表征「手动压缩」适配。

## 批次 U2：usage 链路

- llm：`sse-types` 增 usage、`parser` 捕获、`types.ts` 增 `LlmUsage`（done 事件与 ChatResult 携带）、
  `request` 增 `stream_options`、`stream` 透传 usage；
- loop：轮内累计 usage → LoopResult.usage + finished 携带；compactions 计数随 LoopResult 返回；
- conversation：`usage`（prompt/completion/turns 累计）+ `lastTurn` + `compactions` 计数，
  applyTurnResult 累积、snapshot/load 持久化、reset 清零；
- turn-runner：finished { usage }（loop 已发）；status_state 增可选 `usage`（会话累计）；
- TUI 状态栏追加会话累计 tokens；WebUI 状态栏同步；
- 测试：parser usage 用例、request 断言、session roundtrip。

## 批次 U3：仪表盘 + 文档

- `context/token/breakdown.ts`：`breakdownContextTokens` 纯函数 + 单测；
- `context_state` 契约增 `breakdown?`/`lastTurn?`/`sessionUsage?`/`compactions`（schema 同步）；
- agent.ts context_request 计算并下发；TUI /context 面板与 WebUI Context 卡片渲染分段与用量；
- 文档：learning/04（压缩重构）与 07（usage）重写相关章节、根设计文档需求 12 更新、ADR-0011、README；
- 验证：typecheck + 全量测试 + build + build:web 全绿。
