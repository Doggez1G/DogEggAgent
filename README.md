# DogEggAgent

[![npm version](https://img.shields.io/npm/v/dogegg-agent.svg)](https://www.npmjs.com/package/dogegg-agent)
[![node](https://img.shields.io/node/v/dogegg-agent.svg)](https://www.npmjs.com/package/dogegg-agent)
[![CI](https://github.com/Doggez1G/DogEggAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/Doggez1G/DogEggAgent/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dogegg-agent.svg)](./LICENSE)

一个面向学习的代码编辑 Agent：后端（agent 核心）与前端（TUI / WebUI）完全解耦，通过 bridge 契约 + Port 通道互通。给它一个终端和一份 API 配置，它就能读懂你的项目、改代码、跑命令——每一步都向你请求授权。

## 功能

- **七个内置工具**：读类 `read_file` / `ls` / `glob` / `grep`（探索免审批）+ 写类 `write_file` / `edit_file` / `shell`；grep 四层输出治理保证回执上界；文件写入原子化（tmp + rename，中断不损坏原文件）
- **参数化权限审批（v3）**：allow / reject / ask 三桶，规则 = `{ whole, patterns }`——shell 按 `"git *"` 命令前缀、文件类按 `"./docs/**"` 目录范围限定；MCP 服务键 `mcp:<服务名>` 整组/勾选，按注册期身份匹配；审批四档决策（本次 / 始终 / 对此范围 / 拒绝），`/permissions` 随时查看与撤销；路径按真实位置（realpath）判定，防符号链接逃逸
- **MCP 接入**：stdio / Streamable HTTP 双传输，工具独立注册（命名空间标签 + 合规哈希关口），单服务隔离、启动超时、配置变化 diff 重建；配置放全局或项目级（`.mcp.json`）
- **Skills 技能包**：SKILL.md 主流格式（两级目录、渐进披露、`/技能名` 调用、`$ARGUMENTS`），启停状态旁挂名单（`.skills.json`），三态管理（启用/停用/缺失）
- **会话持久化与崩溃恢复**：多会话管理、断线 resume、推理模型思考持久化、工作目录随会话记忆；轮中检查点（长任务中途崩溃最多丢 15s 进度）+ 配对修补保证恢复后立即可用；会话与配置文件原子写
- **上下文自动压缩**：窗口占用达 80% 自动把旧上下文交给模型总结（保留最近对话），手动 `/compact` 随时可用，`/context` 查看占用明细
- **双前端**：终端 TUI（Ink，原生滚动 + markdown 渲染 + 工具块 diff 展示）与浏览器 WebUI（React + Vite，Cmd+K 命令面板 + 8 section 信息面板 + 三主题设计系统），同一后端同一套能力
- **面向学习的架构**：四包解耦（agent / ui / bridge / server），架构测试守门；680+ 测试、CI 门禁、版本化文档 + 13 个 ADR

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
dogegg -web     # 浏览器 WebUI（http://localhost:3000，可用 PORT 环境变量覆盖）
# 或免安装直接运行
npx dogegg-agent
```

首次使用输入 `/config` 打开配置，添加 provider（name / baseURL / apiKey / model）并保存——之后直接对话即可。

### 从源码开发

```bash
git clone https://github.com/Doggez1G/DogEggAgent.git
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
| `/cd` | 切换工作目录 | `/rename` | 重命名当前会话 |
| `/skills` | 管理 skills | `/mcp` | 管理 MCP servers |
| `/quit` | 退出 | `/help` | 显示帮助 |

### 权限模型

工具调用按三桶分类：`allow` 自动放行、`reject` 直接拒绝、其余默认 `ask` 弹层审批——审批时可预览将要执行的内容（edit_file / write_file 显示 diff，shell 显示命令），并支持第四档「对此范围不再询问」（如 `./docs/**` 目录或 `git *` 命令前缀）。优先级：reject > 会话提升 > ask > allow > 默认询问。授权随会话持久化，`/permissions` 随时查看与撤销；新建会话授权清空，切换会话保留。

### MCP 与 Skills

- `/mcp`：添加 / 启停 / 删除 MCP server（stdio 或 Streamable HTTP），配好后它的工具自动进入模型可用清单，按 `mcp:<服务名>` 维度授权；
- `/skills`：管理 `~/.dogegg/skills`（用户级）与项目级技能包，`/技能名` 直接调用，启停即时生效（系统提示词与上下文占用同步刷新）。

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
| `@dogegg/bridge` | 消息契约（AgentToUiMessage / UiToAgentMessage）+ Config zod schema + 消息 zod 校验 schema + 契约级纯函数（权限判定 / glob / 消息配对修补）+ Port 接口 |
| `@dogegg/agent` | 后端域：agent.ts / ctx.ts 门面 + turn / context / llm / tools / session / permission / skills / mcp / config / shared |
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
| `npm run test:run` | Vitest 跑四包测试（CI 门禁同款，windows-latest） |
| `npm run dev` | TUI 开发（build + start） |
| `npm run dev:web` | WebUI 开发（Vite + tsx） |
| `npm run build` | 统一 CLI 构建（esbuild → dist/dogegg.js，含 TUI + WebUI server） |
| `npm run build:web` | WebUI 前端构建（Vite → dist/web/） |

### 文档

- [版本化文档 v0.2](docs/versions/0.2/README.md) — **需求分析（9 功能域）/ 设计实现（12 篇 + 交互图）/ 用户手册 / 学习指南（13 章）**，与 0.2 代码同步
- [ADR 记录](docs/adr/) — 13 个架构决策记录（权限语义、压缩策略、TUI Static 架构等）
- [学习指南（v0.1 存档）](docs/learning/) — 早期章节，部分内容已过时（以版本化文档为准）
- [历史设计文档](docs/superpowers/specs/) — 各阶段设计 spec（部分已被 ADR 修订，见各自头部标注）
- [架构审查报告](docs/architecture-review-2026-09-01.html) — 全量审计 ~126 模块，8 个改进候选

## License

[MIT](LICENSE)
