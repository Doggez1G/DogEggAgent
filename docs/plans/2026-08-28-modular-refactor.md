# DogEggAgent 模块化重构实施计划

> 日期：2026-08-28
> 规格：`docs/superpowers/specs/2026-08-27-modular-refactor-design.md`（下称「设计」）+ `2026-08-26-dog-egg-agent-design.md`（下称「需求」）。
> 本计划不依赖 superpowers；按阶段推进，每阶段末尾 `npm run typecheck && npm run test:run` 必须全绿才进入下一阶段，每阶段一个 commit。

## 起点（基线）

- 干净基线 commit `b82db70`（已强制回退遗留的 `be19147`）。
- **单包结构**：无 workspaces、无 bridge 包、无 agent/ui/bridge 子包。
- 契约在 `src/events/{types,agent-to-ui,ui-to-agent}.ts` + `src/config/schema.ts`（含 isConfigured）。
- 15 个 src 文件用相对路径 import 这些契约（如 `from '../events/types'`、`from '../config/schema'`）。
- 15 个测试文件 57 个断言，typecheck + test 全绿。
- 构建入口 `src/main/index.ts`，esbuild 直接打包。

**当前未提交改动**（本计划之前的文档工作，应先 commit 再开工）：
- 修改：两份 specs（需求 + 重构设计，已按对齐定调更新）
- 删除：`docs/superpowers/plans/` 下两份旧计划
- 新增：本计划文件

## 行为修正（随重构落地，非新增特性）

已在需求文档定调，重构期间一并实现：
- **R1**：History 与 Context 双独立持久化。session 存 `{ id, updatedAt, history, context }`；新消息双写；compact 只改 context、不动 history；resume 加载两者（history 给 UI、context 给模型）。详见需求 §3.1。
- **R2**：运行中命令分四类（阻塞发 notice / loop 控制 / 纯查询放行 / UI 本地）。详见需求 §3.2。
- **R3**：被拒绝/未知工具/参数失败也发 `tool_end`（带 error 标记），不再静默塞消息。
- **R4**：`message` 事件 id 给真值（非空串），与 tool_start 的 id 对齐。

## 阶段总览

| Phase | 内容 | 结束状态 |
|---|---|---|
| 0 | 文档改动提交 + 基线确认 | 文档已提交，基线绿 |
| 1 | workspace 骨架 + bridge 包 + 契约迁移 + 全仓 import 切换 | agent/ui 仍在 `src/`，但只依赖 `@dogegg/bridge` 包名；`src/events/`、`src/config/schema.ts` 已删 |
| 2 | agent 包迁移与拆分 | `src/{agent,llm,tools,config,common}` 清空 |
| 3 | ui 包迁移与拆分 | `src/ui` 清空 |
| 4 | 根 `main.ts` + 删除 `src/`、`test/` + 行为修正落地 + 构建验证 | 仅存三包 + 根配置；冒烟通过 |
| 5 | 文档同步 + 最终验证 | 完成 |

---

## Phase 0: 文档提交 + 基线确认

### Task 0.1: 提交文档改动

```bash
git add -A
git commit -m "docs: align requirements & refactor design (R1-R6, dedupe, decouple); replace stale plans"
```
包含：两份 specs 修改、旧 plans 删除、新计划文件。

### Task 0.2: 基线确认

```bash
npm run typecheck && npm run test:run
```
Expected：typecheck 绿；15 文件 57 断言全绿。

---

## Phase 1: workspace 骨架 + bridge 包 + 契约迁移 + import 切换

目标：建起三包配置与根工具链；bridge 包完整可测（契约 + Port 通道）；契约从 `src/events/`、`src/config/schema.ts` 迁入 bridge；全仓 import 从相对路径切到 `@dogegg/bridge`。agent/ui 代码仍在 `src/` 不动，只改 import 源。

### Task 1.1: 根配置与 workspace 骨架

- 写 `tsconfig.base.json`（共享 compilerOptions：strict / moduleResolution: bundler / jsx: react-jsx / noEmit）。
- 改根 `package.json`：加 `workspaces: ["agent","ui","bridge"]`；typecheck 脚本拆为 `tsc -p tsconfig.json && -p agent && -p ui && -p bridge`；build 改用 `node build.mjs`。
- 写 `build.mjs`：esbuild JS API + workspace 插件（`@dogegg/*` 解析到各包 `src/index.ts`），`packages: 'external'` 保持 npm 依赖外置。
- 改根 `tsconfig.json`：`extends ./tsconfig.base.json`，本阶段仍 `include: ["src","test"]`。
- 改 `vitest.config.ts`：include 改为三包 `test/**`（本阶段三包 test 暂只有 bridge，src 旧测试仍在 test/ 跑）。
- `npm install` 确认 workspace 生效（node_modules/@dogegg 出现 bridge 软链；agent/ui 此时无 package.json 会报，下一步补）。

### Task 1.2: bridge 包结构（契约 + 通道 + 测试）

迁移映射（从干净基线的 src/events + src/config/schema.ts）：

| 现文件 | 去向 | 改动 |
|---|---|---|
| `src/events/types.ts` | `bridge/src/contract/shared.ts` | 原样（State/PermissionDecision/ToolCall/Message） |
| `src/events/agent-to-ui.ts` | `bridge/src/contract/agent-to-ui.ts` | import `./types`→`./shared`、`../config/schema`→`./config`；**S3** error 改 `{message,name?}`；**R4** message id 注释为真值 |
| `src/events/ui-to-agent.ts` | `bridge/src/contract/ui-to-agent.ts` | import `./types`→`./shared` |
| `src/config/schema.ts` | `bridge/src/contract/config.ts` | 原样（schema + 类型 + isConfigured，②保留 bridge） |

新增：
- `bridge/src/channel/port.ts`：AgentPort / UiPort 接口。
- `bridge/src/channel/in-memory.ts`：createChannelPair()。
- `bridge/src/index.ts`：纯 re-export 全部。
- `bridge/package.json`：`@dogegg/bridge`，exports 指向 `./src/index.ts`，dep `zod`。
- `bridge/tsconfig.json`：extends base。
- `bridge/test/channel.test.ts`：投递/退订/双向。
- `bridge/test/architecture.test.ts`：依赖方向 + 模块边界（index 纯 re-export）；**无 size ceiling**（S2 已去）。

验证：`npx tsc --noEmit -p bridge && npm run test:run -- bridge` 绿。

### Task 1.3: agent/ui 包占位 + 全仓 import 切换

- 写 `agent/package.json`（`@dogegg/agent`，exports `./src/index.ts`，dep `zod`+`@dogegg/bridge`）、`agent/tsconfig.json`（extends base，本阶段 include 暂空或占位 `src/index.ts`）。
- 同理 `ui/package.json`、`ui/tsconfig.json`。
- **import 改写表**（逐文件 Edit，把相对路径契约 import 改为 `@dogegg/bridge`）：

| 文件 | 旧 import | 新 import |
|---|---|---|
| `src/agent/index.ts` | `../events/ui-to-agent`, `../events/agent-to-ui`, `../events/types`, `../config/schema` | 均 → `@dogegg/bridge` |
| `src/agent/loop.ts` | `../events/types`, `../events/agent-to-ui` | → `@dogegg/bridge`（llm/tools 相对保留） |
| `src/agent/context.ts` | `../events/types` | `@dogegg/bridge` |
| `src/agent/session.ts` | `../events/types` | `@dogegg/bridge` |
| `src/agent/permission.ts` | `../events/types` | `@dogegg/bridge` |
| `src/agent/state.ts` | `../events/types` | `@dogegg/bridge` |
| `src/llm/types.ts` | `../events/types` | `@dogegg/bridge` |
| `src/llm/provider/openai.ts` | `../../events/types`, `../../config/schema` | → `@dogegg/bridge` |
| `src/llm/streaming/openai.ts` | `../../events/types` | `@dogegg/bridge` |
| `src/config/loader.ts` | `./schema` | `@dogegg/bridge` |
| `src/ui/tui/index.tsx` | `../../events/agent-to-ui`, `../../events/types`, `../../config/schema` | → `@dogegg/bridge` |
| `src/ui/tui/config-tree.ts` | `../../config/schema` | `@dogegg/bridge` |
| `test/**` | `../../src/events/*`、`../../src/config/schema` 若有 | → `@dogegg/bridge`；其余 `../../src/...` 相对保留 |

- 删除旧契约文件：`rm -rf src/events && rm src/config/schema.ts`。
- 验证：`npm run typecheck && npm run test:run` 全绿。
- commit：`refactor: workspace scaffold + bridge contract/channel; switch imports to @dogegg/bridge`。

> ⚠️ **R3/R4 暂不在此阶段改行为**：契约里 error/message id 已按新形状定义，但 src 代码里 emit `error: Error` / `id: ''` 的调用点会因类型不匹配而 typecheck 红。本阶段在 import 切换同时，把 src 里这两处调用点同步修正（emit error 时转 `{message, name}`、message id 传真值），保证 typecheck 绿。这是契约迁移的必然连带，不算单独行为修正。

---

## Phase 2: agent 包迁移与拆分

目标：`src/agent`、`src/llm`、`src/tools`、`src/config`、`src/common` → `agent/src/`，按设计 §5 拆文件。agent 改造为通过 `AgentPort` 收发消息。

依赖顺序（叶子→根）：`shared` → `tools` → `llm` → `context` → `session`/`permission`/`config` → `loop` → `core`。

### Task 2.1: shared/（← src/common）
- `git mv src/common/errors.ts agent/src/shared/errors.ts`；`git mv src/common/utils/id.ts agent/src/shared/id.ts`。
- 拆 `src/common/utils/logger.ts` → `agent/src/shared/logger/{init,write,tail}.ts` + index。
- `agent/src/shared/index.ts`（纯 re-export）。

### Task 2.2: tools/（← src/tools，schema+execute 分文件）
- `tools/types.ts`；每工具 `{schema,execute,index}.ts`；shell 另加 `interpreter.ts`（← utils/shell）+ `kill-tree.ts`。
- `tools/registry.ts`（实现）+ `tools/index.ts`（纯 re-export）。
- 删旧 `src/tools/*`。

### Task 2.3: llm/（← src/llm）
- `llm/types.ts`；`streaming/openai/{types,parser}.ts`；`provider/openai/{request,stream,retry,adapter}.ts` + index。
- 新增 `llm/adapter-for.ts`（R6）：`adapterFor(protocol)`，v1 单分支。
- `llm/index.ts`（纯 re-export）。`ProviderRegistry` 删除（进 Task 2.7）。
- 删旧 `src/llm/*`。

### Task 2.4: context/（← src/agent/context.ts + utils；只管 Context）
- `prompt/{builtin,load}.ts`；`token/{estimate,budget}.ts`；`message/truncate.ts`（无 tool-result.ts）。
- `compact/{trigger,split,summarize,compact}.ts`：summarizeHistory 唯一归宿；`compactContext()` 返回新 context 数组，不触碰 history（R1）。
- `context/index.ts`（纯 re-export）。
- 删旧 `src/agent/context.ts`、`src/common/utils/{token-count,truncate}.ts`。

### Task 2.5: session/（← src/agent/session.ts，R1 双持久化）
- `store.ts`：`saveSession(id, history, context)` / `loadSession` 返回 `{id,history,context}`。文件结构 `{id,updatedAt,history,context}`。
- `list.ts`：preview 取 history 最后一条非 tool 消息。
- `index.ts`（纯 re-export）。删旧 `src/agent/session.ts`。

### Task 2.6: permission/（← src/agent/permission.ts）
- `classify.ts`（纯函数）+ `runtime.ts`（PermissionManager）+ `index.ts`。删旧。

### Task 2.7: config/（loader + resolve + editor）
- `loader/{find,load,save}.ts` + index（← src/config/loader.ts 拆）。isConfigured 从 bridge 取。
- `resolve/current.ts`（resolveCurrent，收编 ProviderRegistry）+ index（无 configured.ts）。
- `editor/{paths,mutate,validate,editor}.ts` + index（从 Agent 抽出；editor.ts 实现，index re-export）。
- 删旧 `src/config/loader.ts`。

### Task 2.8: loop/（← src/agent/loop.ts，消重 + R3）
- `types.ts`（LoopDeps）；`tool-calls.ts`（executeOneTool helper 消重；R3 拒绝/失败也发 tool_end）；`run.ts`（compact 调 compactContext，只改 context；loop 维护 context，core 维护 history 双写）。
- `index.ts`（纯 re-export；无 summarize.ts）。删旧 `src/agent/loop.ts`。

### Task 2.9: core/（agent 门面 + pending + state；不拆 commands/turn）
- `state/{events,transition}.ts` + index（← state.ts）。
- `pending.ts`（PendingPermissions）。
- `agent.ts`：`new Agent({port,config,cwd,logDir})`，自订阅 port。持有 history+context 双份（R1）。emit→port.post。send 按 R2 四类分发。submit 双写 history+context，runLoop 作用于 context，turn 结束 saveSession(history,context)。compact_request 调 compactContext 改 context 不动 history。
- `core/index.ts` + `agent/src/index.ts`（纯 re-export）。
- 删旧 `src/agent/{index,state}.ts`。

### Task 2.10: 测试迁移 + 新增
- 镜像 `test/{agent,llm,tools,config,common}/*` → `agent/test/`，修 import。
- 新增（S4）：`agent/test/config/editor/paths.test.ts`、`agent/test/context/compact.test.ts`。
- 验证全绿。commit：`refactor(agent): migrate to @dogegg/agent workspace, split by duty, R1/R3 behavior`。

---

## Phase 3: ui 包迁移与拆分

目标：`src/ui` → `ui/src/tui/`，474 行 `index.tsx` 拆 8 模块。`App({port})` 只用 UiPort，**删除 `import type { Agent }`**。

### Task 3.1: 组件层（← components.tsx）
- `components/{top-bar,message-block,status-bar,list-picker}/{view,index}.tsx`；`theme/palette.ts`；`markdown/render.ts`（← utils/markdown）。
- 删旧 `components.tsx`、`src/common/utils/markdown.ts`。

### Task 3.2: 纯逻辑模块
- `chat/{block,reducer,viewport,browse}.ts` + index；`input/{commands,input-box.tsx}.ts` + index。
- 新增测试：`ui/test/tui/chat/{reducer,viewport}.test.ts`、`ui/test/tui/input/commands.test.ts`。

### Task 3.3: overlays + app 装配
- `overlays/{permission,pickers,prompt,config}/...`；`config/{entries,navigation,label,editor}.tsx`（← config-tree.ts 164 行）。
- `app/{app.tsx,view-state.ts,keys.ts,entry.ts}` + index：所有 `agent.send→port.post`、`agent.on→port.onMessage`；R4 reducer 用真 id 做块定位。
- `ui/src/index.ts`（纯 re-export：renderTui）。
- 删旧 `src/ui/tui/{index.tsx,config-tree.ts}`。验证全绿。commit：`refactor(ui): migrate to @dogegg/ui workspace, decouple from Agent via UiPort`。

---

## Phase 4: 组合根 + 清理 + 行为修正收尾

### Task 4.1: 根 main.ts（← src/main/）
- 根 `main.ts`（~25 行）：loadConfig → createChannelPair → new Agent({port:agentPort,...}) → renderTui(uiPort)。alt-screen 归 ui entry.ts。
- 删 `src/main/{index,bootstrap}.ts`。

### Task 4.2: 删除旧 src/ 与 test/
```bash
rm -rf src test
```

### Task 4.3: 行为修正验证
- R1：resume 后 UI 显示压缩前历史、模型收到压缩后 context。
- R2：运行中 `/context` 放行、`/new` 发 notice。
- R3：拒绝工具 UI 渲染「🐾 tool ✕ denied」。
- R4：message id 非空串。

### Task 4.4: 构建验证
```bash
npm run build && npm start
```
冒烟：发消息、`/config`、权限弹层、折叠展开、`/compact`、`/session`。
commit：`refactor: root main.ts composition root; remove src/, finalize R1-R4`。

---

## Phase 5: 文档同步 + 最终验证

### Task 5.1: 文档同步
- `CLAUDE.md`：分层 `events/`→`bridge/`；构建说明同步 workspaces；引用更新。
- 确认设计 §2 的 `events/` 提法已是 `bridge/`。

### Task 5.2: 最终验证
```bash
npm run typecheck && npm run test:run && npm run build
grep -r "from.*agent" ui/src || echo "ui zero back-dependency OK"
```
全过即完成。commit：`docs: sync CLAUDE.md to modular workspace structure`。

---

## 验收口径（同设计 §11）

1. typecheck 绿；
2. test:run 绿，断言 ≥ 现有 57 + 新增（bridge 2 / ui 3 / agent 2）；
3. build 产出 `dist/index.js`，`npm start` 可启动，冒烟通过；
4. `grep "from.*agent" ui/src` 无结果；
5. 架构测试通过（依赖方向 + 模块边界；index 纯 re-export）；
6. R1/R3/R4 行为已落实。
