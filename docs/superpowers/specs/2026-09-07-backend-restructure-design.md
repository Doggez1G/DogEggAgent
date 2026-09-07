# 后端纵切重构设计（对抗式推导终版）

> 状态：实施中
> 日期：2026-09-07
> 前置：OOP 类化重构（2026-09-07）已完成；本设计经「提案 ↔ 攻击」三轮对抗迭代产出
> 五条验收要求：合理性 / 规范性 / 功能正确性 / 可维护性 / 可扩展性（含未来 SDK 化）

## 1. 推导方法

先从需求独立推导（不参考现状）→ Design 0 → 三轮对抗攻击 → 终版 → 与现状做差。**差值即重构内容**。墓地（被否决方案）：企业分层目录、事件总线、每命令 Handler 类、预防性接口提取、DI 容器、按行数合并文件、tools 平铺。

## 2. 七个本质概念与归属

Turn（一轮对话）/ Working Set（工作集）/ Tool / Permission / Provider / Session / Event。检验标准：每个概念在结构中有唯一归属。

## 3. 终版结构（agent 包）

```
agent/src/
├─ index.ts  agent.ts  ctx.ts
├─ turn/       index.ts  turn-runner.ts  loop.ts  tool-executor.ts
│              state.ts  pending.ts  compactor.ts  summarize.ts  types.ts
├─ session/    index.ts  conversation.ts  store.ts  manager.ts
├─ config/     index.ts  store.ts（收编 find）  resolve.ts  controller.ts
│              editor/{editor,mutate,paths,validate}.ts
├─ tools/      index.ts  registry.ts  types.ts
│              read_file/{index,schema,tool}  write_file/…  edit_file/…
│              shell/{index,schema,tool}  support/{interpreter,kill-tree}.ts
├─ llm/        index.ts  types.ts  client-for.ts
│              provider/openai/{index,openai-client,request,stream,retry,errors,parser}
├─ context/    index.ts  assembler.ts  truncate.ts
│              prompt/{index,load,builtin}  token/{index,estimate,budget,enforce}
│              compaction/{index,trigger,split}
├─ permission/ index.ts  manager.ts（原 runtime.ts）  classify.ts（下沉 bridge 后仅剩 wrapper？否——见 §5）
└─ shared/     index.ts  logger.ts  gate.ts  support.ts（errors + id）
```

**关键归位**：core/ + loop/ 解体为 turn/（一次提交的故事在同一个文件夹）；conversation 迁 session/（数据与生命周期同居）；压缩按策略/机制分离（编排 Compactor + summarize → turn/，纯策略 trigger/split/enforce → context/）；gate 归 shared（agent 级并发状态，turn 与 session 都要读）；分类文件夹成立条件 = ≥2 文件或扩展位（message/、resolve/ 单文件文件夹降级为文件）。

## 4. 所有权：ctx 普通对象 + 值传递

```ts
// ctx.ts —— 全部可变状态的唯一持有者（无方法的普通对象）
interface AgentContext {
  config: Config                 // config 编辑时整体替换
  permission: PermissionManager  // 同上
  assembler: ContextAssembler    // 同上
  machine: StateMachine          // 全项目唯一状态机（只 fire，不替换）
  gate: BusyGate                 // 并发闸门
}
```

- 控制器持 ctx 稳定引用、调用时读——accessor 探针（旧 turn-runner 的 6 个闭包）结构性消灭。
- **派生值在命令时刻解析成值传入**：`submit(text, params)` / `compact(params)`——provider 解析三处（current/turnParams/summarize）归一为 agent.ts 的 `resolveTurnParams()` 一处。
- `summarize` 闭包闭合在 ctx 上（调用时读当前配置），构造一次传给 Compactor 单例。
- 状态机归一：loop 与 agent 的 emitState fire 同一台 `ctx.machine`，`machine.sync()` 删除；emit() 纯化为「转发 + 日志」。
- **SDK 接缝（预留）**：`requestPermission` 回调已是策略注入点（无头 SDK 可注入程序化决议）；turn/session/config 各自的控制器命令面即未来 SDK 门面的分组依据。

## 5. 契约卫生

- `classifyPermission` 下沉 bridge（`contract/permission.ts`）——它是 permission schema 的纯派生判断，与 isConfigured 同类；ui 的 11 行副本删除。
- `COMPACTION_THRESHOLD` 留在 bridge 并注释立法：跨端显示策略常量（UI 进度条变色依赖），刻意放契约防漂移。
- server 删幽灵依赖 `@dogegg/agent`；根删遗留入口 main.ts。

## 6. 依赖矩阵（进 architecture.test）

```
turn     → session, config, llm, tools, context, permission, shared
session  → config, shared           （禁止 session → turn：TurnDelta 结构类型解耦）
能力模块 → 只依赖 shared / bridge（context → 无内部依赖；compact 策略 → token）
agent(根) → 全部
```

barrel 单入口立法：跨域 import 只走域门面（`'../config'`），分类文件夹 index 仅供域内。

## 7. 行为保障

5 个表征测试 + 172 全量测试全程锁定对外行为（消息序列 / 会话格式 / 压缩语义 / 状态事件序列零变化）。状态机归一的等价性论证：fire 顺序不变，VALID_FROM 幂等保证双机变单机序列等价。

## 8. 批次

| 批次 | 内容 | 风险 |
|---|---|---|
| A | 杂屑与契约（main.ts / 幽灵依赖 / classify 下沉 / 立法注释） | 低 |
| B | 纵切重组（turn/ 成立、core+loop 解体、conversation→session、归类修正、barrel 立法） | 中（纯移动） |
| C | 所有权收敛（ctx + 值传递、状态机归一、emit 纯化） | 中 |
| D | 规范测试化（矩阵 + barrel 进架构测试）+ 文档同步 | 低 |
| UI 批次 | overlays/ + hooks/ + theme registry + tui/chat 空壳 | 下次 |
