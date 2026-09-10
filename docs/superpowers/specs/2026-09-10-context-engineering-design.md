# 上下文工程设计（M2）：usage 链路、全量总结压缩与 /context 仪表盘

> 状态：已确认，待实施
> 日期：2026-09-10
> 前置：M1.2 已实施。设计讨论结论：压缩 = 全量交给模型总结（无保留尾巴、无淘汰、无硬丢弃）；
> usage 持久化、不做成本（钱）；`*`/`**` 等议题见 ADR-0010（匹配）与本 spec（压缩）。

## 1. 压缩机制重构（唯一路径：全量交接总结）

```
循环开头估算 context，超窗口 80% → compacting 态
  → 把【整个 context】交给模型总结（无 keep=N、无淘汰、无硬丢弃兜底）
  → context 替换为一条消息：[对话已压缩——以下是此前上下文的结构化摘要]（user 角色）
  → history 纹丝不动（R1）；emit compaction { before, after, source }
  → 失败（LLM 出错 / 摘要为空）→ 不降级：异常上抛 → 轮次以 error 收尾（诚实失败，可 /compact 重试）
```

- **结构化交接提示词**（summarize 专用 system prompt，独立于 agent 系统提示词）：摘要必须是一份
  「任务交接文档」——保留任务目标/已完成步骤/涉及文件路径/重要决策及理由/未完成事项/用户偏好，
  结构化条目、中文、不编造；maxOutput 提升到 2000。摘要提示词工程是本里程碑的核心学习点：
  「可能丢信息」的 mitigation 全在这份提示词的质量里；
- **无叠加劣化**：下次压缩是对 [摘要_v1 + 新对话] 的重新完整总结，每代都基于完整可见信息；
- **顺带消灭旧隐患**：keep=4 的切缝可能拆散 assistant(tool_calls)/tool 配对（OpenAI 400）——
  全量替换后不存在切缝；
- **删除**：`splitForCompaction`（keep=4）、`enforceContextLimit`（硬丢弃 = 用户明确反对的淘汰）、
  自动压缩失败的「降级继续」（避免失败后逐轮重试压缩的死循环）——三者连同测试一并移除；
- 手动 `/compact` 与自动走同一路径（force 只跳过阈值检查）。

## 2. usage 链路（把闲置的 finished.usage 接上真数据）

```
请求体 stream_options:{include_usage:true} → SSE 末尾 chunk.usage → parser 捕获
  → done 事件带 LlmUsage{promptTokens,completionTokens,totalTokens} → ChatResult
  → loop 轮内累计 → finished { usage } + LoopResult.usage
  → conversation 会话累计（持久化）+ lastTurn
  → status_state.usage（会话累计）/ context_state.lastTurn（上轮实际 vs 本轮估算并排）
```

- 归一化类型 `LlmUsage`（promptTokens/completionTokens/totalTokens），OpenAI snake_case 在 parser 转换；
- **持久化**：会话文件增 `usage: { promptTokens, completionTokens, turns }`（resume 续计）；
- **v1 不做钱**：单价配置列为后续可选；
- 估算与实际并排展示——估算器的准确度从此可见（学习点）。

## 3. /context 仪表盘

`context_state` 增可选字段（向后兼容）：

```ts
breakdown?: { system: number; user: number; assistant: number; tool: number; tools: number }
lastTurn?: { promptTokens: number; completionTokens: number }
sessionUsage?: { promptTokens: number; completionTokens: number; turns: number }
compactions: number
```

- breakdown 为 `context/token/breakdown.ts` 纯函数（按角色估算分段 + system + 工具 schema）；
- TUI /context 面板与 WebUI Context 卡片渲染分段、上轮实际 vs 本轮估算、会话累计与压缩次数。

## 4. 非目标

精确 tokenizer（继续粗估 + 实际对照校准）、定价与成本（钱）配置、prompt cache、
`stream_options` 之外的多协议 usage 兼容（仅 OpenAI 协议）、压缩提示词的用户自定义。

## 5. 测试策略

| 范围 | 方式 |
|---|---|
| Compactor | 全量总结路径、force/阈值、空 context、空摘要抛错、失败上抛 |
| parser | 末尾 chunk.usage 捕获并随 done 下发 |
| request | stream_options 存在 |
| breakdown | 纯函数分段估算 |
| session | usage/compactions 持久化 roundtrip、旧会话无字段容忍 |
| 表征 | 手动压缩场景适配；压缩失败 → 轮次错误 |

## 6. 批次

| 批次 | 内容 |
|---|---|
| U1 | 压缩重构（全量总结 + 删 split/enforce + 结构化提示词 + 失败语义）+ 测试 |
| U2 | usage 链路（llm → loop → finished → 会话累计持久化 → status_state）+ 测试 |
| U3 | breakdown + context_state 契约 + TUI/WebUI 仪表盘 + 文档同步（learning 04/07、ADR-0011、根设计文档） |
