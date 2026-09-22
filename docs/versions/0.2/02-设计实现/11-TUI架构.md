# 11 - TUI 架构

> 职责：终端界面（`ui/src/tui/`，Ink/React）——渲染分层（Static/动态）、视图态联合类型 + 按键分派构成的弹层体系、配置树编辑器、与 agent 的消息交互。它只 import `@dogegg/bridge`（消费 `channel.uiPort`），与 WebUI 零代码共享界面实现，共享逻辑全部下沉 `ui/src/shared/`。

## 1. 职责与边界

| 目录/文件 | 职责 |
|---|---|
| `ui/src/tui/app/app.tsx` | 装配层：chat 数据域 + 视图事件域 + 键盘路由 + 布局渲染 |
| `ui/src/tui/app/use-chat.ts` | chat 数据域：每条 agent 消息进 shared reducer |
| `ui/src/tui/app/use-agent-events.ts` | 视图事件域：消息 → overlay 开合/状态栏/清屏重挂 |
| `ui/src/tui/app/use-key-routing.ts` | 键盘路由：全局拦截 → 按 view.kind 分派 features/*/keys |
| `ui/src/tui/view-state.ts` | View 联合类型（弹层体系唯一状态）+ SkillEntry/McpServerEntry |
| `ui/src/tui/features/config/` | 配置树编辑器：buildEntries（双端共用）/ navigation / keys / view |
| `ui/src/tui/features/*/keys.ts` | 各弹层纯逻辑按键处理器（测试注入 spy api） |
| `ui/src/tui/components/` | TopBar / MessageBlock / StatusBar / MultilineInput / PendingTool 等 |
| `ui/src/tui/theme/` | palette（纯数据）+ registry（可变单例）+ token-map |
| `ui/src/tui/markdown/` | markdown → 带色文本（Static 渲染前一次性转换） |
| `ui/src/shared/` | 双前端共用：reducer/block/commands/permission/tool-display/status |

## 2. 核心数据结构

### 2.1 View 联合类型全列（view-state.ts:28-38）

```ts
export type View =
  | { kind: 'none' }
  | { kind: 'permission'; id, tool, input, alwaysScope?, cursor }
  | { kind: 'menu'; title, items: { label, onSelect }[], cursor, returnView? }
  | { kind: 'sessionPicker'; sessions, cursor, query }
  | { kind: 'prompt'; title, value, onSubmit, returnPath?, returnCursor?, returnView? }
  | { kind: 'skills'; cursor, skills: SkillEntry[] }
  | { kind: 'mcp'; cursor, servers: McpServerEntry[] }
  | { kind: 'config'; path: ConfigPath, cursor, preview: boolean | null }
  | { kind: 'info'; title, lines, returnView? }          // /context /tools /status /system /log /help
  | { kind: 'form'; title, fields: FormField[], cursor, returnView, submitLabel, onSubmit }
```

View 是 **UI 自己的视图态**，与后端状态机（State 十态）正交叠加（view-state.ts:4 注释）。两个立法注解直接写在类型上：`returnView`——面板内钻入的弹层 esc 回来源视图，不存在"一次 esc 丢整个面板层级"（:31, :37 注释）；`FormField` 的 `options` 存在 = 固定选项字段（Enter 循环切换），否则文本字段（Enter 弹 prompt 编辑），`readonly` = 身份锁定行（:40-47）。

### 2.2 ChatState（shared/reducer.ts:7-15）

`blocks: Block[]`（已落盘块）+ `status: State` + `partial`（未落盘流式块）+ `toolActive`（最后 tool 块未收 tool_end——Static 模式不能固化打印）+ `pendingTool`（tool_pending → tool_start 之间的准备中提示）。reducer 的输入是 `AgentToUiMessage | { type:'local_user' }`（:13）——**后端消息与本地动作同池**。

## 3. 关键流程走查

### 3.1 渲染分层（Static/动态，app.tsx:318-472）

- **Static 区**（app.tsx:334-349）：品牌头（TopBar）+ 已完成的消息块——`<Static>` 打印一次即进终端原生滚动缓冲，永不重绘；历史用终端滚动查看，Ink 只重绘底部动态区（:33-34 注释，Claude Code 式）。块渲染前完成 markdown → 纯文本转换（:337-345，Static 只渲染一次无性能问题）。`staticKey` 是 Static 的重挂载 key——会话切换/清空/主题切换时清屏重绘（Static 已输出内容无法就地修改，:86-88 的 clearScreenRemount）；
- **稳定/活跃分界**（:321-329）：`toolActive` 时最后一块未完成留动态区（stableCount = blocks.length - 1）；品牌头**延迟打印**——启动瞬间 config/status 未回，先打印会定格在"加载配置中…"，等 `configSnapshot !== null && statusBarData.cwd !== undefined` 才进 items（:320-321）；
- **动态区**（:351-458）：未完成块 + 流式 StreamingBlock + PendingTool + 联想列表 + 输入框 + 全部 overlay + BrowseStatusBar；StatusBar 恒在底部。

### 3.2 消息订阅的两个正交域（use-chat.ts:8-21 + use-agent-events.ts:50-56）

- `useChat`：订阅 port → 每条消息 dispatch 进 reducer（认识全部消息类型）——**数据域**；
- `useAgentEvents`：同一 port 的第二个订阅（**多订阅合法**，InMemoryChannel 用 Set 存监听器）——**视图侧效应**：permission_request 开权限弹层、session_ready/history_cleared 清屏重挂、session_list 只刷新"已打开的"选择器并同步标题进状态栏（:60-77 区域）、error 自动重填上次提交文本（onErrorRetry）、状态/清单镜像更新；
- deps 经 ref 读取——订阅只建立一次，重复建立会反复重发 config_request/status_request（:50-51 注释）；
- **intent 标志区分显式请求与后台播种**（app.tsx:49-52）：`explicitInfoRef`（/context /status 等显式命令才开 info overlay，2s 轮询静默）、`toolsIntentRef`（/tools 独立标志——tools_list 有挂载/config_updated 的后台播种，共享标志会被误消费："编辑配置后立刻 /context，播种响应先到会抢开工具面板"，:281-282 注释）、`configIntent`（/model vs /config 决定 config_state 打开哪个选择器）。

### 3.3 键盘路由（use-key-routing.ts:58-144）

1. **全局拦截最优先**（:68-84）：Ctrl+C——运行中发 cancel 消息；空闲且不在菜单 → 弹退出确认菜单（与 /quit 一致）；
2. **suppressEnter**（:59-65, :85）：吞掉紧随命令后的第一次回车——**port 是同步通道，命令的响应可能立即设新 view，不吞的话同一个回车被 useInput 在新 view 里再处理一次（误选中第一项）**（:60-61 注释）；实现是 ref 置位 + queueMicrotask 复位；
3. **按 view.kind 分派**（:86-141）：switch 每个分支调对应 `features/*/keys.ts` 的 handler——handler 是**纯逻辑函数**（view, key, api 注入），测试注入 spy api 即可单测（:57 注释）；本文件只做分派不做判断；
4. **none 态分派顺序即优先级**（:131-140）：联想（斜杠命令 + skill 命令同池）→ @path 联想 → 浏览（Ctrl+Up/Down 块间焦点）→ 历史（仅在非浏览模式）。

### 3.4 配置树：buildEntries 双端共用（features/config/）

- **ConfigPath 联合类型**（navigation.ts:1-14）描述钻取层级：root / permission / permissionBucket / permissionTool / providers / provider / models / model / selectProvider/Model/Shell/Theme/Tool——共 14 种 kind；`parentPath`（:16-33）返回父层，esc 沿链逐级回退；
- **Entry 联合类型**（entries.ts:4-17）描述每层条目的呈现/交互形态：`scalar`（回车 → 输入带当前值，可带 del）/ `prompt`（新增输入）/ `bool`（←→ 切换）/ `goto`（回车钻入子路径）/ `action`（执行回调，可带 `afterRunPath` 执行后直接钻入——"选择即钻入"免去 esc 退回再钻入的往返，:15-16 注释）；
- **buildEntries(config, path, treeCtx, tools)**（build.ts:8-）是纯函数：给定配置与路径产出当层条目。**渲染层（ConfigOverlay）与按键层（handleConfigKeys）共用同一份 entries**——app.tsx:308-309 算一次存进 `configEntriesRef`，按键层经 `deps.configEntries()` 复用（use-key-routing.ts:29-30："杜绝两处 buildEntries 漂移"）；
- **TreeCtx**（entries.ts:20-27）是三类变更入口：set/add/remove 翻译成 config_set/add/remove 消息（app.tsx:122-128）+ openSkills/openMcp 面板入口——配置树对 skills/MCP 管理是跳转而非重复实现；
- 权限桶编辑（build.ts 的 permissionBucket/permissionTool 分支）直接消费 v3 结构化形态：整键开关行（whole 显式字段，"空选可表达——开关恒可用、状态恒与引擎一致"）、MCP 服务键用运行时工具清单（tools 参数，身份过滤）做勾选式细化——TUI 与 WebUI（settings/permissions）共用此 build 逻辑。

### 3.5 表单视图（features/form/）

通用多字段表单（/mcp、/skills 的新建/编辑共用，view-state.ts:38）：一行一字段；Enter 编辑文本（弹 prompt，returnView 回表单——已填字段不丢）或循环选项；s 或保存行提交（onSubmit(values)；校验失败留表单）；readonly 行锁定身份字段。skills/mcp 面板的编辑按钮构造 fields 并携带 returnView。

### 3.6 ref 镜像教训（app.tsx:66-74）

**立法**：Ink 的 useInput 回调读 state 拿到的是**旧值**（闭包过期）——凡按键层需要的状态都走 ref 镜像。镜像清单：viewRef、configRef、configEntriesRef、statusRef、cwdRef、blocksRef、suggestCursorRef、browseIdxRef、expandedRef、inputHistoryRef、historyCursorRef。每个 setter 都是"ref + setState 成对"（如 app.tsx:42 的 setSuggestCursor、:83 的 setView）。这是本域最重要的工程教训，写进了 use-key-routing 的接口注释（:23）。

### 3.7 命令提交流程（app.tsx:217-304 的 handleSubmit）

1. @path 联想拦截：末尾有 @token 且选中候选 → 回车替换为补全路径而非提交（Esc 关闭后不拦截，:219-225）；
2. 斜杠联想拦截：有匹配且选中 → 回车补全而非提交（:227-231）；
3. `parseCommand(raw, skillsList 名单)`（:233）——shared 层解析：user 文本 → dispatch local_user + port.submit；help → info overlay；clear/quit → 确认菜单（不可逆操作，:256-274）；config_request → 打 intent 标记；信息类请求 → explicitInfoRef；list_sessions/skills_request/mcp_request → 先开面板壳、响应到达后填充（:289-296）；
4. **统一 suppressEnter**（:300）后 post 消息。

### 3.8 两个 keys 处理器的内部走查

**handlePermissionKeys**（features/permission/keys.ts，经 use-key-routing.ts:88-89 分派）：权限弹层的四档决议是本系统安全链路的最后一跳——↑↓ 移动 cursor（四档 = allow_once / allow_always / allow_always_scoped（仅 alwaysScope 存在时渲染）/ reject），回车把 `permission_decision{id, decision}` 经注入的 `post` api 发出并 setView 回 none。api 注入模式让该处理器可注入 spy 后单测（决议消息的形状回归被锁定）。

**handleConfigKeys**（features/config/keys.ts，:96-97 分派）：消费渲染层算好的 entries（`deps.configEntries()`）——按 cursor 取当前 Entry，按 kind 分派：scalar → 开 prompt 弹层（returnPath/returnCursor 回原层原位）、bool → ←→ 切换、goto → setView 钻入 subPath、action → run() 后若有 afterRunPath 直接钻入、esc → parentPath 回退（null 则关编辑器）、d → Entry.del 删除。**按键层零业务判断**：一切"这一层有什么、行为是什么"都在 buildEntries 的纯函数世界里。

### 3.9 主题体系（theme/）

- **palette.ts 是纯数据**（palette.ts:1-16 注释）：每套主题一个 12 token 的调色板（surface/surfaceAlt/border/faint + accent/green/yellow/cyan/red/purple 五色状态系统）；可变状态不在此文件；
- **registry.ts 是唯一可变持有者**（registry.ts:5-27）：`ThemeRegistry` 显式类实例（替代旧模块级 let 单例），set() 时通知 onChange 监听者——App 订阅它做清屏重挂（app.tsx:88），ThemeProvider 订阅它做 React 重渲染；
- **palette Proxy 兼容层**（registry.ts:34-38）：组件与纯函数继续 `palette.x` 取色，get 透传到 themeRegistry——可变状态收归注册表而组件零改动（token-map.ts 负责 Block 语义 token → palette 色的映射）。/config 树的 selectTheme 层列出 `themeRegistry.list()`，切换即触发上述两路刷新。

### 3.10 会话选择器与信息面板

- **sessionPicker**（view-state.ts:32）：`{sessions, cursor, query}`——/session 先开空壳、session_list 响应填充；query 输入即过滤（features/sessions/filter.ts），d 键删除会话（发 delete_session 消息，后端 session_deleted 后列表刷新）；当前会话标记由 cwd（currentCwdRef）辅助；
- **info**（view-state.ts:37）：纯只读 `{title, lines}` + returnView——/context /tools /status /system /log /help 六个命令共用一个视图壳，独立翻页状态 infoScroll；notice 提示也复用它（带 returnView 回来源面板，use-key-routing.ts:108-113）。

### 3.11 组件层与 markdown 渲染

- **components/**（components/index.tsx 为 barrel）：TopBar（品牌头 + provider/model + cwd）、MessageBlock（Block → 折叠/展开的语义卡片，expanded 由浏览模式的 expandedRef 控制）、StatusBar（状态/会话名/token/usage/cwd 一行式）、MultilineInput（Enter 发送、Ctrl+J/Alt+Enter 换行——app.tsx:429-430 的提示行）、PendingTool（tool_pending 空窗期提示）、StreamingBlock（partial 流式块）；
- **markdown/render.ts**：markdown → 带色纯文本，**只在进 Static 前调用一次**（app.tsx:337-345）与流式 partial（app.tsx:356-360）两个入口——Static 的块转换结果被终端缓冲区永久持有，性能无忧；
- **components/list-picker**：menu/sessionPicker 共用的选择列表原语（光标渲染 + 滚动），keys 处理器与之解耦；
- **app/entry.tsx** 的 renderTui：Ink render 的入口（bin/dogegg.ts:67 调用），clearScreen 与 resetSigintTimer 也在此——Ctrl+C 双击退出的计时逻辑（use-key-routing.ts:70 的 resetSigintTimer 调用点）归 entry 管理。

## 4. 关键立法与不变量

- **INV-1 Static 不可变**：进 Static 的块永不重绘；一切"改变历史"的操作（会话切换/清空/折叠切换/主题切换）= 清屏 + staticKey 重挂。
- **INV-2 弹层唯一状态源**：所有 overlay 的开合由 View 联合类型表达；同一时刻至多一个 overlay。
- **INV-3 returnView 层级保持**：面板内钻入的弹层 esc 回来源视图。
- **INV-4 按键逻辑纯函数化**：features/*/keys 不持有状态、不直接订阅；api 注入。
- **INV-5 双域正交**：reducer 管数据、use-agent-events 管视图效应，两个订阅互不越界。
- **INV-6 intent 标志隔离**：显式请求与后台播种的响应互不误消费。
- **INV-7 use-agent-events 订阅单次建立**：deps 经 ref 读取（use-agent-events.ts:50-51）——重复建立订阅会反复重发 config_request/status_request，这是 hook 依赖数组立法的由来。
- **INV-8 配置树视图/按键同源**：entries 由渲染层 buildEntries 计算一次、经 configEntriesRef 供按键层复用（app.tsx:308-309）——任何层级行为改动只改 build.ts 一处。
- **INV-9 退出必须确认**：/quit 与空闲 Ctrl+C 都弹确认菜单（app.tsx:266-274、use-key-routing.ts:75-82）——不可逆操作零直达。

## 5. 失败模式与恢复

- **闭包过期读到旧 state**：ref 镜像立法（§3.6）系统性消除；新增按键层状态必须成对建 ref。
- **同步通道回车误击**：suppressEnter 机制（§3.3 第 2 步）；漏标 suppressEnter 的 overlay 打开路径会产生"回车误选第一项"——所有开 overlay 的命令统一吞回车（app.tsx:297-300）。
- **Static 内容定格错误**：品牌头延迟到数据就绪才打印（app.tsx:320-321）；主题切换走 clearScreenRemount 重绘。
- **权限请求中取消**：use-agent-events 监听 state 迁移——离开 waiting_permission 时 permission overlay 自动关闭（use-agent-events.ts 的 state 分支）。
- **后台播种误开面板**：intent 标志（§3.2）；选择器未开时 session_list 推送被忽略（"每次改名都蹦出列表"的回归被注释立法拦住）。
- **联想光标残留**：输入变化即复位 suggestCursor（app.tsx:80-81）——残留选中会让下次回车误补全而非提交。
- **编辑器交互破坏 raw mode**：openInEditor 暂停 raw mode → spawnSync 阻塞 → finally 恢复 + 清屏重挂 + 重拉清单（app.tsx:90-102）。
- **流式输出期间状态栏 token 过期**：运行中每 2s 轮询 context_request（app.tsx:209-214，idle/finished/cancelled/error 态自动停止）——StatusBar 的 tokens/windowTokens 实时跟随。
- **会话切换后的残留 UI 态**：onSessionCleared 统一复位（联想光标/浏览焦点/展开集合，app.tsx:104-109）——散落各处的复位点收敛为一个回调，防漏。

## 6. 与其它子系统的接缝

- **→ 01 契约/通道**：消费 `channel.uiPort`（bin/dogegg.ts:67 传入）；同步投递语义被 suppressEnter 与 intent 机制依赖。
- **→ 12 WebUI**：shared/ 层（reducer/commands/permission/tool-display）双端共用；buildEntries 被两端配置编辑复用；管理操作发同一套消息。
- **→ 10 配置**：config_set/add/remove + config_state/config_updated 全链路；buildEntries 的权限树直接镜像 v3 形态。
- **→ 06 权限**：permission overlay 渲染四档决议（含 alwaysScope 第四档）；decisions.ts 翻译按键 → permission_decision 消息。
- **→ 08 skills / 07 MCP**：/skills 与 /mcp 面板 + form 表单 CRUD；skills 面板"改"走系统 $EDITOR（openInEditor）或 update 消息。
- **→ 05 工具展示**：MessageBlock 渲染 Block 时按 kind 分派展示（user 横幅 / thinking 折叠 / tool 卡片含 diff）——tool 卡片的标题与正文解析来自 shared/tool-display 的"回执即契约"实现，与《05》INV-5 的格式立法闭环。
- **← entry.tsx**：`clearScreen`（ANSI 清屏序列）与 `resetSigintTimer` 是 app 层两个全局副作用的家——从 app.tsx 分离使它们的调用点（清屏重挂、Ctrl+C 计时）在模块边界可见。
- **← use-chat.ts**：chat 域是唯一把 reducer 全量喂消息的订阅——view-state 的弹层开合不在 reducer 里（那是 use-agent-events 的职责），保证"数据状态"与"界面状态"各自可独立测试与复述。

### 7. 与 Claude Code 式终端交互的取舍

本架构有意采纳的三个交互决策（均可在代码注释中找到理由）：历史进终端原生滚动缓冲而非 alt-screen 自绘滚动（ADR-0008）；输入框固定底部、overlay 在其上叠加而非整屏替换——保留对话上下文的视觉连续性；skill 命令与内置命令同池联想（app.tsx:310 的 skillCommands 并入 matchCommands），用户无需记忆"哪个命令是哪来的"。
