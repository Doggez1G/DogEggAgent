# DogEggAgent

[![npm version](https://img.shields.io/npm/v/dogegg-agent.svg)](https://www.npmjs.com/package/dogegg-agent)
[![node](https://img.shields.io/node/v/dogegg-agent.svg)](https://www.npmjs.com/package/dogegg-agent)
[![license](https://img.shields.io/npm/l/dogegg-agent.svg)](./LICENSE)

一个面向学习的代码编辑 Agent：后端（agent 核心）与前端（TUI / WebUI）完全解耦，通过 bridge 契约 + Port 通道互通。给它一个终端和一份 API 配置，它就能读懂你的项目、改代码、跑命令——每一步都向你请求授权。

## 功能

- **四个内置工具**：`read_file` 读取文件 / `write_file` 写入文件 / `edit_file` 精准替换代码 / `shell` 执行命令（跨平台解释器、超时自动杀进程树）
- **权限审批**：allow / reject / ask 三桶分类，敏感操作弹层审批（edit_file / write_file 预览 diff，shell 预览命令）；「始终允许」会话内免重复审批，`/permissions` 随时查看与撤销
- **会话持久化**：多会话管理、断线 resume、推理模型思考内容持久化；工作目录随会话记忆
- **上下文自动压缩**：窗口占用达 80% 自动把旧上下文交给模型总结（保留最近对话），手动 `/compact` 随时可用，`/context` 查看占用
- **双前端**：终端 TUI（Ink，原生滚动 + markdown 渲染 + 工具块 diff 展示）与浏览器 WebUI（React + Vite，Cmd+K 命令面板 + 8 section 信息面板），同一后端同一套能力
- **面向学习的架构**：四包解耦（agent / ui / bridge / server），消息契约 + Port 通道互通；250+ 测试、架构测试守门、10 章实现详解文档

## 快速开始

### 环境要求

- Node.js ≥ 20.11
- 一个 OpenAI 兼容的 LLM API（baseURL + apiKey + model）

### 安装与启动

```bash
npm install -g dogegg-agent
cd 你的项目目录
dogegg          # 终端 TUI
# 或
dogegg -web     # 浏览器 WebUI（http://localhost:3000）
# 或免安装直接运行
npx dogegg-agent
```

首次使用输入 `/config` 打开配置，添加 provider（name / baseURL / apiKey / model）并保存——之后直接对话即可。

### 从源码开发

```bash
git clone https://gitcode.com/Doggez1G/DogEggAgent.git
cd DogEggAgent
npm install

npm run dev       # 构建 + 启动 TUI
npm run dev:web   # Vite dev server + 后端（http://localhost:5173）
```

### 生产构建

```bash
npm run build          # esbuild → dist/dogegg.js（含 TUI + WebUI server）
npm run build:web      # Vite → dist/web/（WebUI 静态前端）
npm run start          # 本地产物：TUI
npm run start:web      # 本地产物：WebUI
```

## 使用

### 斜杠命令

| 命令 | 说明 | 命令 | 说明 |
|---|---|---|---|
| `/config` | 编辑配置 | `/new` | 新建会话 |
| `/session` | 切换会话 | `/model` | 快速切换模型 |
| `/permissions` | 查看/撤销会话授权 | `/compact` | 手动压缩上下文 |
| `/context` | 查看上下文占用 | `/clear` | 清空历史 |
| `/tools` | 列出工具 | `/system` | 查看 system prompt |
| `/status` | 状态一览 | `/log` | 调试日志 |
| `/cd` | 切换工作目录 | `/help` | 显示帮助 |
| `/quit` | 退出 | | |

### 权限模型

工具调用按三桶分类：`allow` 自动放行、`reject` 直接拒绝、其余默认 `ask` 弹层审批——审批时可预览将要执行的内容（edit_file / write_file 显示 diff，shell 显示命令）。选「始终允许」后本会话内不再重复询问，授权随会话持久化，`/permissions` 随时查看与撤销。新建会话授权清空，切换会话保留。

### 上下文压缩

对话过长时（窗口占用达 80%）自动触发压缩：旧上下文交给模型总结成摘要，保留最近几条原文，摘要替换历史后继续对话——原文完整保留在会话文件里，`/compact` 可随时手动压缩，`/context` 查看占用与压缩情况。

## 架构概览

```
                    +--------------+
                    | bin/dogegg.ts |  统一 CLI 入口（dogegg → TUI，dogegg -web → WebUI）
                    +------+-------+
                 装配 |  | 装配
              +--------+  +--------+
              | agent  | <消息> |  ui   |
              +---+----+      +---+----+
                  +------+--------+
              +----------+----------+
              |      bridge         |  消息契约 + Port 通道
              +----------+----------+
                    +-----+------+
                    |   server   |  HTTP + SSE + REST（WebUI 传输层）
                    +------------+
```

### 包结构

| 包 | 说明 |
|---|---|
| `@dogegg/bridge` | 消息契约（AgentToUiMessage / UiToAgentMessage）+ Config zod schema + 消息 zod 校验 schema + Port 接口 |
| `@dogegg/agent` | 后端域：agent.ts / ctx.ts 门面 + turn / context / llm / tools / session / permission / config / shared |
| `@dogegg/ui` | 前端域：tui（Ink）/ webui（React DOM + Vite）/ shared（reducer / block / commands / status / permission / tool-display / command-feedback） |
| `@dogegg/server` | HTTP server + SSE channel + REST 端点（fs / shells）+ 静态文件服务 |

### 核心设计约束

- 后端不 import 前端，前端不 import 后端；二者都只依赖 `bridge/`
- 只有组合根（bin/dogegg.ts；dev:web 另用 main-web.ts）同时 import agent 与前端
- Server 不 import `@dogegg/ui`——前端是静态文件被 serve
- bridge 契约全部可序列化——error 用 `{ message, name? }` 而非 Error 对象

## 开发

### 脚本

| 命令 | 说明 |
|---|---|
| `npm run typecheck` | 五路 tsc（root + agent + ui + bridge + server） |
| `npm run test:run` | Vitest 跑四包测试 |
| `npm run dev` | TUI 开发（build + start） |
| `npm run dev:web` | WebUI 开发（Vite + tsx） |
| `npm run build` | 统一 CLI 构建（esbuild → dist/dogegg.js，含 TUI + WebUI server） |
| `npm run build:web` | WebUI 前端构建（Vite → dist/web/） |

### 文档

- [设计文档](docs/superpowers/specs/2026-08-26-dog-egg-agent-design.md) — 需求清单、状态机、权限模型、消息契约
- [模块化重构设计](docs/superpowers/specs/2026-08-27-modular-refactor-design.md) — 包结构、依赖图、架构测试
- [WebUI 设计](docs/superpowers/specs/2026-08-29-webui-design.md) — 三主题、Primitives、Cmd+K、信息面板
- [架构审查报告](docs/architecture-review-2026-09-01.html) — 全量审计 ~126 模块，8 个改进候选
- [实现详解系列](docs/learning/) — 10 章逐模块讲解（全局架构 / 门面与 ctx / turn / 压缩 / session / tools / llm / config 与 permission / bridge-server-前端 / 规范与扩展）
- [ADR 记录](docs/adr/) — 9 个架构决策记录

## License

[MIT](LICENSE)
