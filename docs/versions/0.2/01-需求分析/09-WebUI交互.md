# R-WEB WebUI交互

> 浏览器界面（React + Vite，SSE 通道）：与 TUI 共享同一 agent 与消息契约——同一能力的双端呈现，管理操作走同一套 agent 消息，无各自后端。本域覆盖：聊天区与审批横幅、设置弹框五区、右侧信息面板八卡、斜杠联想、Cmd+K 命令面板、会话侧栏项目树、SSE+POST 通道、目录浏览器、双端对称立法。

## 功能点清单

| 点号 | 功能点 | 一句话概要 | 详见设计实现 |
|---|---|---|---|
| R-WEB-01 | 聊天区 | 消息/工具/流式的双端同源渲染与审批横幅 | [12-WebUI架构](../02-设计实现/12-WebUI架构.md) |
| R-WEB-02 | 设置弹框 | 五区导航统一承载全部配置面 | [12-WebUI架构](../02-设计实现/12-WebUI架构.md) |
| R-WEB-03 | 信息面板 | 右侧八卡观察上下文/工具/权限/日志 | [12-WebUI架构](../02-设计实现/12-WebUI架构.md) |
| R-WEB-04 | 斜杠联想 | 同池联想补全 + 命令到界面映射 | [12-WebUI架构](../02-设计实现/12-WebUI架构.md) |
| R-WEB-05 | Cmd+K 命令面板 | 键盘一键到达任意功能 | [12-WebUI架构](../02-设计实现/12-WebUI架构.md) |
| R-WEB-06 | 会话侧栏 | 项目树聚合 + 工作区轻管理 | [12-WebUI架构](../02-设计实现/12-WebUI架构.md) |
| R-WEB-07 | 通道 | SSE 下行 + POST 上行的无业务通道 | [12-WebUI架构](../02-设计实现/12-WebUI架构.md) |
| R-WEB-08 | 目录浏览器 | /cd 与加项目的真实文件系统选择 | [12-WebUI架构](../02-设计实现/12-WebUI架构.md) |
| R-WEB-09 | 双端对称 | 同一消息契约结构性保证两端对等 | [12-WebUI架构](../02-设计实现/12-WebUI架构.md) |

## 域机制概览

**通道与端口形态。** WebUI 不直连 agent——server 只做通道与静态托管：下行 `GET /api/events`（SSE，text/event-stream，多标签页共享同一 agent 事件流——每个标签的 EventSource 都是同一 Agent 的观察者）；上行 `POST /api/message`（body 为 JSON，zod 校验非法丢弃/400）。前端把这对通道封装为 UiPort（createSseUiPort）：EventSource 断开后浏览器自动重连，连接状态（connected/reconnecting/disconnected）经回调通知 UI——顶栏指示器 + 状态变化 toast（「Reconnected」/「Connection lost」/「Reconnecting...」）。下行消息同样过 agentToUiMessageSchema——校验失败的垃圾消息在进入任何 reducer 之前就被丢弃。

**特征化 hook 架构。** App 组件只做「特征装配 + 三栏布局」，数据域拆在六个独立订阅 port 的 hook 里：useChatState（聊天状态，复用与 TUI 共享的 reducer 纯函数）、useTurnTracking（工具执行与审批生命周期——toolCalls 追踪、filesTouched 提取、权限挂起、决策关联、重试回填）、usePanelData（配置/状态/面板数据 + 会话恢复后的播种）、useSessions（会话列表与项目分组）、useSkills（技能清单镜像，只留可用条目）。界面外壳归 useUiChrome（modal 总管、toast/highlight 计时器、面板折叠、主题、Cmd+K）。各 hook 只关心自己订阅的消息子集，互不耦合。

**权限徽章的判定链。** 权限展示需要区分配置放行 allow / 会话提升 always / 待询问 ask / 被拒 rejected。判定链（信息面板 Tool Calls 卡消费）：effectivePerm 用 bridge 的 classifyPermission 做 display-only 判定（不传 args——参数化规则 fail-closed 不命中），注入两个镜像：工具身份镜像（tools_list 广播的 identity——MCP 服务键规则按身份命中才正确）与会话提升镜像（permissions_list 广播，决策时乐观更新不等往返）；Tool Calls 行的最终标签再叠加用户显式决策（displayPerm：决策优先于快照——ask 工具被询问后必有决策，once/always/scoped/rejected）。

**主区域永远是聊天。** 与 TUI 的 view 栈不同，WebUI 的一切面板切换走 modal 叠加（settings/command-palette/confirm/fs-browser/prompt/help），右侧信息面板是常驻可折叠列。命令的界面映射：打开 modal 的命令走 COMMAND_TO_MODAL（/config /model → settings、/skills → settings.skills、/mcp → settings.mcp、/help → help）；信息类命令（/context /status /tools /system /log /permissions）不打开 modal——展开右侧面板 + 高亮对应卡片 3 秒。

## 需求点

### R-WEB-01 聊天区

**需求背景与动机**：聊天区是主交互面——用户需要一眼分辨消息类型、工具执行状态与授权结果；工具调用细节（命令输出、diff）要按需展开而非全部平铺。没有它会怎样：全部工具输出平铺的话一次 shell 就把对话区冲成日志流，关键回复反而找不到。

**功能规格**：

1. 消息渲染按块类型分化：用户右对齐气泡；助手 avatar + markdown 正文（react-markdown 组件式渲染，不走 dangerouslySetInnerHTML）；思考以折叠卡片呈现（折叠态显示前 3 行摘要，展开看全文——与正文分通道）。
2. 工具调用块三要素：状态图标（执行中旋转/完成 ✓/失败 ✕/拒绝 ⊘，来自 toolStatus done/error/rejected/running）、折叠头（工具名 + 参数摘要 + 结果摘要——如「$ pnpm test · 32 行输出」）、折叠/展开。
3. 展开正文按工具精修（shared/tool-display 同源）：命令与输出分层（cmd 弱化、diff 行绿/红）、edit_file diff 带真实行号（解析回执「已替换 1 处（原第 N 行起）」锚点，无锚点不编造坐标）、超大输出 200 行封顶；正文栏带行数提示与**一键复制**（复制 = 正文 text 原样拼接——shell 是去 exit 行的纯输出、read/write 是不带行号的纯内容、edit 是自描述 diff）。
4. 模型生成工具参数期间（tool_pending → tool_start）显示「正在调用 X…」占位；压缩中显示「Compacting context...」；其余运行态显示「DogEgg is thinking...」三点动画；新块到达自动滚动到底部。
5. ask 调用弹出**审批横幅**（PermissionBanner，输入区上方常驻）：工具名 + 文件名/参数预览（edit_file 显示 -/+ diff、write_file 显示写入内容、shell 显示命令，各截 150 字符）+ 四按钮：Allow Once / Always Allow: <模式>（仅 alwaysScope 推导出时出现，模式原文可见）/ Always Allow (tool) / Reject。横幅可及性：`role="alert"` + `aria-live="assertive"`——请求到达时读屏立即播报横幅内容；**Esc = 拒绝**（与 TUI 的 esc=reject 语义对齐；有 modal 打开时 Escape 优先归 modal 关闭链路，不据此拒绝）。
6. 错误与恢复语义（shared reducer 同源）：error 消息把流式 partial flush 落盘并追加红色错误块 + 回填重试文本（retryText → 输入框）；会话切换（session_ready）按 history + thinking 重建全部块、清空旧会话的流式残留。

**边界与失败模式**：

- 决策期间状态离开 waiting_permission（如取消）→ 横幅自动关闭（pendingRef 镜像 + state 消息监听）。
- 工具执行的权限快照在 tool_start 时刻记录——不随后续配置变化回改历史行的标签。
- 复制在剪贴板不可用（非安全上下文）时静默失败，不影响主流程。

**验收标准**：

1. 当模型调 shell，则聊天区出现旋转图标块 + 「正在调用 shell…」→ tool_end 后图标定格 ✓，展开可见命令与输出分层。
2. 当 permission_request 带 alwaysScope，则横幅出现「Always Allow: ./src/**」按钮，点击即按该模式提升。
3. 当轮次以 error 收尾，则部分输出保留落盘、错误块变红显示、输入框自动回填原文。
4. 当展开一个 500 行输出，则正文封顶 200 行。

**场景走查**：模型调 shell → 聊天区出现旋转图标块 + 「正在调用 shell…」→ tool_end 后图标定格 ✓ → 点击展开看命令与输出分层 → 点复制得到纯输出文本。

### R-WEB-02 设置弹框（五区）

**需求背景与动机**：配置面宽（模型/权限/MCP/技能/运行时参数）——单一弹框内按域分区的导航，比多个入口统一，也比单页平铺可扫读。没有它会怎样：每个功能各开一个弹窗，用户要在五处找配置入口。

**功能规格**：

1. SettingsModal 左侧五导航（General/Models/Permissions/Skills/MCP Servers），右侧内容区，支持 initialSection 直达（/skills 命令 → skills 区，/mcp → mcp 区）。
2. **General**：defaultProvider/defaultModel 下拉、systemPrompt（只读路径框 + 清除按钮 + 文件浏览器选择——/api/fs files 模式）、maxIterations/maxRetries 数字框、shellProgram 下拉（选项来自 /api/shells 本机探测，带「(auto)」平台默认项）。
3. **Models**：provider 折叠卡片逐字段编辑（name/protocol 单选/baseURL/apiKey 密文输入），models 子编辑器（contextWindow/maxOutput/reasoning 开关）+ 增删；添加 provider 走 config_add 空节点。
4. **Permissions**：三桶卡片——添加下拉（MCP 服务整组 + 内建工具，排除已有、候选来自运行时 tools_list）；每条规则组含整选开关（whole 显式字段，与 TUI 同构）、模式 chips 就地改名（点击变输入框）/删除、MCP 服务键**勾选 chips**（该服务运行时工具清单勾选 = 增删内部工具名）+ 通配/遗留条目手动 chips + 添加输入框（非空 + 去重，非法置红）。
5. **MCP Servers**：全局/项目分组状态卡片（状态点颜色 + 名称 + 传输/状态徽章 + 工具数 + 错误行），启停切换/编辑表单（类型/名称/command/args/env 或 url/headers，JSON 字面量输入）/删除确认；编辑态全字段预填、名称锁定。
6. **Skills**：项目级/用户级两组列表，创建表单（落点/名称/描述）、启停按钮、**缺失态灰显与清理**、编辑（get 取全文 → textarea → update 整文件替换）、删除确认。
7. 所有编辑走与 TUI 相同的 config_set/add/remove 与 manage 消息——校验失败由后端回滚 + notice 广播（channel 定位到对应面板 inline 可见，编辑即报错不写坏配置）。

**边界与失败模式**：

- Skills 区操作失败的 notice（channel='skills'）以 inline 错误条显示在设置弹框内——用户正看着设置页，聊天区不该是唯一反馈面；成功清单到达即清除。
- General/Models 区保存失败（网络/通道错误）同样 inline 可见（「保存失败：<原因>」）——此前失败只有 console.warn，用户误以为保存成功；新提交开始即清除上次失败提示。
- MCP/Skills/MCP 表单校验失败（名称空/args 非法 JSON 等）notice 带 channel，面板 inline 展示；skill_content 响应用请求时的条目锚点核对——防止旧响应打开错误的编辑器。
- 编辑态身份字段锁定（名称/落点）；运行中管理操作被后端阻塞并 notice。
- 主题不在设置弹框内——侧栏主题切换器与命令面板承载（见 R-WEB-09）。

**验收标准**：

1. 当 Cmd+K → 「Open Settings」→ Models 区新建 provider → 逐字段填写 → 保存，则 config_updated 后顶栏模型名即时刷新。
2. 当在 Permissions 区给 MCP 服务键勾选某工具，则规则以内部工具名写入 allow 桶（与 TUI 勾选同构）。
3. 当 MCP 表单 args 填非法 JSON，则提交被拒（「args 不是合法 JSON 数组」）且不落盘。
4. 当技能名称非法创建，则 Skills 区出现 inline 错误且清单不变。
5. 当 General/Models 区的保存请求失败（网络/通道错误），则本区出现 inline「保存失败：…」错误条（不再只有 console.warn）。

**场景走查**：用户 /skills 命令 → 设置弹框直达 Skills 区 → 填落点/名称/描述创建 → 启停按钮停用 → 清单灰显标记。

### R-WEB-03 信息面板（右侧八卡）

**需求背景与动机**：agent 的运行时状态（上下文占用、工具历史、可用工具、会话授权、日志）需要一个不打断聊天的观察面板——右侧可折叠列承载「随时可查」的一切诊断信息。没有它会怎样：查一次 token 占用就要发一条消息问模型，或翻终端日志。

**功能规格**：

1. 八个可折叠卡片（支持高亮定位 3 秒）：
   - **Status & Model**：状态 pill（shared STATUS_LABELS 同源）+ 会话名（铅笔按钮打开重命名编辑框，预填原名）；
   - **Context**：进度条（超压缩阈值 80% 变警示色）+ tokens/window 百分比 + 分段统计（system/user/assistant/tool output/tool schemas）+ 三口径用量分列（当前估算/上一轮 API 实际/会话累计——每行标明口径，累计含被压缩历史属预期）+ 压缩计数；
   - **Tool Calls**：序号/状态图标/名称/**权限徽章**（once/always/scoped/rejected/allow/ask——判定链见域机制概览）；参数生成中的调用以「…/调用中…」占位行置顶；
   - **Files Touched**：从 tool_start 输入提取 edit/write 的路径（显示 basename + action 徽章）+ 时间，会话内累计、按时间倒序；
   - **Available Tools**：按来源分组可展开（系统工具组默认展开 + MCP 服务组默认收起带 MCP 徽章，组头计数），行内显示内部短名（title 保留完整注册名）+ 权限徽章——判定注入 tools_list 身份镜像，MCP 服务键规则在徽章上正确生效；
   - **Session Permissions**：会话提升清单（工具 + 模式列表/whole tool），每条 X 按钮可撤销（发 permission_revoke，撤销后清单随广播刷新）；
   - **System Prompt**：路径 + 全文，卡片内独立滚动；
   - **Log Tail**：调试日志路径 + 尾部，手动刷新按钮。
2. 播种：面板展开时（首次展开或会话切换后）自动发 tools/system/log/context 一组 request（每会话去重）。
3. 刷新时机：对话进行中 context 每 3s 轮询；compaction 消息到达即补发 context_request（压缩后进度条立即反映）；finished/error 后刷新 context 与 log；会话切换清空旧面板数据并重新播种（新会话不显示旧数据）。

**边界与失败模式**：

- 配置未就绪时 Context 卡显示「Not available」空态。
- 权限徽章是 display-only——不传 args，参数化规则 fail-closed 不命中（宁可保守显示 ask）。
- Session Permissions/System Prompt/Log Tail 默认收起（低频诊断信息不占默认视野）。

**验收标准**：

1. 当点开 Context 卡，则看到进度条、百分比与分段统计；压缩发生后数字跳变并出现压缩计数 +1。
2. 当会话提升某工具后，则 Session Permissions 卡出现该条目，点 X 撤销后条目消失。
3. 当对话运行中，则 Context 数字每 3s 刷新。
4. 当切换会话，则面板全部数据清空并按新会话重新播种。

**场景走查**：用户点开 Context 卡 → 看到 78% 进度条与分段统计 → 压缩发生 → 数字跳变为 4,200 并出现压缩计数 +1。

### R-WEB-04 斜杠联想

**需求背景与动机**：与 TUI 同理——命令发现不能靠背表；WebUI 的联想还要处理「键盘选择 + 滚动跟随」的列表交互。没有它会怎样：长命令列表超出浮层高度时，键盘选中的项滚出视野，用户选错。

**功能规格**：

1. 输入 `/` 弹联想浮层：内建命令 + skill 动态命令（停用/缺失不出现——可用条目过滤，与 TUI 同池逻辑，来自 useSkills 镜像）。
2. ↑↓ 选择，高亮项 scrollIntoView 滚入可视区（长列表不跟手会选错）；Tab 补全（唯一匹配直接补；多匹配需先选中一项，未选中不改输入）；回车路由执行——选中候选时先补全，已完整时直接执行；esc 关闭；鼠标点击候选也可补全（mousedown preventDefault 防输入框失焦）。
3. 命令执行后的界面映射见域机制概览（COMMAND_TO_MODAL / 高亮信息面板）；特殊路由：/cd 无参 → 目录浏览器弹框（非帮助）、/rename 无参 → 预填原名的重命名弹框、/clear /quit → 确认弹层。
4. 输入历史：输入框为空时 ↑↓ 召回历史提交（最多 50 条，应用生命周期内）。
5. 运行中 textarea 禁用，发送按钮切换为停止按钮（发 cancel）；Ctrl+C 在运行中同样发 cancel。

**边界与失败模式**：

- 输入框非空非命令文本正常提交；提交 POST 失败 toast「Failed to send」（safePost 语义）。
- 联想与 @path 联想互斥（首字符 `/` 与 `@` 天然互斥；键盘处理 @path 优先）。
- 运行中管理操作被后端闸门拒绝时 notice 转 toast。

**验收标准**：

1. 当输入 `/re`，则浮层高亮 /rename，回车弹出预填原名的重命名弹框，确认后侧栏标题即时更新。
2. 当输入 `/cd` 无参回车，则打开目录浏览器而非帮助。
3. 当联想高亮项在浮层视口外，则自动滚动到可视区。
4. 当运行中按 Ctrl+C，则发出 cancel 且输入框保持禁用直到回合结束。

**场景走查**：输入 `/re` → 浮层高亮 /rename → 回车弹重命名弹框（预填原名）→ 确认后侧栏标题即时更新。

### R-WEB-05 Cmd+K 命令面板

**需求背景与动机**：高频操作（开设置、切会话、新建会话、切主题）散落在各处——命令面板是「一键到达任意功能」的键盘捷径，也是鼠标用户的发现入口。没有它会怎样：新用户找不到主题切换在哪、设置入口在哪。

**功能规格**：

1. Cmd+K（macOS）/Ctrl+K（Windows/Linux）全局快捷键开关面板（window keydown 捕获，preventDefault 防浏览器冲突）；面板开着再按是关闭（toggle 而非叠加）。
2. 面板聚合五组条目，按查询过滤、↑↓ 选择、回车执行：
   - **Commands**：内建命令（**不含 /quit 与 /clear**——危险命令立法：面板的直发链路无确认环节，/quit 会杀掉整个后端服务进程、/clear 不可逆清空历史；二者的安全路径只有输入框，那里挂了确认弹窗）——/config /model 打开设置、/cd /rename /skills /mcp 路由到专用弹框（不先关面板——新弹框会替换面板，先关会把刚开的弹框抹掉）、其余 parseCommand 直发；
   - **Skills**：可用技能（invoke_skill，args 空）；
   - **Sessions**：最近 10 个会话（选中即 resume）；
   - **Themes**：三主题即时切换；
   - **Actions**：新会话/清空历史等常用操作（Clear History 经确认弹层）。
3. 执行后关闭面板并路由到对应动作（多数走 COMMAND_TO_MODAL 的 modal 映射）。

**边界与失败模式**：

- 清空历史在面板内触发也走确认弹层（不可逆操作不因入口不同而免确认）。
- 需要参数的命令（/cd /rename）路由到与输入框一致的行为——裸 parseCommand 对它们只会得到帮助。

**验收标准**：

1. 当 Ctrl+K → 输入 "mcp"，则选中「Open Settings: MCP Servers」直达设置 MCP 区。
2. 当面板开着再按 Ctrl+K，则面板关闭（非叠加第二个）。
3. 当在面板选一个技能，则发出 invoke_skill 且面板关闭。
4. 当在面板触发 Clear History，则先弹确认层，确认才清。

**场景走查**：用户 Ctrl+K → 输入 "mcp" → 选中设置 MCP Servers 条目 → 设置弹框直达 MCP 区。

### R-WEB-06 会话侧栏（项目树）

**需求背景与动机**：多项目多会话的组织需要树形聚合——项目为组、会话为叶，配合「添加项目/遗忘项目」构成轻量工作区管理。没有它会怎样：所有会话平铺一列，跨项目的会话互相淹没。

**功能规格**：

1. 侧栏按项目（cwd）分组会话树：组头为项目名（路径 basename），条目显示标题（title || preview）/相对时间/预览，当前会话高亮；顶部搜索框按 title/preview 过滤（大小写不敏感）。
2. 操作：新建会话（组头按钮以该项目 cwd 建——new_session 带 cwd）、切换（resume）、删除（确认弹层 → delete_session）、添加项目（目录浏览器选目录 → new_session(cwd)）。
3. 项目遗忘（删除其下全部会话 + 本地 knownProjects 清单移除）：确认弹层明示「将删除 N 个会话的记录，项目目录本身不会被删除，可随时重新添加」；无会话项目走「移除项目」文案。
4. 已知项目集合（knownProjects）从会话 cwd 累积——会话全删后项目仍保留在侧栏，直到显式遗忘。
5. 标题同步：rename_session 后 session_list 广播驱动侧栏刷新；对话结束（finished/error）后刷新列表（预览随落盘更新）。
6. 侧栏可折叠（折叠态保留品牌标记 + 添加项目入口）；信息面板折叠是独立状态。

**边界与失败模式**：

- 分组依据是存档 cwd（见 R-SES-06）。
- 删除当前会话后侧栏出现「接管中」的新会话（首轮对话才落盘，见 R-SES-05）。
- 会话操作失败（网络错误）经 safePost toast 提示——用户操作与静默刷新区分。

**验收标准**：

1. 当点「添加项目」→ 目录浏览器选 `D:\work\blog`，则新会话在 blog 组下创建并激活。
2. 当遗忘一个有 3 个会话的项目，则 3 条会话记录删除、项目从侧栏消失、磁盘项目目录不受影响。
3. 当某项目会话全部删除但未遗忘，则该项目组仍显示在侧栏。
4. 当在另一标签重命名会话，则本标签侧栏经 session_list 广播同步新标题。

**场景走查**：用户点「添加项目」→ 目录浏览器选 `D:\work\blog` → 新会话在 blog 组下创建并激活 → 该组持久可见（knownProjects）。

### R-WEB-07 通道（SSE 下行 + POST 上行）

**需求背景与动机**：浏览器无法与 Node 进程长连 stdin/stdout——SSE + POST 是「agent 推、UI 拉」语义在 HTTP 上的最小实现；server 不含业务逻辑是架构立法（四包解耦）。没有它会怎样：一旦 server 里长出业务逻辑，TUI/WebUI 的行为分叉与双倍维护立即出现。

**功能规格**：

1. 下行 `GET /api/events`：SSE 响应头（text/event-stream + no-cache + keep-alive），连接注册进活跃集合，agent 的每条出站消息 JSON 序列化为 `data: <json>\n\n` 广播给**所有**连接——多标签页天然共享同一事件流（观察者模式），任一标签的会话操作对所有标签可见；连接断开从集合移除。唯【恢复链】例外：新 SSE 连接建立时 server 经 `onConnect` 回调调 `agent.resendSessionState(send)`，会话快照走该连接的**定向单播**（不走广播——广播会把所有在看的客户端运行中界面整体重置，运行中的流式内容只存在于循环局部）。
2. 上行 `POST /api/message`：body 累积上限 1MB（超出 413「Request body too large」+ 销毁请求停止读取）；JSON 解析失败 400；zod 校验（uiToAgentMessageSchema）失败 400 附 issues 明细——非法消息在进入 agent 前被拒；合法消息触发 agent 回调，200 ok。
3. server 默认绑定 127.0.0.1（HOST 环境变量可覆盖），CORS 仅放行 localhost 来源（防其它网站跨站 POST 驱动 shell 执行）。
4. 前端封装（createSseUiPort）：EventSource 收到 data → JSON.parse → agentToUiMessageSchema 校验 → 分发；onerror 按 readyState 区分 reconnecting（浏览器自动重连中）/disconnected（已关闭）。
5. **恢复链（重连/刷新/新标签接入）**：新连接单播收到 `session_ready { id, messages, busy, live? }`（+ thinking）——按 history + thinking 重建全部块；busy=true 不被打回 idle（运行中保真）；live 携带运行现场——`live.partial` 恢复为流式中的助手消息（后续 text_delta 续拼）、`live.runningTool` 恢复为 running 工具块（后续 tool_end 按 toolId 精确配对转正）；随后重放近期 notice（环形缓冲 20 条——启动期告警发出时连接集为空，WebUI 用户借此可见，如权限键失配告警）与重发挂起中的 permission_request（同 id 幂等，恢复后可照常决议）。

**边界与失败模式**：

- 恢复链是唯一快照重放：重连/刷新/新标签接入经新连接的单播 session_ready 恢复（含 busy 与 live 运行现场、notice 重放、挂起审批重发，见规格 5）——多标签广播不承载恢复（广播会整体重置其它在看的运行中界面）。
- write 失败（连接已断）静默，清理在 close 事件。
- 静态资源请求走 StaticFiles（生产模式 dist 目录），API 未命中且无静态目录（开发模式 VITE_DEV=1）返回 404（前端由 Vite dev server 代理）。

**验收标准**：

1. 当开两个标签页，标签 A 提交消息，则两个标签的聊天区同步出现流式回复（同一 SSE 流广播）。
2. 当标签 B 重命名会话，则标签 A 的侧栏标题同步更新。
3. 当 POST 一个非法形状的消息，则 400 且 agent 未收到（issues 明细返回）。
4. 当 body 超 1MB，则 413 且连接读取终止。
5. 当网络闪断后恢复，则顶栏指示器经 Reconnecting → Connected 变化并伴随 toast。
6. 当轮次运行中刷新页面或断线重连，则运行现场恢复——partial 续拼、进行中工具块恢复 running 态、输入不误启用（busy 保真）、挂起审批重现可决议。

**场景走查**：用户开两个标签页 → 标签 A 提交消息 → 两个标签的聊天区同步出现流式回复（同一 SSE 流广播）→ 标签 B 重命名会话 → 标签 A 的侧栏标题同步更新。

### R-WEB-08 目录浏览器

**需求背景与动机**：/cd 与「添加项目」需要用户在真实文件系统里选目录——手打绝对路径易错且暴露内部路径格式；浏览器还服务 system prompt 文件选择（同一条 fs API）。没有它会怎样：用户必须知道并手敲 server 进程视角的路径格式（Windows 反斜杠/正斜杠差异极易错）。

**功能规格**：

1. /cd 命令（无参）与侧栏「添加项目」触发 FsBrowserModal：fetch `/api/fs`（缺省 process.cwd()）展示当前目录的子目录列表（默认只列目录不列文件——避免泄露文件内容；`files=true` 模式供 system prompt 文件选择器）；上级导航（parent，根目录时 null）、返回历史栈、面包屑当前路径、**手动路径输入行**（回车或 Select Directory 直接确认输入值）。
2. 点击子目录进入下一层（current/dirs/parent 刷新）；选择确认 → 回调路径：/cd → set_cwd（技能/MCP 扫描根、权限锚点、工具 cwd 全部随动——见 R-SES-07）；添加项目 → new_session(cwd)。
3. 后端 fs API：resolveFsPath 缺省 process.cwd()；目录不存在/无权限返回空列表让 UI 显示空状态（不报错崩溃）；子目录/文件名 localeCompare 排序。
4. @path 联想复用同一条 /api/fs（files=true 拉目录+文件清单，前端 3s TTL 缓存、cwd 切换时清空）。

**边界与失败模式**：

- 浏览器不做目录白名单（本地工具，用户本就有文件系统权限——权限边界在工具执行层而非浏览器层）。
- 中文/空格路径原样传递（URL 编码由 fetch 处理）。
- WebUI 端 @path 越界校验只在词法层（浏览器无 realpath）；服务端权限系统兜底实际工具调用。

**验收标准**：

1. 当 /cd → 浏览器从 cwd 逐级进入 `D:\work\blog` → 确认，则 notice 确认切换，侧栏新增 blog 分组、@联想与状态栏 cwd 随动。
2. 当浏览一个无权限目录，则显示空列表而非报错崩溃。
3. 当在面包屑上级按钮点击，则回到上一级（根目录时上级按钮不出现）。
4. 当在手动路径行输入合法路径确认，则等同浏览后选择。

**场景走查**：用户 /cd → 浏览器从 cwd 逐级进入 `D:\work\blog` → 确认 → notice 确认切换，侧栏新增 blog 分组、@联想与状态栏 cwd 随动。

### R-WEB-09 双端对称

**需求背景与动机**：TUI 与 WebUI 是同一 agent 的两个壳——若一端有配置编辑另一端没有，用户被迫切换界面；对称性必须由「同一套消息契约」结构性保证，而非口头约定。没有它会怎样：两端各写一份 reducer/命令表/权限判定，行为漂移（文案不一致、判定口径不同）只是时间问题。

**功能规格**：

1. TUI 与 WebUI 的配置/MCP/Skills/权限管理能力对等（同一套 config_set/add/remove、mcp_manage、skills_manage、permission_* 消息契约）；任一端的功能差异视为缺陷。
2. 共享层保证行为一致：reducer（消息 → 聊天块）、tool-display（工具标题/正文的格式化）、status（状态标签/isRunning/pendingTool 文案）、permission（effectivePerm/displayPerm/getToolPermission）、commands（命令表与解析）、block（语义块模型）都住在 ui/src/shared——两端只各写渲染层。
3. 语义色 token（shared 的 ColorToken）两端同源；具体视觉值各自映射——TUI 走 palette hex（五主题），WebUI 走 CSS 变量（data-theme 属性切换，midnight/forest/dawn 三主题各固定明或暗）。
4. 错误回填、审批四档（once/always/scoped/reject）、范围推导展示、pendingTool 文案等行为两端同源实现。

**边界与失败模式**：

- 能力对等的边界是「交互形态可以不同」（TUI 表单 vs WebUI 表单弹框），「消息语义必须相同」。
- 主题集两端不共用（TUI mocha/tokyonight/gruvbox/onedark/dogegg，WebUI midnight/forest/dawn）——对称的是「有多主题可切」的能力，不是主题清单本身。

**验收标准**：

1. 当在 TUI 给 `mcp:playwright` 配了勾选细化，则切到 WebUI 打开 Permissions 区看到完全相同的规则形态与勾选状态（同一 config + 同一引擎）。
2. 当同一条 agent 消息（如 tool_end）到达两端，则产出语义相同的块（kind/colorToken/正文文案），仅视觉映射不同。
3. 当 TUI 与 WebUI 各自的斜杠联想，则候选池与补全行为一致（同一 matchCommands）。

**场景走查**：用户在 TUI 给 `mcp:playwright` 配了勾选细化 → 切到 WebUI 打开 Permissions 区 → 看到完全相同的规则形态与勾选状态（同一 config + 同一引擎）。

## 边界与立法

- WebUI 是静态资源被 server 托管——前端构建产物进 dist/web，不 import server 包（四包解耦：server 可 import agent/bridge，不 import ui）。
- 多标签页同时连接属预期（观察者模式）：任一标签的会话操作对所有标签可见。
- server 无业务逻辑：权限判定、会话管理、MCP 生命周期全在 agent——server 通道层被限制为「转发 + 校验 + 静态托管」。
- 用户操作（submit/new/resume 等）的 POST 失败必须有 toast 反馈（safePost 区分用户动作与静默刷新）——浏览器网络断开时不能让点击无声无息。
