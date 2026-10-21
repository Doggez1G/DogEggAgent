# 04-学习指南

面向「想深入理解 DogEggAgent 源码」的学习者：全部章节**对照当前代码逐模块讲解**，引用真实文件路径与关键代码形状，不讲历史沿革。读完本指南，你应该能独立回答「一条用户消息从回车到落盘经历了哪些函数」这类问题。

## 学习路径建议（推荐阅读顺序及理由）

1. **01-项目是什么** —— 建立「这是什么、长什么样」的全景，知道四包目录里各有什么，后续读代码才有地图。
2. **03-包结构与依赖** —— 先立规矩再看内容：四包依赖立法（agent↔bridge←ui、server→agent+bridge）与 barrel-only import 是全仓最硬的约束，理解它之后读任何文件的 import 都有判断依据。
3. **04-消息契约** —— 契约是 agent 与两个 UI 的唯一公共语言，后面所有章节的消息（submit/permission_request/tools_list…）都出自 `bridge/src/contract/`。
4. **02-一条消息的旅程**（核心章）—— 带着 03/04 的底子，沿一条消息走完全链路：submit → 状态机 → LLM 流式 → 工具 → 权限 → 回填 → 落盘。这一章把 agent 包的全部模块串起来。
5. **05-配置系统 → 06-权限系统 → 07-工具系统** —— 旅程途中遇到的三座大山逐个拆解；权限与配置耦合最深（v3 三桶），建议连读。
6. **08-MCP客户端 → 09-技能系统** —— 两个「扩展机制」，都通过工具注册表/系统提示注入与主链路汇合。
7. **10-会话与持久化** —— 回头看旅程终点的落盘与 resume。
8. **11-TUI → 12-WebUI** —— 前端两兄弟，对照读能看出「同一契约、两种渲染」的对称性。
9. **13-测试与工程实践** —— 收尾：测试怎么组织、接缝在哪、架构怎么被测试强制。

## 前置知识

- **TypeScript**：类型别名/判别联合（`type A = | {kind: 'x'} | {kind: 'y'}`）、`satisfies`、`Record`/`ReadonlySet`。全仓 ESM（`"type": "module"`）。
- **React**：函数组件、`useState`/`useEffect`/`useRef`/`useCallback`、受控组件。两端 UI 都是 React。
- **Ink**（仅 TUI）：React 渲染到终端；`<Static>` 一次性打印、`useInput` 键盘事件、raw mode。
- **Node**：`node:fs`/`node:path`/`node:child_process`（spawn/进程树）、`node:http`、`EventSource`/SSE、`AbortController` 取消。
- **zod**：schema 定义与 `parse`/`safeParse`。所有配置与消息校验都靠它。

不要求事先懂 MCP 或 Agent Skills 规范——08/09 两章会从源码视角讲清本项目用到的那部分语义。

## 如何跑起来对照源码

```bash
npm install          # npm workspaces，四包一次装齐
npm run build        # esbuild 打包 dist/dogegg.js（bin/dogegg.ts 为入口）
npm run dev          # 构建 + TUI 启动（读 .dogegg.json 或 ~/.dogegg/config.json）
npm run dev:web      # WebUI 开发模式：tsx main-web.ts 起 server(3001) + vite 前端热更
npm test             # vitest watch；npm run test:run 单次全量（76 个测试文件）
npm run typecheck    # 四包 tsconfig 各自 noEmit 检查
```

对照源码的建议动线：在 TUI 里发一条「帮我列出 src 下的文件」，同时打开断点/日志追踪 `agent/src/agent.ts` 的 `send()` → `turn/turn-runner.ts` 的 `runTurn()` → `turn/loop.ts` 的 `run()`。`~/.dogegg/logs/<session-id>.log` 里有按消息类型分 scope 的埋点（见 `agent/src/shared/logger.ts`）。

两条阅读心法：其一，**读类头注释**——本仓的关键立法几乎都写在文件头（如 `agent/src/tools/registry.ts` 的「统一关口立法」、`bridge/src/contract/permission.ts` 的「优先级立法」），注释与代码同源维护；其二，**改一行跑架构测试**——`npm test` 里的 `bridge/test/architecture.test.ts` 会立刻告诉你有没有踩边界，是理解约束最快的方式。

## 全章索引

| 章 | 内容 | 主战场 |
|---|---|---|
| [01-项目是什么](01-项目是什么.md) | 产品定位、能力全景、目录一览 | 顶层 + 四包 src |
| [02-一条消息的旅程](02-一条消息的旅程.md) | submit → 状态机 → LLM → 权限 → 工具 → 落盘 | agent/src/turn |
| [03-包结构与依赖](03-包结构与依赖.md) | 四包职责、依赖立法、架构测试 | bridge/test/architecture.test.ts |
| [04-消息契约](04-消息契约.md) | contract 分层、消息种类、双通道 | bridge/src |
| [05-配置系统](05-配置系统.md) | config.json、加载/编辑器/回滚 | agent/src/config |
| [06-权限系统](06-权限系统.md) | 三桶 v3、服务键、会话提升、realpath | bridge + agent/permission |
| [07-工具系统](07-工具系统.md) | Tool 契约、注册表关口、7 内建工具 | agent/src/tools |
| [08-MCP客户端](08-MCP客户端.md) | rebuild diff、双 transport、身份注册 | agent/src/mcp |
| [09-技能系统](09-技能系统.md) | 两级扫描、渐进披露、旁挂名单 | agent/src/skills |
| [10-会话与持久化](10-会话与持久化.md) | 存档、resume、删除接管、项目分组 | agent/src/session |
| [11-TUI](11-TUI.md) | Static 分层、view-state、keys 模式、主题 | ui/src/tui |
| [12-WebUI](12-WebUI.md) | hooks 数据域、SSE 校验、组件分层 | ui/src/webui |
| [13-测试与工程实践](13-测试与工程实践.md) | vitest 组织、接缝注入、提交规范 | 各包 test/ |

> 本指南与 `02-设计实现/`（设计视角的十篇）互补：设计篇讲「为什么这样设计」，本篇讲「代码现在长什么样、怎么读」。两处引用的源码以当前仓库为准，若文档与代码冲突，以代码为准并欢迎修正文档。
