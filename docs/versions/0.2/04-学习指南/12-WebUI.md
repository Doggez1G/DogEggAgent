# 12-WebUI

WebUI 是浏览器端 React 前端，构建产物由 `server/src/http/static-files.ts` serve（dev 模式走 Vite 代理，见 `main-web.ts` 与 `package.json` 的 `dev:web`）。入口 `ui/src/webui/main.tsx`：`createSseUiPort()` 创建 port → `<App port={port} connectionState={connState} />`，外面包全局 ErrorBoundary。

## SSE 通道与校验

`ui/src/webui/channel/sse-client.ts` 的 `createSseUiPort(onConnectionChange)` 把 EventSource + fetch 封装成 `UiPort`：下行监听 `/api/events`，每条消息过 `agentToUiMessageSchema.safeParse`（`bridge/src/contract/agent-to-ui-schema.ts`），**校验失败静默丢弃**——前后端版本错位时新消息类型不会炸掉渲染层；上行 `post()` fetch POST `/api/message`，非 2xx 抛错。连接状态三态 `connected / reconnecting / disconnected`：EventSource 断开后浏览器自动重连，`main.tsx` 把状态传进 App，顶栏显示指示器。服务端对称的校验是 `server/src/channel/sse.ts` 的 `postHandler`（`uiToAgentMessageSchema` + 1MB 上限）——**两个方向都有 zod 把关**。

## App 装配：特征 = hook + 组件

`ui/src/webui/app/app.tsx` 头注释立法：「本组件只做特征装配 + 布局；数据域在各 feature 的 hook 里，各自独立订阅 port」。三栏布局：Sidebar（项目树 + 会话列表 + 主题）｜TopBar + ChatView ｜ InfoPanel，底部 InputBar + PermissionBanner，模态层（settings/command-palette/confirm/help/prompt/fs-browser）+ toast。每个区域包独立 `ErrorBoundary`（`area` 属性标注崩溃区域，白屏不再整页扩散）。

`safePost()`（app.tsx 第 50 行）是所有用户动作的发消息出口：`port.post` 返回 Promise 时 catch 网络错误、同步 throw 也兜住，`isUserAction` 标记的操作失败转 toast——SSE 通道的异步性（对比 TUI 的同步 InMemoryChannel）要求这层显式错误面。

数据域 hooks（都在 `ui/src/webui/features/`）：

- `use-panel-data.ts`：信息面板数据域——config/status/tools/context/system/log/permissions 七类状态；`session_ready` 时清旧数据并**一次补发六个请求**（status/context/system/log/tools/permissions），`compaction`/`finished`/`error` 后自动 `context_request` 刷新。
- `use-turn-tracking.ts`：工具执行与审批生命周期——toolCalls 追踪（`logic/tool-tracking.ts` 的 `applyToolStart/applyToolEnd` 纯逻辑）、`extractFilesTouched` 提取改动文件、pendingPermission 挂起与决议关联。难点处理值得细读：订阅回调是首渲染闭包，所以 config/identities/sessionRules/pending 全走 **ref 镜像**；`permission_request.id` 与 `tool_start.id` 不同源，决策按 toolName 关联并用后即清；提升决策后**乐观更新** sessionRules 镜像（不等 permissions_list 往返），随后端广播校正。
- `use-skills.ts`：skills_list 镜像，只保留可用条目（enabled 且非 missing）供联想；设置页单独订阅全量做启停管理。
- `use-sessions.ts` / `use-chat-state.ts` / `use-ui-chrome.ts`：会话列表、聊天 reducer 包装（消费 `ui/src/shared/reducer.ts`）、模态/主题/折叠等 UI 件。

WebUI 的运行时工具清单镜像（`tools_list`）同时喂三个消费者：设置页权限 section 的 MCP 工具勾选、InfoPanel 的 Tools 区、`use-turn-tracking` 的 `identitiesRef`（`effectivePerm` 判定 MCP 服务键规则必需——见 `ui/src/webui/features/turn-tracking/use-turn-tracking.ts` 挂载播种）。

CSS 用 CSS Modules（`app.module.css` 等，`css-modules.d.ts` 声明类型），主题经 `ui/src/webui/theme/` 的 token-map + 三套 CSS 变量主题（`main.tsx` 引入 midnight/forest/dawn）。

## 组件分层（ui/src/webui/components/）

- `chat-view/` + `message-block/`：聊天流渲染，工具块复用 `ui/src/shared/tool-display.ts` 的格式化（与 TUI 同一份）。
- `settings/`（`view.tsx` + `permissions.tsx`/`skills.tsx`/`mcp.tsx` 三个 section）：配置编辑弹框，权限 section 的规则编辑同样翻译成 `config_set` 消息（与 TUI 配置树同构）。
- `info-panel/`：右侧面板——token 表盘（过载判断用契约常量 `COMPACTION_THRESHOLD`，见 `bridge/src/contract/shared.ts`）、工具调用历史、改动文件、会话权限（revoke 走 `permission_revoke`）等。
- `permission-banner/`：四档决议横幅（allow_once / allow_always / allow_always_scoped（有 `alwaysScope` 时） / reject），决议发 `permission_decision`。
- `input-bar/`：输入区 + 斜杠联想 + `onCommandFeedback` 命令副作用路由（/cd 开目录浏览器、/skills /mcp 开设置页对应 section、其余按 `getCommandFeedback` 高亮 InfoPanel 区块）；错误时消费 `retryText` 一键重填。
- `sidebar/`：项目树分组（按会话 `cwd`）、删除项目/会话的确认弹框接线、主题切换下拉。
- `top-bar/`：provider/model/cwd + 连接状态指示器 + Cmd+K 入口。
- `primitives/`（button/field）与 `modal-portal/`：最底层复用件。
- `fs-browser-modal/`：目录选择器，数据来自 `server/src/fs/browse.ts` 的 `/api/fs`。
- `command-palette/`（Cmd+K）：聚合会话切换/skills/主题/设置入口，支持关键词过滤（label/desc 子串匹配，方向键在过滤结果上移动）；与其它模态一样经 `modal-portal/` 的 `ModalPortal` 承载（document 级 keydown 统一处理 Esc 关闭）；skills 组数据来自 `use-skills`；`confirm-modal`/`prompt-modal`/`help-modal`/`error-boundary` 各司其职。

## 调试 WebUI 的最小动线

1. `npm run dev:web`（server 3001 + Vite 前端热更）；浏览器 DevTools 的 Network 里能看到两条命脉：`/api/events`（EventSource，所有下行消息原文）与 `/api/message`（每次上行 POST）。
2. 想看「agent 到底发了什么」：在 `ui/src/webui/channel/sse-client.ts` 的 `es.onmessage` 里临时 `console.log(raw)`——比断点 agent 更快定位两端分歧。
3. 断连重连语义测试：重启 `main-web.ts` 进程，观察顶栏从 disconnected → reconnecting → connected，且恢复后各 hook 的播种请求（permissions_request/tools_request/…）重新拉齐状态——这正是「每条下行消息都可能随时重复出现」的播种式设计要对付的场景。

## 与 TUI 的对称性

同一 `UiPort` 契约、同一份共享逻辑（`ui/src/shared/`：reducer/commands/tool-display/status/permission/block），差异只在传输（InMemory vs SSE）与渲染（Ink vs DOM）：

| 关注点 | TUI | WebUI |
|---|---|---|
| 命令解析 | `parseCommand` + intent 标志（app.tsx） | `parseCommand` + `COMMAND_TO_MODAL` 导航（app.tsx 的 onCommandNav） |
| 权限决议 | permission overlay（features/permission） | PermissionBanner + use-turn-tracking.resolve |
| 视图状态 | `ui/src/tui/view-state.ts` 的 View | `ui/src/webui/view-state.ts` 的 Modal |
| 键盘/点击 | features/*/keys.ts 纯函数 | 组件回调 + safePost |
| 会话切换清屏 | Static 重挂载 | session_ready 清数据重播种（busy 时恢复 live 运行现场） |
| 错误恢复 | onErrorRetry 回填输入框 | retryText + consumeRetry（InputBar） |

读法建议：拿同一条消息（如 `permission_request`）分别在 `use-agent-events.ts` 与 `use-turn-tracking.ts` 里追，能看到两端对同一契约的不同消费方式；共享域改动（如 reducer）会同时影响两端，`ui/test/shared/` 的测试就是两端的公共防线。若要新增一个 UI 能力，判断清单是：纯展示差异 → 各自实现；消息消费逻辑 → 想清楚放 shared 还是各自 hook；能两端共享的纯函数（格式化/判定）一律进 `ui/src/shared/` 并补 `ui/test/shared/` 用例。

> 架构约束：`bridge/test/architecture.test.ts` 断言 webui 不依赖 agent/server——见 03-包结构与依赖。
