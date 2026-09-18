# DogEggAgent 实现详解 · 系列目录

> 本系列供学习 code agent 的实现机制而写：结合当前实际代码逐模块讲解，代码片段均摘自源码。
> 与本系列配套的设计文档在 `docs/superpowers/specs/`（纵切重构：2026-09-07-backend-restructure-design.md）。
> 阅读顺序从上到下——后面的章节依赖前面的概念。

## 章节列表

| 章节 | 标题 | 核心概念 |
|---|---|---|
| [01](./01-architecture.md) | 全局架构与一次提交的旅程 | 四包、依赖方向、Port、组合根、链路走读 |
| [02](./02-agent-facade.md) | 门面与 ctx | Agent 类、可变状态唯一持有者、emit、值传递、所有权教训 |
| [03](./03-turn.md) | turn：一轮对话的完整故事 | 10 态状态机、主循环、工具执行、权限三分支、取消、R1 双写 |
| [04](./04-compaction.md) | 压缩：策略与机制的分离 | 80% 阈值、keep=4、force 语义、硬上限兜底、R1 铁律 |
| [05](./05-session.md) | session：工作集与持久化 | history/context 分离、原子写、旧格式迁移、生命周期 |
| [06](./06-tools.md) | tools：工具域与扩展模板 | Tool 契约、双 schema、活注册表、shell support、R3 |
| [07](./07-llm.md) | llm：模型接入层 | LlmClient、conn 归实例、手写 SSE、错误分级重试 |
| [08](./08-config-permission.md) | config 与 permission | 宽容加载、快照回滚、两层权限、会话隔离 |
| [09](./09-bridge-server-ui.md) | bridge、server 与前端 | 消息即 API、双通道实现、HTTP 安全四件套 |
| [10](./10-conventions.md) | 规范与扩展 | 三层 taxonomy、依赖矩阵、扩展位模板、SDK 接缝、已接受债 |
| [11](./11-skills-mcp.md) | Skills 与 MCP | 自有目录体系 + Agent Skills 格式、官方 SDK Client、双通道触发、CRUD 面板 |

## 快速开始读代码

```bash
npm run test:run                                # 全量测试（370）
npx vitest run agent/test/agent.turn.test.ts    # 表征测试：agent 对外行为的活样本
npm run build && node dist/dogegg.js            # 真机跑 TUI
```

带着「输入什么、吐什么」的体感读源码，从 [03 turn](./03-turn.md) 开始。
