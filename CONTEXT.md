# DogEggAgent

一个面向学习的代码编辑 Agent：后端（agent 核心）与前端（tui / webui）完全解耦，通过 bridge 契约 + Port 通道互通。

## Language

### 架构层

**Port**:
传输无关的双向消息端口接口（AgentPort / UiPort）。post 发后即忘，onMessage 注册回调。同一接口可由同进程通道或网络通道实现。
_Avoid_: channel, connection, pipe

**Channel**:
Port 的具体实现。in-memory（同进程同步投递）或 sse（HTTP 下行 + POST 上行）。Channel 归 bridge 契约域，但 SSE 实现的传输细节归 server 包。
_Avoid_: transport, adapter

**组合根 (Composition Root)**:
全项目唯一同时 import agent 与前端的地方。`bin/dogegg.ts`（统一 CLI：dogegg → TUI、dogegg -web → WebUI）、`main-web.ts`（WebUI dev 模式，import agent + server）。持有"两端如何对接"的知识。
_Avoid_: entry, bootstrap

**Bridge 契约 (Bridge Contract)**:
`bridge/src/contract/` 中的全部消息类型（AgentToUiMessage / UiToAgentMessage）与跨界数据类型（State / Message / Config 等）。全部可序列化，传输无关的单一事实源。
_Avoid_: protocol, API

### 前端域

**TUI**:
终端前端，基于 Ink v7 + React。入口 `renderTui(uiPort)`。
_Avoid_: cli, console

**WebUI**:
浏览器前端，基于 React DOM + Vite。通过 SSE Port 与 Agent 通信，静态文件由 server serve。后续套 Electron 不推倒。
_Avoid_: web client, frontend app

**Shared**:
`ui/src/shared/` 中的平台无关前端逻辑（reducer / block / commands / status / permission / command-feedback）。TUI 与 WebUI 共用，不含任何终端或 DOM 依赖。
_Avoid_: common, utils

**Block**:
一条消息在 UI 中的呈现单元。语义模型：`kind`（角色）+ `colorToken`（语义色）+ `text`（摘要）+ `full`（完整内容，可选）。不含具体视觉值（emoji / hex），视觉映射归各 UI 的 theme 层。
_Avoid_: message, entry, item

**语义色 Token (Color Token)**:
`'accent' | 'text' | 'cyan' | 'yellow' | 'red' | 'subtext'` 等 union type。Block 携带 token 名，各 UI theme 层映射到具体值（TUI → hex，WebUI → CSS variable）。
_Avoid_: color, palette, theme color

### Server 域

**Server**:
`@dogegg/server` 包。HTTP server + SSE channel 实现 + REST 端点（fs 浏览 + shell 检测）+ 静态文件服务。不 import `@dogegg/ui`——前端是静态文件被 serve。是 WebUI 组合根（main-web.ts）的一部分。
_Avoid_: backend server, api server

**SSE Channel**:
`server/src/channel/sse.ts`。实现 AgentPort / UiPort 接口：下行通过 SSE 流推送 AgentToUiMessage，上行通过 POST 接收 UiToAgentMessage。
_Avoid_: websocket, real-time connection

### 交互概念

**单会话模式 (Single Session)**:
同一时刻只有一个活跃会话。可 /new、/session、resume 切换，但切换前需等完或打断（running 守卫保护）。TUI 与 WebUI 一致。多会话并行需要多 Agent 实例（未实现）。
_Avoid_: single agent, mono-session

**Cwd 切换 (Set Cwd)**:
运行时变更 Agent 工作目录。`UiToAgentMessage` 的 `set_cwd` 消息触发。会话文件持久化 cwd，resume 时恢复。new_session 可选传 cwd（WebUI 项目树添加会话用）。TUI 的 `/cd` 命令共用同一消息。
_Avoid_: change directory, chdir

**项目/会话树 (Project/Session Tree)**:
WebUI 侧栏按 cwd 分组会话为项目。每个项目可折叠/展开，有添加会话和删除按钮。session_list 返回 cwd? 字段供前端分组。
_Avoid_: workspace, folder tree

**思考内容持久化 (Thinking Persistence)**:
推理模型的 reasoning 内容存入 session JSON 的 thinking 字段（独立于 history/context），resume 后恢复思考块显示。parser 累积 reasoning → loop 返回 thinking 数组 → agent 持久化 → session_ready 携带 → reducer 重建思考块。
_Avoid_: reasoning persistence, thought storage

### 前端交互域

**双通道交互 (Dual-Channel Interaction)**:
WebUI 的交互模型：输入框斜杠命令 + Cmd+K 命令面板两个入口，两者发送相同的 `UiToAgentMessage`。纯呈现命令（/tools /system /log /permissions /context /status）通过 `onCommandFeedback` 高亮右侧信息面板对应 section，而非弹 toast。两者共享同一套反馈逻辑。
_Avoid_: dual entry, two paths

**Modal 叠加 (Modal Overlay)**:
WebUI 的中断性弹窗：settings / command-palette / confirm / fs-browser / help。叠加在单一布局（侧栏 + 顶栏 + 聊天 + 信息面板 + 输入栏）之上。权限确认是内联 banner（非 modal），出现在输入框上方。设置 modal 不响应 scrim 点击外部关闭（只能用关闭按钮）。
_Avoid_: view, screen, panel

**Token Map**:
各 UI theme 层的语义→视觉映射表。`kind → 图标`（TUI: emoji，WebUI: Lucide SVG）、`colorToken → 色值`（TUI: hex，WebUI: CSS variable）。Block 只携带语义信息，视觉映射归各 UI。
_Avoid_: icon map, color map

## Rules

- 后端不 import 前端，前端不 import 后端；二者都只依赖 `bridge/`。
- 只有组合根（bin/dogegg.ts 统一 CLI；main-web.ts 为 WebUI dev 模式）同时 import agent 与前端。
- bridge 契约全部可序列化——error 用 `{ message, name? }` 而非 Error 对象。
- Shared 模块零终端/DOM 依赖——Block 用语义 token，视觉映射归各 UI theme 层。
- Server 包不 import `@dogegg/ui`——前端是静态文件被 serve，不是代码被 import。
