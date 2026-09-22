# 02-设计实现

回答「DogEggAgent 是怎么实现的」：按子系统逐一展开的**子系统级设计文档**——每篇给出职责与边界、核心数据结构（真实字段/类型形状）、**设计逐项详解**（编号设计项 `D-N`：设计问题 → 方案与取舍 → 真实代码摘录逐段走查（标注源码 file:line，摘录逐字取自源文件）→ mermaid 流程图/时序图/状态图）、关键立法与不变量、失败模式与恢复、与其它子系统的接缝。所有描述对照真实代码，禁止想当然；跨版本的语义决策以 `docs/adr/` 为唯一权威，本文档引用并摘要。

**总架构交互图**：[architecture-overview.html](./assets/architecture-overview.html)——四包职责、两个组合根（bin/dogegg.ts 与 main-web.ts）、双通道（InMemory 同步 / SSE+zod）与消息流向的全景。

## 阅读顺序

建议按依赖方向阅读：先看全局（01），再看后端主干（02→03→04→05→06→07→08→09→10），最后两个前端（11→12）。只关心某一子系统也可独立跳读——每篇自带该子系统的完整上下文与源码索引。

| # | 文档 | 一句话 | 源码根 | 交互图 |
|---|---|---|---|---|
| 01 | [四包架构与消息契约](./01-四包架构与消息契约.md) | 四包解耦立法、上行/下行消息全清单、双通道差异 | bridge/src、bin/dogegg.ts、main-web.ts | [架构总览](./assets/architecture-overview.html) |
| 02 | [对话轮次引擎](./02-对话轮次引擎.md) | 状态机全转移表、AgentLoop 循环、压缩管线八步、取消双机制、自动标题 | agent/src/turn/ | — |
| 03 | [LLM 接入层](./03-LLM接入层.md) | LlmStreamEvent 七事件、SSE 行驱动解析、两级超时、重试退避 | agent/src/llm/ | — |
| 04 | [工具注册表与合规关口](./04-工具注册表与合规关口.md) | register 三动作（合规哈希/冲突抛错/身份记录）、labelsWhere 摘除 | agent/src/tools/registry.ts | — |
| 05 | [内建工具集](./05-内建工具集.md) | 7 工具逐个：参数 schema、唯一命中算法、超时树杀、探索三件套、输出治理四层 | agent/src/tools/ | — |
| 06 | [权限引擎](./06-权限引擎.md) | classifyPermission 逐桶求值、双分支匹配、会话提升生命周期、加载期两条校验 | bridge/contract/permission.ts、agent/src/permission/ | [权限判定](./assets/permission-decision.html) |
| 07 | [MCP 客户端](./07-MCP客户端.md) | rebuild diff 算法、两种 transport、1s 竞速关连接、身份注册与按服务隔离 | agent/src/mcp/ | [MCP 生命周期](./assets/mcp-lifecycle.html) |
| 08 | [技能系统](./08-技能系统.md) | 三态合成（扫描∪名单孤儿）、旁挂名单容错、渐进披露、$ARGUMENTS 渲染 | agent/src/skills/ | — |
| 09 | [会话与持久化](./09-会话与持久化.md) | 存档 JSON 逐字段、resume 恢复链、删除当前会话接管、用量双口径 | agent/src/session/ | — |
| 10 | [配置体系与编辑器](./10-配置体系与编辑器.md) | schema 全字段、loadConfigOrExit 失败路径、强类型操作解析、zod 校验回滚 | bridge/contract/config.ts、agent/src/config/ | — |
| 11 | [TUI 架构](./11-TUI架构.md) | Static/动态分层立法、View 联合类型与按键分派、弹层 returnView 链、ref 镜像教训 | ui/src/tui/ | — |
| 12 | [WebUI 架构](./12-WebUI架构.md) | SSE 客户端校验、六数据域 hook、信息面板八卡、设置五区、shared 层对称 | ui/src/webui/、ui/src/shared/ | — |

## 全局立法速查（各篇详述）

- **四包解耦**：agent ←→ bridge ←→ ui；server 不 import ui（前端是静态文件）；只有组合根 import agent 与前端——由 `bridge/test/architecture.test.ts` 的断言强制（01）。
- **R1 双写分离**：history（完整原文，永不压缩）与 context（发给模型，可压缩）分开持有（02、09）。
- **R2 并发闸门**：BusyGate 保证同一时刻至多一个"动 context"的操作（02）。
- **统一关口**：一切工具经注册表（合规转换/冲突可见失败/身份记录，04）与权限引擎（reject > 会话提升 > ask > allow > 默认 ask，06）。
- **诚实失败**：压缩失败转 error 不降级（02）；工具失败回填模型不炸轮次（05）；拒绝/失败也发 tool_end（01 契约 INV-7）。
- **配置不兼容演进**：格式即版本，无迁移机器（ADR-0013）；加载失败人话报错不覆写（10）。

## ADR 索引

语义决策的**唯一权威**在 `docs/adr/`；下表给出与本文各子系统的对应关系。

| ADR | 决策 | 相关文档 |
|---|---|---|
| [0001](../../../adr/0001-sse-post-transport.md) | WebUI 传输：SSE 下行 + POST 上行（非 WebSocket/IPC） | 01、12 |
| [0002](../../../adr/0002-sse-channel-in-server.md) | SSE Channel 归 server 包（bridge 保持零传输依赖） | 01 |
| [0003](../../../adr/0003-block-semantic-refactor.md) | Block 语义化（kind + colorToken），reducer 下沉 shared 双端共用 | 11、12 |
| [0004](../../../adr/0004-set-cwd-runtime.md) | 运行时 cwd 切换（set_cwd 消息） | 02、09 |
| [0005](../../../adr/0005-single-session-webui.md) | WebUI 单会话模式 | 09 |
| [0006](../../../adr/0006-session-cwd-persistence.md) | 会话 cwd 持久化 + 项目/会话树 | 09、12 |
| [0007](../../../adr/0007-thinking-persistence.md) | 思考内容持久化（独立 thinking 字段，不进上下文） | 02、03、09 |
| [0008](../../../adr/0008-tui-static-architecture.md) | TUI Static 架构（终端原生滚动） | 11 |
| [0009](../../../adr/0009-no-chalk-level-override.md) | 禁止设置 chalk.level（全局颜色污染） | 11 |
| [0010](../../../adr/0010-permission-matching-semantics.md) | 权限匹配：锚点作用域 + 按主参数分派 | 06、10 |
| [0011](../../../adr/0011-compaction-full-handover-summary.md) | 压缩 = 全量交接总结（无保留尾巴、无淘汰） | 02 |
| [0012](../../../adr/0012-mcp-permission-identity.md) | MCP 权限服务键按身份匹配 + 注册表合规关口 | 04、06、07 |
| [0013](../../../adr/0013-permission-v3-no-compat.md) | 权限配置 v3 结构化、不做旧版兼容 | 06、10 |
