# DogEggAgent

一个面向学习的代码编辑 Agent：后端（agent 核心）与前端（TUI / WebUI）完全解耦，通过 bridge 契约 + Port 通道互通。

## 项目特点

- **四包解耦架构**：`agent` / `ui` / `bridge` / `server`，通过 bridge 消息契约 + Port 通道关联，互不 import
- **双前端**：TUI（Ink v7 + React）+ WebUI（React DOM + Vite），共享 `ui/src/shared/` 平台无关逻辑
- **SSE + POST 传输**：WebUI 通过 HTTP SSE 下行 + POST 上行与 Agent 通信，静态文件由 server serve
- **10 态状态机**：纯函数迁移，VALID_FROM 守卫，非法状态组合是 no-op
- **History / Context 双持久化**：History 是完整原文（永不压缩），Context 是发给模型的消息（会压缩）
- **三桶权限模型**：allow / reject / ask，会话级 allow_always 授权，默认 ask（安全）
- **三主题设计系统**：Midnight（暗 Zinc+Indigo）/ Forest（暗 Slate+Green）/ Dawn（亮），CSS 变量 + CSS Modules
- **Cmd+K 命令面板** + **8 section 信息面板** + **IDE 风格设置** + **react-markdown 语法高亮**

## 快速开始

### 环境要求

- Node.js >= 20
- npm（随 Node 安装）

### 安装

```bash
git clone <repo-url>
cd DogEggAgent
npm install
```

### WebUI 开发模式

```bash
npm run dev:web
```

启动 Vite dev server（HMR）+ tsx 跑后端 server。浏览器打开 `http://localhost:5173`。

首次使用需要配置 LLM provider：输入 `/config` 打开设置，添加 provider（name / baseURL / apiKey / model）。

### TUI 模式

```bash
npm run dev
```

### 生产构建

```bash
# 统一 CLI 入口（dogegg 命令）
npm run build          # esbuild -> dist/dogegg.js (含 TUI + WebUI server)
npm run build:web      # Vite build -> dist/web/ (WebUI 静态前端)
npm run start          # dogegg -> TUI
npm run start:web      # dogegg -web -> WebUI

# 全局安装
npm link               # 注册 dogegg 命令
dogegg                 # 任意目录启动 TUI
dogegg -web            # 任意目录启动 WebUI
```

## 架构概览

```
                    +-------------+
                    | bin/dogegg.ts |  统一 CLI 入口 (dogegg → TUI, dogegg -web → WebUI)
                    +------+------+
                 装配 |  | 装配
              +--------+  +--------+
              | agent  | <消息> |  ui   |
              +---+----+      +---+----+
                  +------+--------+
              +----------+----------+
              |      bridge         |  契约 + Port 通道
              +----------+----------+
                    +-----+------+
                    |   server   |  HTTP + SSE + REST (WebUI)
                    +------------+
```

### 包结构

| 包 | 说明 |
|---|---|
| `@dogegg/bridge` | 消息契约（AgentToUiMessage / UiToAgentMessage）+ Config zod schema + 消息 zod 校验 schema + Port 接口 |
| `@dogegg/agent` | 后端域：core（agent/state/pending）/ loop / context / llm / tools / session / permission / config / shared |
| `@dogegg/ui` | 前端域：tui（Ink）/ webui（React DOM + Vite）/ shared（reducer/block/commands/status/permission/command-feedback） |
| `@dogegg/server` | HTTP server + SSE channel + REST 端点（fs/shells）+ 静态文件服务 |

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
- [实现详解系列](docs/learning/) — 12 章逐模块讲解（架构 / 状态机 / Agent Loop / 工具 / LLM / 上下文 / 会话 / 配置 / TUI / 设计模式 / WebUI / Server）
- [ADR 记录](docs/adr/) — 7 个架构决策记录

## License

[MIT](LICENSE)
