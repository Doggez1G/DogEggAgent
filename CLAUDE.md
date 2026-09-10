# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

DogEggAgent 是一个自研的**代码编辑型 agent**，第一目标是学习并理解 agent 的实现。技术栈：TypeScript / Node.js ≥ 20，npm workspaces 四包（`agent` / `ui` / `bridge` / `server`），Ink TUI + React DOM WebUI 双前端，zod 校验，JSON 持久化，原生 `fetch` + 手写 SSE。

核心架构原则：**后端（agent）与前端（ui）完全解耦，仅通过 `bridge/` 的消息契约 + Port 通道关联**。agent 与 ui 互不 import，都只依赖 `@dogegg/bridge`；唯一同时 import agent 与前端的是 `bin/dogegg.ts`（统一 CLI 组合根；`main-web.ts` 仅 dev:web 开发模式使用）。此规则由 `bridge/test/architecture.test.ts` 强制。

## 包结构

```
DogEggAgent/
├─ bin/dogegg.ts         # 统一 CLI 组合根（dogegg → TUI、dogegg -web → WebUI；唯一同时 import agent 与前端）
├─ main-web.ts           # WebUI 组合根（import agent + server + bridge）
├─ package.json          # workspaces: ["agent","ui","bridge","server"]
├─ tsconfig.base.json    # 共享 compilerOptions
├─ build.mjs             # esbuild（统一 CLI bundle，@dogegg/* 解析插件）
├─ vite.config.ts        # Vite 构建配置（WebUI 前端入口）
├─ agent/                # @dogegg/agent：后端域（agent.ts/ctx.ts 门面 + turn/context/llm/tools/session/permission/config/shared）
├─ ui/                   # @dogegg/ui：前端域（tui + webui + shared）
│  ├─ src/tui/           #   TUI（Ink v7 + React，含 config 编辑器纯函数）
│  ├─ src/webui/         #   WebUI（React DOM + Vite + CSS Modules + Lucide + react-markdown）
│  └─ src/shared/        #   平台无关前端逻辑（reducer / block / commands / status / permission / tool-display / command-feedback）
├─ bridge/               # @dogegg/bridge：契约（消息类型+Config zod schema+isConfigured+消息 zod 校验 schema）+ 通道（Port+in-memory）
└─ server/               # @dogegg/server：HTTP server + SSE channel + REST 端点（fs/shells）+ 静态文件
```

模块 = 文件夹，`index.ts` 是唯一对外脸面（仅 re-export，不写实现）；实现写在兄弟文件。跨模块 import 只指向 index。

## 需求 / 设计文档（单一事实源）

- 需求：`docs/superpowers/specs/2026-08-26-dog-egg-agent-design.md`（需求清单、状态机、权限模型、消息契约、配置 schema、History/Context 双持久化、运行中命令分类、TUI 设计、视觉系统）
- 重构设计：`docs/superpowers/specs/2026-08-27-modular-refactor-design.md`（包结构、依赖图、agent/ui 拆分、架构测试、迁移映射）
- WebUI 设计：`docs/superpowers/specs/2026-08-29-webui-design.md`（三主题、Primitives、Cmd+K 命令面板、8 section 信息面板、权限内联 banner）
- 后端纵切重构（已实施）：`docs/superpowers/specs/2026-09-07-backend-restructure-design.md`（turn/ 特征切分、ctx 单一所有权、单状态机）
- 工具扩展设计（已实施）：`docs/superpowers/specs/2026-09-08-tooling-expansion-design.md`（ls/glob/grep 探索工具、输出治理、参数化权限引擎）
- 权限配置设计（已实施）：`docs/superpowers/specs/2026-09-09-permission-config-design.md`（桶→工具→模式数组、锚点作用域、双匹配语义、两端编辑器）
- UI 重构（已实施）：`docs/superpowers/specs/2026-09-07-ui-restructure-design.md`（features/ 纵切、ThemeRegistry、架构边界立法）
- 实现详解系列：`docs/learning/`（01-10 章，与当前代码同步的逐模块讲解）
- 实施计划：`docs/plans/2026-08-28-modular-refactor.md`

实现任何功能前先读对应章节；下文规范若与之冲突，以设计文档为准。

## 代码规范

1. **规范**：严格 TypeScript（`strict`），禁用无类型 `any`，运行时校验统一用 zod；命名与目录遵循三包分层。
2. **与设计一致 + 同步维护**：实现必须符合设计文档；任何设计变更都必须在同一改动里同步更新设计文档，不允许代码与文档漂移。
3. **美观 / 详细注释 / 可维护**：模块保持小而聚焦、单一职责；注释说明非显然的「为什么」——状态机迁移、流式 tool_calls 参数拼接、进程树 kill、上下文窗口裁剪、History/Context 分离等隐性约束与易踩的坑，不机械复述代码「做了什么」。
4. **实现后 review**：完成功能后对照设计文档自查，并用（或补充）测试验证正确性。

## 关键设计约束（易踩的坑）

- **History 与 Context 分离**（需求 §3.1）：History 是完整原文、永不压缩、给 UI 显示；Context 是发给模型的消息、会压缩。新消息双写两者；compact 只改 Context；resume 加载两者。
- **error 可序列化**：`AgentToUiMessage.error` 用 `{ message, name? }` 而非 `Error`（进程内 Port 与将来 SSE 同构）。
- **message 事件真 id**：id 为真值（非空串），与 tool_start/tool_end 的 id 同源。
- **拒绝/失败工具可见**（R3）：reject/未知工具/参数失败也发 tool_end（带 error 标记）。
- **运行中命令分类**（需求 §3.2）：动工作集类阻塞发 notice；纯查询类始终放行。

## 构建 / 测试

- `npm install`：安装依赖 + 链接 workspace 符号链接
- `npm run typecheck`：五路 tsc（root + agent + ui + bridge + server）
- `npm run test:run`（或 `npm test`）：Vitest 跑四包 test/
- `npm run build`：esbuild 打包到 `dist/dogegg.js`（统一 CLI 入口，@dogegg/* 经插件内联，npm 依赖 external）
- `npm run start`：`node dist/dogegg.js`（启动 TUI）；`npm run dev` = build + start
- `npm run dev:web`：concurrently 跑 server（cross-env VITE_DEV=1 PORT=3001 tsx main-web.ts）+ Vite dev server（wait-on tcp:3001 && vite），Vite proxy `/api` 到 3001
- `npm run build:web`：Vite build → `dist/web/`（静态前端）
- `npm run start:web`：`node dist/dogegg.js -web`，serve dist/web/ 静态文件 + 跑 agent
- 全局安装（`npm link` 或 `npm install -g`）后：任意目录执行 `dogegg` 启动 TUI，`dogegg -web` 启动 WebUI

> 说明：TUI 用 Ink v7，其依赖 `yoga-layout` 含 top-level await，`tsx` 的 CJS 转换会报错；故运行改用 esbuild 打包（`--format=esm --packages=external`）+ node 原生运行，非 `tsx`。WebUI 用 React DOM + Vite，开发时 `dev:web` 用 tsx 跑 main-web.ts + Vite dev server 代理 `/api`。

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles; label strings equal the role names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.