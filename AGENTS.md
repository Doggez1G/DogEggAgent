# AGENTS.md

本文件是给后续 AI agent（Claude Code、ZCode 等）的操作指南。所有在本文件中写明的要求必须遵守。

## 1. 核心原则

### 1.1 验证优先
- **实现功能后必须验证**：每次实现或修改功能后，必须运行 `npm run typecheck` 和 `npm run test:run`，确认全部通过后才能提交。不得跳过验证直接交付。
- **修改后端逻辑时额外运行** `npm run build:web`，确认 Vite + esbuild 构建成功。
- **如果测试失败，必须修复到全部通过**，不得注释掉或跳过失败的测试。
- **涉及前端视觉改动的，必须用 judge 或截图验证渲染效果**，不能只靠 typecheck 通过就认为正确。

### 1.2 先理解再动手
- 实现任何功能前，先读对应的设计文档章节（`docs/superpowers/specs/`）和 ADR（`docs/adr/`）。
- 下文规范若与设计文档冲突，以设计文档为准——但如果设计文档已过时（代码实现与文档不符），应先更新文档再改代码。
- 修改已有代码前，先读懂当前实现逻辑和注释中的"为什么"——注释说明的约束（如 History/Context 分离、thinking 对齐、permission 会话隔离）都是有原因的，不能无视。

## 2. 架构约束

### 2.1 四包解耦（强制）
```
agent ←→ bridge ←→ ui
                  ←→ server（WebUI 传输）
```
- `agent` 不 import `@dogegg/ui`；`ui` 不 import `@dogegg/agent`；二者都只依赖 `@dogegg/bridge`。
- `bridge` 不依赖任何兄弟包。
- `server` 可 import `@dogegg/agent` 和 `@dogegg/bridge`，但不 import `@dogegg/ui`（前端是静态文件被 serve）。
- 只有组合根（`main.ts` / `main-web.ts`）同时 import agent 与前端。
- 此规则由 `bridge/test/architecture.test.ts` 强制——修改包间依赖后必须运行此测试。

### 2.2 模块 = 文件夹
- 每个模块是一个文件夹，`index.ts` 是唯一对外脸面（**仅 re-export，不写实现逻辑**）。
- 文件夹内其他文件是模块私有实现。
- 跨模块 import 只能指向 `index.ts`，不能直接 import 私有文件（如 `../shared/errors` 应改为 `../shared`）。
- **注意：当前架构测试未强制此规则，存在违规（`agent/src/loop/run.ts` import `../shared/errors`、`agent/src/core/agent.ts` import `../shared/id`）。新代码必须遵守，旧违规应逐步修正。**

### 2.3 文件夹内按职责分文件
- 一个文件只承载一个职责。
- 不是机械行数红线——目标是内聚且不把所有功能堆进单文件。
- 当某文件确实内聚且超长时（如纯 switch），优先评估能否抽 helper，而非人为凑行数切缝。

### 2.4 bridge 契约全部可序列化
- `AgentToUiMessage` 的 `error` 用 `{ message: string; name?: string }` 而非 `Error` 对象（`Error` 的 `JSON.stringify` 会丢 stack/name）。
- 新增消息类型时必须保持可序列化——因为 SSE 传输需要 `JSON.stringify`。
- 新增消息类型后必须在 `bridge/src/contract/ui-to-agent-schema.ts`（zod schema）中同步添加，用于 POST 校验。

## 3. 关键设计约束（易踩的坑）

### 3.1 History 与 Context 分离（需求 §3.1）
- **History** 是完整原文、永不压缩、给 UI 显示。
- **Context** 是发给模型的消息、会压缩。
- 新消息双写两者；compact 只改 Context；resume 加载两者。
- **绝对不能**在 compact 逻辑中触碰 History。

### 3.2 运行中命令分类（需求 §3.2）
- 动工作集类命令（submit、new_session、clear_history、compact_request、config_set/add/remove、set_cwd、delete_session）在运行中阻塞，发 notice 提示"运行中，请稍候"。
- 纯查询类命令（list_sessions、config_request、tools_request、context_request、status_request、system_request、log_request、permissions_request）始终放行。
- `permission_decision` 和 `cancel` 是 loop 控制，不受 running 守卫限制。

### 3.3 消息 ID 关联
- `permission_request.id` 与 `tool_start.id` 是后端分别生成的不同 ID（`permission_request` 用 `newId()`，`tool_start` 用 LLM 的 `tool_call_id`）。
- 前端按 **toolName** 关联两者，不按 ID。
- 如果同一工具并发执行，这个关联会出问题（当前串行执行所以不会触发）。

### 3.4 Thinking 持久化对齐
- thinking 数组每轮 LLM 调用产生一个条目，与 assistant 消息一一对应。
- `deps.reasoning` 为 false 时存空字符串（不记录实际 reasoning 内容）。
- `rebuildBlocksFromHistory` 中空字符串条目被跳过（不显示思考气泡）。
- **修改 thinking 相关逻辑时必须同时验证：开启思考 + 关闭思考 + 混合会话（先关后开）+ 加载历史四种场景。**

### 3.5 10 态状态机
- 状态迁移由 `core/state/transition.ts` 纯函数驱动，`VALID_FROM` 表守卫非法组合。
- 修改状态迁移逻辑后必须运行 `agent/test/core/state.test.ts`。
- 新增状态需要更新 `VALID_FROM` 表、`STATUS_LABELS`（所有 UI）、状态机测试。

### 3.6 权限模型
- 三桶：`config.permission.allow` / `reject` / `ask`，classify 时 reject 优先，然后 allow，默认 ask。
- `allow_always` 是会话级，new_session 时 reset，resume 时从 session 文件恢复。
- 权限分类逻辑在 `agent/src/permission/classify.ts`，前端 UI 有等价的 display-only 逻辑（不能 import agent，所以各自实现）。

## 4. 代码规范

### 4.1 TypeScript
- 严格模式（`strict: true`），`noUncheckedIndexedAccess: true`。
- 禁用无类型 `any`。
- 运行时校验统一用 zod。
- `post()` 返回 `void | Promise<void>`（同步 in-memory 或异步 SSE fetch）——调用方需要处理两种情况。

### 4.2 注释
- 注释说明非显然的「为什么」——状态机迁移、流式参数拼接、上下文窗口裁剪、History/Context 分离等隐性约束。
- 不机械复述代码「做了什么」。
- 中文注释为主（与现有代码一致），技术术语保留英文。

### 4.3 命名
- 遵循三包分层命名：`agent`（后端域）、`ui`（前端域）、`bridge`（契约域）、`server`（传输域）。
- 避免使用被弃用的术语：channel（用 Port）、transport（用 Channel）、protocol/API（用 Bridge Contract）。
- 详见 `CONTEXT.md` 的 Language 章节。

### 4.4 CSS / 前端
- WebUI 用 CSS 变量 + CSS Modules，零运行时样式库。
- 所有颜色通过 `--color-*` 变量，不硬编码 hex。
- 主题 token 完整定义在三主题 CSS 文件中（midnight/forest/dawn），包括 soft 色、间距、字号、圆角等。
- 新增组件遵循 `module=folder` 约定：`view.tsx` 实现 + `*.module.css` 样式 + `index.ts` re-export。

## 5. 实现后自查清单

每次实现或修改功能后，对照以下清单自查：

- [ ] `npm run typecheck` 五路 tsc 全部通过
- [ ] `npm run test:run` 全部测试通过（不得跳过或注释掉失败测试）
- [ ] `npm run build:web` 构建成功（如果改了前端）
- [ ] 没有引入跨包违规 import（agent↔ui、server→ui）
- [ ] 没有直接 import 模块私有文件（应通过 index.ts）
- [ ] 如果改了 bridge 契约（消息类型），同步更新了 zod schema
- [ ] 如果改了设计决策，同步更新了设计文档和 ADR
- [ ] 如果新增了文件，遵循了 module=folder 约定
- [ ] 如果改了 thinking 相关逻辑，验证了四种场景（开/关/混合/加载历史）
- [ ] 如果改了状态机，运行了 state.test.ts
- [ ] 如果改了权限逻辑，验证了 allow_always 的会话隔离
- [ ] 注释说明了非显然的「为什么」

## 6. 文档维护

- **代码与文档不允许漂移**：任何设计变更都必须在同一改动里同步更新设计文档。
- 设计文档在 `docs/superpowers/specs/`，ADR 在 `docs/adr/`，学习文档在 `docs/learning/`。
- `CONTEXT.md` 是领域术语表——新增领域概念时更新它。
- ADR 记录的是"难以逆转 + 无背景会困惑 + 真实权衡"的决策，不是所有决定都记 ADR。
- `CLAUDE.md` 是 AI agent 的快速参考——包结构、构建脚本、关键约束。

## 7. 构建与测试

```bash
npm run typecheck    # 五路 tsc（root + agent + ui + bridge + server）
npm run test:run     # Vitest 跑四包测试
npm run build:web    # Vite build → dist/web/ + esbuild → dist/server.js
npm run dev:web      # Vite dev server + tsx 跑后端（开发模式）
npm run build        # esbuild → dist/index.js（TUI）
npm run dev          # TUI 开发（build + start）
```

- TUI 用 Ink v7，依赖 `yoga-layout` 含 top-level await，`tsx` 的 CJS 转换会报错；故用 esbuild 打包 + node 原生运行。
- WebUI 用 React DOM + Vite，开发时 `dev:web` 用 tsx 跑 main-web.ts + Vite dev server 代理 `/api`。
