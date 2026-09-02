# AGENTS.md

本文件是给后续 AI agent 的操作指南。详细的需求设计、ADR、包结构等在 `docs/superpowers/specs/` 和 `CLAUDE.md` 中，本文件只提炼最关键的约束。

## 1. 先理解再动手

实现或修改任何功能前，必须先做以下分析：

- **读当前代码**：找到要改的文件，读懂现有实现逻辑和注释中的"为什么"。注释说明的约束（如 History/Context 分离、thinking 对齐、permission 会话隔离）都有原因，不能无视。
- **读相关设计文档**：在 `docs/superpowers/specs/` 中找到对应章节，理解需求背景和设计决策。在 `docs/adr/` 中检查是否有相关架构决策记录。
- **读 AGENTS.md 其余章节的约束**：确认你的改动不违反下面的架构和代码规范。
- **实现后必须验证**：`npm run typecheck` + `npm run test:run` 全部通过后才能提交。改了前端额外运行 `npm run build:web`。测试失败必须修复，不得跳过或注释。

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

### 2.3 文件夹内按职责分文件

- 一个文件只承载一个职责。
- 不是机械行数红线——目标是内聚且不把所有功能堆进单文件。
- 当某文件确实内聚且超长时（如纯 switch），优先评估能否抽 helper，而非人为凑行数切缝。

## 4.2 注释

- 注释说明非显然的「为什么」——状态机迁移、流式参数拼接、上下文窗口裁剪、History/Context 分离等隐性约束。
- 不机械复述代码「做了什么」。
- 中文注释为主（与现有代码一致），技术术语保留英文。
