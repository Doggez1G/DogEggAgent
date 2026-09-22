# 12 - WebUI 架构

> 职责：浏览器界面（`ui/src/webui/`，React + Vite + CSS Modules）——SSE 通道封装、四数据域 hook、装配层三栏布局、设置五区与信息面板八卡。它只 import `@dogegg/bridge`（webui 不依赖 agent/server，由 architecture.test.ts:47-51 断言），前端构建产物被 `@dogegg/server` 静态托管。

## 1. 职责与边界

| 目录/文件 | 职责 |
|---|---|
| `ui/src/webui/main.tsx` | 入口：createSseUiPort + Root（连接状态回调）+ 全局 ErrorBoundary |
| `ui/src/webui/channel/sse-client.ts` | SSE UiPort：EventSource 下行 + fetch POST 上行 + zod 校验 + 连接状态 |
| `ui/src/webui/app/app.tsx` | 装配层：特征装配 + 三栏布局 + 模态层 + safePost |
| `ui/src/webui/features/chat/use-chat-state.ts` | chat 数据域（shared reducer 的 WebUI 消费） |
| `ui/src/webui/features/sessions/use-sessions.ts` | 会话列表 + 已知项目集合 |
| `ui/src/webui/features/skills/use-skills.ts` | 技能联想池（过滤停用/缺失） |
| `ui/src/webui/features/info-panel/use-panel-data.ts` | 面板数据域（config/status/context/system/log/permissions/tools） |
| `ui/src/webui/features/turn-tracking/use-turn-tracking.ts` | 工具调用生命周期 + 权限决策关联 + 身份镜像 |
| `ui/src/webui/features/chrome/use-ui-chrome.ts` | 界面外壳：modal 总管/toast/折叠/主题/Cmd+K |
| `ui/src/webui/components/` | chat-view / input-bar / info-panel / settings / sidebar / 弹框族 / primitives |
| `ui/src/webui/view-state.ts` | Modal 联合类型 + 主题 + COMMAND_TO_MODAL + SessionItem/FileTouched |
| `ui/src/shared/` | 双前端共用平台无关逻辑（见 §6） |

## 2. 核心数据结构

### 2.1 SSE 客户端与 UiPort（sse-client.ts:11-68）

`createSseUiPort(onConnectionChange?)` 返回标准 `UiPort`：

- **下行**：`new EventSource('/api/events')`（:22）→ onmessage 里 `JSON.parse` → **`agentToUiMessageSchema.safeParse` 校验，失败则丢弃不传 listener**（:32-36，与 server 端上行校验对称的双向防线）；onerror 按 `es.readyState` 区分 `reconnecting`（浏览器自动重连中）与 `disconnected`（CLOSED，:42-50）；
- **上行**：`fetch POST /api/message`，body 为 JSON.stringify(msg)；非 2xx 抛错（:57-66）；
- **连接状态机**：`'connected' | 'reconnecting' | 'disconnected'`（:4），经回调通知 UI（顶栏指示器 + 首次断连 toast，:9-10 注释）。**恢复语义立法**：EventSource 断开浏览器自动重连，重连后 server 侧 agent 推 `session_ready` 恢复完整状态（:9 注释）——UI 无需自建快照协议。

### 2.2 Modal 联合类型（view-state.ts:10-17）

主区域永远是聊天，面板切换通过 modal 叠加（view-state.ts:1-2）：`none / settings{section?} / command-palette / confirm / fs-browser / prompt / help`。`COMMAND_TO_MODAL`（:24-30）只映射打开 modal 的命令（/config /model /skills /mcp /help）；信息类命令（/context /status 等）不打开 modal，而是展开右侧面板 + toast（:26-28 注释）。

## 3. 关键流程走查

### 3.1 app 装配（app.tsx:22-235）

1. **七个 hook 各自独立订阅 port**（:23-28）：useChatState / useSessions / useSkills / usePanelData / useTurnTracking / useUiChrome——多订阅合法（bridge 端 Set 监听器）；每个 hook 内部 effect 建立订阅、卸载退订，"各自独立订阅 port"是显式设计（app.tsx:15-16 注释）；
2. **safePost**（:34-45）：port.post 的 Promise 结果捕获——用户操作失败时 toast 提示（WebUI 上行是异步 fetch，与 TUI 同步通道不同，错误必须显式兜住）；
3. 三栏布局（:108-195）：Sidebar（项目树/会话/设置/主题）→ TopBar（provider/model/cwd/连接状态/命令面板）→ ChatView → PermissionBanner（挂起权限时插在输入区上方，:170-177）→ InputBar；右侧 InfoPanel；
4. **模态层**（:197-228）：settings / command-palette / confirm / help / prompt / fs-browser 按 modal.kind 条件渲染；
5. 确认弹层覆盖不可逆操作：/clear、删除会话、删除项目（逐个 delete_session + forgetProject，:95-106）——与 TUI 的确认菜单同一立法。

### 3.2 四数据域 hook 逐个

**① use-chat-state**：shared reducer 的直接消费（与 TUI use-chat 同构）——blocks/status/partial/toolActive/pendingTool；`dispatch({type:'local_user'})` 本地即时回显 + port.submit。

**② use-sessions**（use-sessions.ts:8-33）：只关心 session_list / session_deleted / session_ready / finished / error。挂载即 list_sessions 播种；session_ready（切换/新建）与 finished/error（预览已随落盘更新）触发刷新；session_deleted 本地过滤。**knownProjects**（:20-26）：从 sessions 的 cwd 提取的项目集合**只增不自动减**——会话全删后项目仍显示，直到显式 forgetProject（"项目遗忘"语义，《09》§3.6）。

**③ use-skills**（use-skills.ts:6-19）：挂载播种 skills_request；只保留 `enabled && !missing` 条目（:17）——**斜杠联想/Cmd+K 不该出现停用与孤儿**；设置页 Skills section 单独订阅 skills_list 全量（含状态字段）做启停管理（:9-10 注释）——同一广播两个消费粒度。

**④ use-panel-data**（use-panel-data.ts:14-56 区域）：config_state/config_updated → config 镜像；status_state → cwd/sessionId/statusBar；session_ready → sessionId + **清空旧会话的面板数据**（contextState 置 null——"新会话的数据需要重新请求"，:53-55）；context_state/system_state/log_state/permissions_list/tools_list 各自镜像；compaction/finished 也驱动刷新。暴露 refreshContext/refreshLog 供面板按钮。

**⑤ use-turn-tracking**（use-turn-tracking.ts:8-56 区域）——最精细的域：

- 挂载即 `permissions_request + tools_request` 播种（:40-42）——**浏览器刷新后镜像为空，需要从后端播种**（:40 注释）；
- `identitiesRef`（tools_list 镜像，:33-34 声明、:46 回填）：effectivePerm 判定 MCP 服务键规则必需（服务键按身份命中，《06》§3.3）——权限展示与 agent 引擎用同一身份事实；
- `sessionRules` ref：permissions_list 广播的副本，供 `effectivePerm`（shared）区分"配置永久 allow"与"会话提升 always/scoped"的展示来源（:22-24 注释）；
- **权限决策关联**：permission_request → pendingRef + setPendingPermission（ref 镜像立法——"订阅回调是首渲染闭包，读 state 恒为 null"，:36-37 注释，与 TUI 同款教训）；resolve 时记录 toolName→decision 映射，tool_start 到达时关联决策标签（permissionDecisions，:29-30）；state 离开 waiting_permission → 关横幅（:54-56）；
- tool_start/tool_end 经 `logic/tool-tracking.ts` 纯函数（applyToolStart/applyToolEnd/extractFilesTouched）维护 toolCalls 与 filesTouched；error → retryText（错误重填，与 TUI onErrorRetry 同语义）。

### 3.3 信息面板八卡（components/info-panel/view.tsx:105-279）

`InfoCard` 卡片式可折叠 section（:282-297）+ highlight（命令反馈高亮）+ defaultOpen：**Status & Model**（会话名 + provider/model + 状态 pill）、**Context**（估算/窗口渐变进度条 + 五段 breakdown + lastTurn 真实用量并排 + 会话累计——"双口径"展示，《09》§3.7）、**Tool Calls**（turn-tracking 的 toolCalls 列表）、**Files Touched**、**Available Tools**（身份分组）、**Session Permissions**（默认折叠，含 revoke）、**System Prompt**（默认折叠）、**Log Tail**（默认折叠）。

### 3.4 设置五区（components/settings/view.tsx:15-43）

左侧导航 General / Models / Permissions / Skills / MCP Servers 五个 section：General（shellProgram/maxIterations 等标量）、Models（provider/model 增删改）、Permissions（PermissionsSection——v3 三桶编辑，与 TUI buildEntries 的权限树同构）、Skills（启停/CRUD/skill_content 编辑）、MCP（McpSection——transport 表单、启停、状态）。全部编辑走 config_set/add/remove 与 skills_manage/mcp_manage 消息，agent 侧校验回滚后 notice（channel 定位）回显。

### 3.5 命令与反馈回路（app.tsx:47-106）

InputBar 输入 → parseCommand（shared）→ 命令分派：`onCommandNav` 按 COMMAND_TO_MODAL 开 modal；`onCommandFeedback`（:73-85）：/cd → fs-browser 弹框、/rename → prompt 弹框（预填原名——title 优先回退 preview，:60-66）、/skills /mcp → settings 定位 section、信息类命令 → `getCommandFeedback(cmd)`（shared）映射到面板 section 高亮（highlightInfoSection 计时高亮，chrome hook）。

### 3.6 输入栏（components/input-bar/view.tsx:26-58 区域）

- **容器式 textarea** + 底部工具栏（Slash 快捷菜单 / MoreHorizontal / Eraser / Archive / Plus / FolderPlus 图标按钮）+ 发送/停止切换（isRunning 时 ArrowUp 变 Square）；
- **斜杠联想**：`matchCommands(input, skills)` 与 skill 命令同池（shared/commands.ts:31）；suggestIdx 走 **ref 镜像**（:31-32 的 suggestIdxRef + setSuggest 成对——与 TUI 同款闭包过期教训）；
- **输入历史**（:27-28）：ArrowUp/Down 在输入框为空时回溯（inputHistory + historyIdx，-1 = 非浏览态）——与 TUI handleHistoryKeys 同语义；
- **错误重填**（:54-57）：App 传 retryText 时自动回填输入框并 onRetryConsumed——与 TUI onErrorRetry 同一立法的 WebUI 形态；
- **快捷菜单点外收起**（:34-41）：document mousedown 监听 + contains 判断，卸载清理。

### 3.7 聊天区与消息块（components/chat-view + message-block）

ChatView 消费 use-chat-state 的 ChatState（blocks + partial + toolActive + pendingTool），渲染共享 reducer 产出的语义 Block（kind + colorToken，ADR-0003）；每块按 kind 映射 Lucide 图标与 CSS 变量色（theme/token-map 的 WebUI 侧）。**自动滚动**（chat-view/view.tsx:17-18）：`endRef.scrollIntoView({behavior:'smooth'})` 在 blocks 变化时触发——流式期间跟随输出。message-block 内部由 tool-display 的"回执即契约"解析器渲染工具标题与 diff（edit_file 行号锚点、grep 命中前缀）。

### 3.8 连接状态与 Toast（main.tsx + use-ui-chrome）

1. `Root`（main.tsx:14-20）：`useState(() => createSseUiPort(setConnState))`——port 与连接回调在首渲染一次性建立；连接状态传给 TopBar 指示器；
2. use-ui-chrome（use-ui-chrome.ts:33-36 区域）：prevConnState ref 记录上一态——**首次**从 connected 变为非 connected 时 toast 提醒（重连抖动不重复打扰）；
3. toast/highlight 各有计时器 ref（:13-14），重复触发重置计时——highlightInfoSection 驱动信息面板对应 InfoCard 的短暂高亮（onCommandFeedback 的信息类命令反馈）。

### 3.4.1 设置五区的数据通路

五个 section 的写路径全部收敛到同一批上行消息，后端校验/回滚/广播后经 config_updated / skills_list / mcp_list 回流刷新：

| Section | 写原语 | 读数据 |
|---|---|---|
| General | `config_set`（顶层标量：shellProgram/maxIterations/maxRetries） | panel.config |
| Models | `config_add('providers')` / `config_remove` / `config_set('providers.<i>.<field>')` | panel.config |
| Permissions | `config_set('permission.<bucket>', 整桶对象)` | panel.config + permissions_list |
| Skills | `skills_manage`（create/update/delete/get/toggle） | skills_list（设置页消费全量含停用/missing） |
| MCP | `mcp_manage`（save/delete/toggle，scope 区分 global/project） | mcp_list（transport 明细编辑预填） |

编辑失败（zod 回滚/名称冲突/服务键裸名）以 `notice` 回流——General/Models/Permissions 区以全局 toast 呈现，Skills/MCP 区经 `channel` 字段内联定位到对应 section（agent-to-ui.ts:39 契约立法的 WebUI 消费）。

### 3.4.2 侧栏与命令面板

- **Sidebar**（app.tsx:110-129）：项目树（cwd 分组 + knownProjects）→ 会话列表（title || preview + updatedAt 排序）→ 新建会话（可选 cwd：openAddProject 走 FsBrowserModal）→ 删除会话/项目（confirm 弹框）→ 设置入口 → 主题切换（chrome.setTheme）；折叠态由 data-sidebar-collapsed 驱动 CSS；
- **CommandPalette**（app.tsx:201-216）：Cmd+K 总入口——会话切换、技能执行、主题、设置导航、新建/清空等命令合一，skills 传 `use-skills` 的过滤池（停用/孤儿不出现）。

## 4. 与 TUI 的对称与 shared 层

- **消息同源**：管理操作（配置/MCP/Skills/权限）两端发同一套消息（config_set/skills_manage/mcp_manage/permission_*），agent 无端感知（main.tsx:8-9 注释："与 TUI 的 renderTui(uiPort) 对称——唯一区别是传输方式"）。
- **ui/src/shared/ 双端共用**（architecture.test.ts:52-55 断言其不依赖 agent）：
  - `reducer.ts`：消息 → ChatState 块流（flush 落盘 partial、rebuildBlocksFromHistory 按 tool_call_id 结构化重建历史、thinking 一一对应消费）——两端聊天区的唯一事实转换器；
  - `commands.ts`：parseCommand/matchCommands（skill 命令动态并入联想池）；
  - `permission.ts`：effectivePerm / 权限徽章判定；
  - `tool-display.ts`：formatToolTitle/Body（"回执即契约"的消费端，与工具回执格式联动）；
  - `status.ts`：状态标签与 isStateRunning。
- **意图一致、形态各异**：同一 returnView/确认弹层/intent 标志等立法在两端有形态不同的等价物（TUI View vs WebUI Modal；TUI menu 确认 vs ConfirmModal）。

## 5. 关键立法与不变量 / 失败模式与恢复

| 不变量 / 失败 | 机制 | 恢复 |
|---|---|---|
| INV 下行消息必须过 zod | sse-client safeParse，失败丢弃（:32-36） | 坏消息不进任何 hook，UI 不断流 |
| INV 多订阅合法、卸载退订 | 各 hook 独立 effect + off | 无泄漏 |
| INV 刷新后镜像必须播种 | 挂载即 permissions/tools/skills/sessions 请求（各 hook） | 浏览器 F5 自动恢复完整状态（session_ready） |
| INV 块渲染语义化（ADR-0003） | Block 只有 kind+colorToken；WebUI 的 theme/token-map 负责语义→Lucide 图标/CSS 变量的映射——不继承终端色码 | 两端主题独立演进 |
| 失败：SSE 断连 | EventSource 自动重连；onerror 区分 reconnecting/disconnected（:42-50） | 重连成功 → agent session_ready 全量恢复；首次断连 toast |
| 失败：POST 失败 | safePost catch → toast（app.tsx:34-45）；InputBar onPostError | 用户重试；retryText 预填 |
| 失败：渲染异常白屏 | ErrorBoundary 包 Root 与各区域（main.tsx:33-37、app.tsx 的 area 分区） | 局部降级不整页崩 |
| 失败：权限横幅悬挂 | pendingRef + state 离开 waiting_permission 即关（use-turn-tracking :54-56） | cancel/决议后 UI 收敛 |
| 失败：旧会话面板数据残留 | session_ready 清 contextState 等（use-panel-data） | 新会话数据重新请求 |
| 失败：管理操作被拒绝 | notice channel='skills'/'mcp' 定位到设置区对应 section 内联显示 | 原地修正重提交 |
| 失败：输入历史与联想误触发 | 输入非空时 ArrowUp/Down 只走历史、空输入才回溯（input-bar view.tsx:27-28）——与 TUI 同语义 | 无需恢复 |

## 6. 与其它子系统的接缝

- **→ 01 契约**：上行/下行消息、zod schema 全部来自 bridge；WebUI 是 `agentToUiMessageSchema` 的唯一浏览器端消费方。
- **→ 01/07 server**：静态产物被 HttpServer 托管；/api/fs（目录浏览 → FsBrowserModal）与 /api/shells（shell 检测 → 设置区解释器选择）是 WebUI 专属 HTTP 端点（server/src/http/router.ts:31-46）。
- **→ 06 权限**：PermissionBanner 四档决议 + alwaysScope；effectivePerm 用 identitiesRef 做服务键判定。
- **→ 08 skills / 07 MCP**：use-skills 双粒度消费；settings 五区。
- **→ 09 会话**：侧栏项目树（cwd 分组）、删除项目 = 逐会话 delete_session、knownProjects 遗忘语义。
- **→ 02 轮次**：ChatView 的流式渲染消费 text_delta/thought_delta/tool_pending/tool_end——与 TUI 同一份 reducer 逻辑，状态语义零漂移；错误重填（retryText）对应轮次 error 消息。
- **→ 10 配置**：panel.config 镜像 + config_set/add/remove——设置区 General/Models/Permissions 的全部写路径（§3.4.1），agent 侧校验回滚经 config_updated 回流。
- **→ 11 TUI**：shared 层与立法对称性见 §4；两前端互不依赖由架构测试保证。
- **← server 的 dev 模式**：VITE_DEV=1 时 staticDir 为 null（main-web.ts:35-38），前端由 Vite dev server 代理 API——根目录 vite.config.ts 配置 `/api` 代理到 3001 端口（main-web.ts 以 VITE_DEV=1 PORT=3001 启动），并显式关闭代理缓冲/超时让 SSE 流式响应实时透传（vite.config.ts 的 proxy.configure）。
