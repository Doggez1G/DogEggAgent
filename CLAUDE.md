# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

DogEggAgent 是一个自研的**代码编辑型 agent**，第一目标是学习并理解 agent 的实现。技术栈：TypeScript / Node.js ≥ 20，Ink TUI，zod 校验，JSON 持久化，原生 `fetch` + 手写 SSE。

核心架构原则：**后端（agent / llm / tools / session / permission…）与前端（ui）完全解耦，仅通过 `events/` 的消息契约关联**。

## 需求 / 设计文档（单一事实源）

所有需求与设计以 `docs/superpowers/specs/2026-08-26-dog-egg-agent-design.md` 为准。内容包括：需求清单、状态机、权限模型、消息契约、配置 schema、工具、目录结构、技术选型、TUI 设计与视觉系统。

实现任何功能前，先读对应章节；下文规范若与之冲突，以设计文档为准。

## 代码规范

1. **规范**：严格 TypeScript（`strict`），禁用无类型 `any`，运行时校验统一用 zod；命名与目录遵循设计文档的分层（`agent/`、`llm/`、`tools/`、`config/`、`common/`、`ui/`、`events/`、`main/`）。
2. **与设计一致 + 同步维护**：实现必须符合设计文档；任何设计变更都必须在同一改动里同步更新设计文档，不允许代码与文档漂移。
3. **美观 / 详细注释 / 可维护**：模块保持小而聚焦、单一职责；注释要详细，且说明非显然的「为什么」——状态机迁移、流式 tool_calls 参数拼接、进程树 kill、上下文窗口裁剪等隐性约束与易踩的坑，不机械复述代码「做了什么」。
4. **实现后 review**：完成功能后，对照设计文档对应章节自查，并用（或补充）测试验证正确性；未满足需求或偏离设计，不得视为完成。

## 构建 / 测试

- `npm install`：安装依赖
- `npm run typecheck`：TypeScript 类型检查（`tsc --noEmit`）
- `npm run test:run`（或 `npm test`）：Vitest 跑测试
- `npm run build`：esbuild 打包到 `dist/index.js`（node_modules 保持 external）
- `npm run start`：`node dist/index.js`；`npm run dev` = build + start

> 说明：TUI 用 Ink v7，其依赖 `yoga-layout` 含 top-level await，`tsx` 的 CJS 转换会报错；故运行改用 esbuild 打包（`--format=esm --packages=external`）+ node 原生运行，非 `tsx`。