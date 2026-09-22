# R-WEB WebUI交互

浏览器界面（React + Vite，SSE 通道）：与 TUI 共享同一 agent 与消息契约——同一能力的双端呈现，管理操作走同一套 agent 消息，无各自后端。

## 工作原理概述

**通道与端口形态。** WebUI 不直连 agent——server 只做通道与静态托管：

- 下行 `GET /api/events`（SSE，text/event-stream，多标签页共享同一 agent 事件流——每个标签的 EventSource 都是同一 Agent 的观察者）；
- 上行 `POST /api/message`（body 为 JSON，zod 校验非法丢弃/400）。

前端把这对通道封装为 UiPort（createSseUiPort）：EventSource 断开后浏览器自动重连，重连成功时后端推 session_ready 恢复完整状态；连接状态（connected/reconnecting/disconnected）经回调通知 UI——顶栏指示器 + 状态变化 toast（「Reconnected」/「Connection lost」/「Reconnecting...」）。下行消息同样过 agentToUiMessageSchema——校验失败的垃圾消息在进入任何 reducer 之前就被丢弃。

**特征化 hook 架构。** App 组件只做「特征装配 + 三栏布局」，数据域拆在五个独立订阅 port 的 hook 里：

- useChatState：聊天状态，复用与 TUI 共享的 reducer 纯函数；
- useTurnTracking：工具执行与审批生命周期——toolCalls 追踪、filesTouched 提取、权限挂起、决策关联、重试回填；
- usePanelData：配置/状态/面板数据 + 会话恢复后的播种；
- useSessions：会话列表与项目分组；
- useSkills：技能清单镜像。

界面外壳归 useUiChrome（modal 总管、toast/highlight 计时器、面板折叠、主题、Cmd+K）。各 hook 只关心自己订阅的消息子集，互不耦合。

**权限徽章的判定链。** 工具块的权限徽章需要区分四态：配置放行 ALLOW / 会话提升 ALWAYS / 待审批 ASK / 被拒 REJECTED。判定链：effectivePerm 用 bridge 的 classifyPermission 做 display-only 判定（不传 args——参数化规则 fail-closed 不命中），注入两个镜像：工具身份镜像（tools_list 广播的 identity——MCP 服务键规则按身份命中才正确）与会话提升镜像（permissions_list 广播，决策时乐观更新不等往返）；Tool Calls 行的最终标签再叠加用户显式决策（displayPerm：决策优先于快照——ask 工具被询问后必有决策）。

**主区域永远是聊天。** 与 TUI 的 view 栈不同，WebUI 的一切面板切换走 modal 叠加（settings/command-palette/confirm/fs-browser/prompt/help），右侧信息面板是常驻可折叠列。命令的界面映射：打开 modal 的命令走 COMMAND_TO_MODAL（/config /model → settings、/skills → settings.skills、/mcp → settings.mcp、/help → help）；信息类命令（/context /status /tools /system /log /permissions）不打开 modal——展开右侧面板 + 高亮对应卡片 3 秒。

## 需求点

### R-WEB-01 聊天区

**需求动机**：聊天区是主交互面——用户需要一眼分辨消息类型、工具执行状态与授权来源；工具调用细节（命令输出、diff）要按需展开而非全部平铺。

**详细行为**：

- 用户/助手消息 markdown 渲染；思考内容以折叠块呈现（与正文分通道）。
- 工具调用块四要素：
  - 状态图标（执行中旋转/完成/失败/拒绝四态，来自 toolStatus done/error/rejected/running）；
  - 折叠头（工具名 + 参数摘要 + 结果摘要——如「$ pnpm test · 32 行输出」）；
  - **权限徽章**（ALLOW/ALWAYS/ASK/REJECTED，判定注入工具身份镜像——MCP 服务键规则在徽章上正确生效）；
  - 折叠/展开。
- 展开按工具精修：命令与输出分层、edit_file 渲染 diff 带真实行号（解析回执锚点）、超大输出 200 行封顶。
- 模型生成工具参数期间（tool_pending → tool_start）显示「正在调用 X…」占位。
- ask 调用弹出**审批横幅**（PermissionBanner，输入区上方常驻）：工具名 + 参数 + 四档决策（本次允许/始终允许/对此范围不再询问 + 推导模式/拒绝），范围模式自动推导由 permission_request 随行下发。

**边界与失败模式**：

- 决策期间状态离开 waiting_permission（如取消）→ 横幅自动关闭（pendingRef 镜像 + state 消息监听）。
- error 消息把流式 partial flush 落盘并追加红色错误块 + 回填重试文本。
- 会话切换（session_ready）按 history + thinking 重建全部块、清空旧会话的流式残留。

**场景走查**：模型调 shell → 聊天区出现旋转图标块 + 「正在调用 shell…」→ tool_end 后图标定格 ✓，徽章显示 ALWAYS（本会话提过权）→ 点击展开看命令与输出分层。

### R-WEB-02 设置弹框（五区）

**需求动机**：配置面宽（模型/权限/MCP/技能/运行时参数）——单一弹框内按域分区的导航，比多个入口统一，也比单页平铺可扫读。

**详细行为**：

- SettingsModal 左侧五导航（General/Models/Permissions/Skills/MCP Servers），右侧内容区，支持 initialSection 直达（/skills 命令 → skills 区）。
- **General**：systemPrompt（路径输入 + 文件浏览器选择 + 清除）、maxIterations、maxRetries、shellProgram（下拉，选项来自本机扫描 detectShells——只允许配置真实存在的解释器，带版本标注）、主题。
- **Models**：provider/model 增删改（name/protocol/baseURL/apiKey/models 逐字段表单，models 子表单含 contextWindow/maxOutput/reasoning），默认模型选择。
- **Permissions**：三桶折叠卡片——每条规则含整选开关（whole）、模式 chips 就地改名/删除、MCP 服务键**勾选细化**（该服务运行时工具清单勾选 + 通配 chips + 添加通配）、添加下拉（MCP 服务整组 + 内建工具，排除已有）。
- **MCP Servers**：全局/项目分组，状态卡片（状态点颜色 + 名称 + 传输/状态徽章 + 工具数 + 错误行），启停切换/编辑表单（类型/名称/command/args/env 或 url/headers）/删除确认。
- **Skills**：项目级/用户级两组列表，创建表单（落点/名称/描述），启停按钮，**缺失态清理**，编辑（全文编辑框），删除确认。

**边界与失败模式**：

- 所有编辑走与 TUI 相同的 config_set/add/remove 与 manage 消息——校验失败由后端回滚 + error 广播（编辑即报错不写坏配置）。
- 编辑态身份字段锁定（名称/落点）。
- 运行中管理操作被后端阻塞并 notice。

**场景走查**：用户 Cmd+K → 「Open Settings」→ Models 区新建 provider → 逐字段填写 → 保存 → config_updated → 顶栏模型名即时刷新。

### R-WEB-03 信息面板（右侧八卡）

**需求动机**：agent 的运行时状态（上下文占用、工具历史、可用工具、会话授权、日志）需要一个不打断聊天的观察面板——右侧可折叠列承载「随时可查」的一切诊断信息。

**详细行为**：

- 八个可折叠卡片：
  - **Status & Model**：状态 pill/会话名/模型；
  - **Context**：进度条 + 分段统计（system/user/assistant/tool/tools）+ 三口径用量（当前估算/最近一轮真实/会话累计）+ 压缩计数；
  - **Tool Calls**：序号/状态/名称/权限徽章（校验失败的调用也入列，提示带回退语义）；
  - **Files Touched**：从 tool_start 输入提取 edit/write 的路径 + 时间，会话内累计；
  - **Available Tools**：按来源分组可展开（系统工具组默认展开 + MCP 服务组默认收起，行内显示内部短名 + 权限徽章——身份随 tools_list 下发）；
  - **Session Permissions**：会话提升清单，每条可撤销（revoke 后清单即时重推）；
  - **System Prompt**：全文，卡片内独立滚动；
  - **Log Tail**：调试日志尾部，手动刷新按钮。

**边界与失败模式**：

- 面板展开时自动播种数据请求（context/system/log/tools/permissions 一组 request）。
- 对话进行中 context 每 3s 轮询刷新；compaction 消息到达即补发 context_request（压缩后进度条立即反映）。
- finished/error 后刷新 context 与 log（用量随落盘更新）。
- 会话切换清空旧会话的面板数据并重新播种（新会话不显示旧数据）。

**场景走查**：用户点开 Context 卡 → 看到 78% 进度条与分段统计 → 压缩发生 → 数字跳变为 4,200 并出现压缩计数 +1。

### R-WEB-04 斜杠联想

**需求动机**：与 TUI 同理——命令发现不能靠背表；WebUI 的联想还要处理「键盘选择 + 滚动跟随」的列表交互。

**详细行为**：

- 输入 `/` 弹联想浮层：内建命令 + skill 动态命令（停用/缺失不出现——可用条目过滤，与 TUI 同池逻辑）。
- ↑↓ 选择，高亮项自动滚入可视区（长列表不跟手会选错）；回车路由执行——选中候选时先补全，已完整时直接执行；esc 关闭。
- 命令执行后的界面映射见工作原理概述（COMMAND_TO_MODAL / 高亮信息面板）。

**边界与失败模式**：

- 输入框非空非命令文本正常提交。
- 运行中提交被后端闸门拒绝时 toast 提示。
- 联想与 @path 联想互斥（斜杠优先）。

**场景走查**：输入 `/re` → 浮层高亮 /rename → 回车弹重命名 prompt 弹框（预填原名）→ 确认后侧栏标题即时更新。

### R-WEB-05 Cmd+K 命令面板

**需求动机**：高频操作（开设置、切会话、新建会话、切主题）散落在各处——命令面板是「一键到达任意功能」的键盘捷径，也是鼠标用户的发现入口。

**详细行为**：

- Cmd+K（macOS）/Ctrl+K（Windows/Linux）全局快捷键开关面板（window keydown 捕获，preventDefault 防浏览器冲突）。
- 面板聚合：快速打开设置各分区（General/Models/Permissions/Skills/MCP）、常用操作（新会话/清空历史/切换主题）、会话列表（选中即 resume）、技能命令。
- 执行后关闭面板并路由到对应动作（多数走 COMMAND_TO_MODAL 的 modal 映射）。

**边界与失败模式**：

- 面板开着再按 Cmd+K 是关闭（toggle 而非叠加）。
- 清空历史在面板内触发也走确认弹层（不可逆操作不因入口不同而免确认）。

**场景走查**：用户 Ctrl+K → 输入 "mcp" → 选中「Open Settings: MCP Servers」→ 设置弹框直达 MCP 区。

### R-WEB-06 会话侧栏（项目树）

**需求动机**：多项目多会话的组织需要树形聚合——项目为组、会话为叶，配合「添加项目/遗忘项目」构成轻量工作区管理。

**详细行为**：

- 侧栏按项目（cwd）分组会话树：组头为项目路径，条目显示标题（title || preview）/更新时间/预览，当前会话高亮。
- 操作：新建会话（当前 cwd 或经目录浏览器选 cwd——new_session 带 cwd）、切换（resume）、删除（确认弹层 → delete_session）。
- 项目遗忘（删除其下全部会话 + 本地 knownProjects 清单移除——确认弹层明示「将删除 N 个会话的记录，项目目录本身不会被删除，可随时重新添加」）。
- 添加项目（目录浏览器选目录）。
- 标题同步：rename_session 后 session_list 广播驱动侧栏刷新。
- 侧栏可折叠（信息面板同样可折叠，独立状态）。

**边界与失败模式**：

- 分组依据是存档 cwd（见 R-SES-06）。
- 删除当前会话后侧栏出现「接管中」的新会话（首轮对话才落盘）。
- 会话操作失败（网络错误）经 safePost toast 提示——用户操作与静默刷新区分。

**场景走查**：用户点「添加项目」→ 目录浏览器选 `D:\work\blog` → 新会话在 blog 组下创建并激活 → /cd 落盘后该组永久可见。

### R-WEB-07 通道（SSE 下行 + POST 上行）

**需求动机**：浏览器无法与 Node 进程长连 stdin/stdout——SSE + POST 是「agent 推、UI 拉」语义在 HTTP 上的最小实现；server 不含业务逻辑是架构立法（四包解耦）。

**详细行为**：

- 下行 `GET /api/events`：SSE 响应头（text/event-stream + no-cache + keep-alive），连接注册进活跃集合，agent 的每条出站消息 JSON 序列化为 `data: <json>\n\n` 广播给**所有**连接——多标签页天然共享同一事件流（观察者模式），任一标签的会话操作对所有标签可见；连接断开从集合移除。
- 上行 `POST /api/message`：body 累积上限 1MB（超出 413 + 断开读取）；JSON 解析失败 400；zod 校验（uiToAgentMessageSchema）失败 400 附 issues 明细——非法消息在进入 agent 前被拒；合法消息触发 agent 回调，200 ok。
- server 默认绑定 127.0.0.1（HOST 环境变量可覆盖），CORS 仅放行 localhost 来源（防其它网站跨站 POST 驱动 shell 执行）。

**边界与失败模式**：

- 浏览器 EventSource 自动重连——重连时后端无会话级重放，前端靠 session_ready/播种请求恢复面板数据。
- write 失败（连接已断）静默，清理在 close 事件。
- 静态资源请求走 StaticFiles（生产模式 dist 目录），API 未命中且无静态目录（开发模式）返回 404（前端由 Vite dev server 代理）。

**场景走查**：用户开两个标签页 → 标签 A 提交消息 → 两个标签的聊天区同步出现流式回复（同一 SSE 流广播）→ 标签 B 重命名会话 → 标签 A 的侧栏标题同步更新。

### R-WEB-08 目录浏览器

**需求动机**：/cd 与「添加项目」需要用户在真实文件系统里选目录——手打绝对路径易错且暴露内部路径格式；浏览器还服务 system prompt 文件选择（同一条 fs API）。

**详细行为**：

- /cd 命令（无参）与侧栏「添加项目」触发 FsBrowserModal：展示当前目录的子目录列表（默认只列目录不列文件——避免泄露文件内容；includeFiles 模式供文件选择器）、上级导航（parent，根目录时 null）、面包屑当前路径。
- 双击进入子目录、选择确认 → 回调路径：/cd → set_cwd（技能/MCP 扫描根、权限锚点、工具 cwd 全部随动——见 R-SES-07）；添加项目 → new_session(cwd)。
- 后端 fs API：resolveFsPath 缺省 process.cwd()；目录不存在/无权限返回空列表让 UI 显示空状态（不报错崩溃）。

**边界与失败模式**：

- 浏览器不做目录白名单（本地工具，用户本就有文件系统权限——权限边界在工具执行层而非浏览器层）。
- 中文/空格路径原样传递（URL 编码由 fetch 处理）。
- 选择后后端再校验 isDirectory（前端展示与后端校验双保险）。

**场景走查**：用户 /cd → 浏览器从 cwd 逐级进入 `D:\work\blog` → 确认 → notice 确认切换，侧栏新增 blog 分组、@联想与状态栏 cwd 随动。

### R-WEB-09 双端对称

**需求动机**：TUI 与 WebUI 是同一 agent 的两个壳——若一端有配置编辑另一端没有，用户被迫切换界面；对称性必须由「同一套消息契约」结构性保证，而非口头约定。

**详细行为**：

- TUI 与 WebUI 的配置/MCP/Skills/权限管理能力对等（同一套 config_set/add/remove、mcp_manage、skills_manage、permission_* 消息契约）；任一端的功能差异视为缺陷。
- 共享层保证行为一致：reducer（消息 → 聊天块）、tool-display（工具标题/正文的格式化）、status（状态标签/isRunning/pendingTool 文案）、permission（effectivePerm/displayPerm）、commands（命令表与解析）都住在 ui/src/shared——两端只各写渲染层。
- 主题三套（dawn/forest/midnight）× 明暗两态，与 TUI token 同源（语义色 token 映射，主题只控颜色不控布局；WebUI 经 data-theme 属性切换 CSS 变量）。

**边界与失败模式**：

- 能力对等的边界是「交互形态可以不同」（TUI 表单 vs WebUI 表单弹框），「消息语义必须相同」。
- 错误回填、审批四档、范围推导展示等行为两端同源实现。

**场景走查**：用户在 TUI 给 `mcp:playwright` 配了勾选细化 → 切到 WebUI 打开 Permissions 区 → 看到完全相同的规则形态与勾选状态（同一 config + 同一引擎）。

## 边界与立法

- WebUI 是静态资源被 server 托管——前端构建产物进 dist/web，不 import server 包（四包解耦：server 可 import agent/bridge，不 import ui）。
- 多标签页同时连接属预期（观察者模式）：任一标签的会话操作对所有标签可见。
- server 无业务逻辑：权限判定、会话管理、MCP 生命周期全在 agent——server 通道层被限制为「转发 + 校验 + 静态托管」。
- 用户操作（submit/new/resume 等）的 POST 失败必须有 toast 反馈（safePost 区分用户动作与静默刷新）——浏览器网络断开时不能让点击无声无息。
