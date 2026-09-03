# DogEggAgent 实现详解 · 系列目录

> 本系列文档供学习 code agent 的实现机制而写，结合实际代码逐模块讲解。
> 阅读顺序建议从上到下——后面的章节依赖前面的概念。

## 章节列表

| 章节 | 标题 | 核心概念 |
|---|---|---|
| [01](./01-architecture.md) | 整体架构与多包解耦 | workspaces、bridge 契约、Port 通道、组合根 |
| [02](./02-state-machine.md) | 10 态状态机 | 纯函数迁移、VALID_FROM 守卫、迁移事件 |
| [03](./03-agent-loop.md) | Agent Loop 核心循环 | 问模型→串行工具→回填→再问、中断保存、自动压缩 |
| [04](./04-tools.md) | 工具系统 | 双 schema、串行执行、权限分支、取消三件套 |
| [05](./05-llm.md) | LLM 接入层 | 原生 fetch+SSE、流式解析器、重试退避、adapter 分派 |
| [06](./06-context-compaction.md) | 上下文管理与压缩 | History/Context 分离、token 估算、阈值触发、手动/自动压缩 |
| [07](./07-session-permission.md) | 会话持久化与权限模型 | 原子写、旧格式迁移、三桶权限、会话隔离、授权持久化 |
| [08](./08-config.md) | 配置系统 | zod schema、树形编辑器、路径解析、事务回滚 |
| [09](./09-tui.md) | TUI 前端 | Ink 渲染、reducer、视口滚动、键盘路由、联想补全 |
| [10](./10-design-patterns.md) | 跨切面设计模式 | 依赖注入、error-as-value、discriminated union、模块边界 |

## 项目定位

DogEggAgent 是一个自研的**代码编辑型 agent**，第一目标是**学习并理解 agent 的实现**。技术栈：TypeScript / Node.js ≥ 20，npm workspaces 四包，Ink TUI + React DOM WebUI，zod 校验（含消息 zod schema），JSON 持久化，原生 `fetch` + 手写 SSE，react-markdown + rehype-highlight 语法高亮。

核心问题：**一个 code agent 是怎么工作的？**

- 模型怎么流式返回？（SSE 解析）
- 工具怎么调用？（串行执行 + 权限审批）
- 上下文太长怎么办？（History/Context 分离 + 压缩）
- 用户怎么交互？（TUI + 消息契约 + Port 解耦）
- 怎么打断？（AbortController + killTree + checkCancelled）

这些文档会逐一回答。
