# R-TUI TUI交互

终端界面（Ink）：已完成的内容打印进终端滚动缓冲区（Static 区，用终端原生滚动看历史），底部动态区承载输入、流式与全部弹层。键盘是第一交互方式，鼠标可选。

## 工作原理概述

**Static/动态分层是渲染立法。** 已完成的消息块经 Ink 的 `<Static>` 打印进终端滚动缓冲区——输出一次即固定，用户用终端原生滚动（滚轮/PgUp）看历史，Ink 每帧只重绘底部动态区（未完成的工具块、流式 partial、输入框、弹层、状态栏）。这带来两个派生规则：

- 「最后一块工具块未收到 tool_end 时留在动态区」（内容还会变，不能固化）——stableCount = toolActive 时块数减一；
- 任何需要修改已打印内容的操作（折叠展开、主题切换、会话切换、清空历史）都必须「清屏 + Static 重挂载」（clearScreenRemount：清屏序列 + staticKey 递增），而不是就地更新。

品牌头延迟打印：Static 只在首现时渲染一次，启动瞬间 config/status 未回来，先打印会永远定格在「加载配置中…」——等 config 与 cwd 就绪再打印。

**视图态与后端状态机正交。** UI 自己的 View 联合类型（none/permission/menu/sessionPicker/prompt/skills/mcp/config/info/form）是纯前端状态，叠加在后端 10 态状态机之上，二者互不感知。App 持有唯一 view state；config 树 entries、blocks、浏览焦点等被 useInput 回调消费的状态都维护 ref 镜像——Ink 的 useInput 回调是首渲染闭包，读 useState 拿到的是旧值（历史教训），按键层必须走 ref。

**键盘路由：全局拦截 → 按 view.kind 分派。** useKeyRouting 装配层先处理全局键（Ctrl+C 最高优先级：运行中发 cancel，空闲且不在菜单时弹退出确认菜单）；随后按 view.kind 分派到 features/*/keys.ts 的纯逻辑处理器（可单测——测试注入 spy api）。还有一层 suppressEnter 微任务吞键：port 是同步通道，打开弹层的命令发出后响应可能立即切换 view，同一个回车会被 useInput 在新 view 里再处理一次（误选中第一项）——所有会开弹层的命令统一吞掉提交回车。

**命令与联想共用一套解析。** parseCommand 是纯函数：斜杠命令 → UiToAgentMessage；skill 动态命令（首词命中 skill 名）→ invoke_skill；其余 → 普通消息。联想 matchCommands 做前缀匹配（内置命令 + skill 动态命令同池），已完整匹配时不再联想。错误自动回填（onErrorRetry）从输入历史栈取末条填回输入框。

## 需求点

### R-TUI-01 命令集与斜杠联想

**需求动机**：终端里键盘是唯一高效通道——所有能力必须有斜杠命令入口，且命令发现（联想）不能要求用户背命令表。

**详细行为**：

- 斜杠命令全集（18 个）：`/cd`（切目录，参数为路径）/ `/clear`（清空历史，确认弹层）/ `/compact`（手动压缩）/ `/config`（配置树）/ `/context`（上下文详情 → info 面板）/ `/help`（本地渲染帮助 info）/ `/log`（日志尾部）/ `/model`（快速选模型）/ `/new`（新会话）/ `/permissions`（会话提升查看撤销）/ `/quit`（退出，确认弹层）/ `/session`（会话选择器）/ `/skills`（技能面板）/ `/mcp`（MCP 面板）/ `/status`（状态一览）/ `/system`（系统提示词）/ `/tools`（工具清单）/ `/rename`（命名，参数为标题）。
- 斜杠联想：输入 `/` 即弹候选（内置 + skill 动态命令同池，行内命令名 + 截断描述 + 滑动窗口防换行），↑↓ 选择、Tab 补全（唯一匹配直接补；多匹配补第一个）、回车在选中候选时补全到输入框而非提交；停用/缺失的 skill 不出现（可用条目过滤）。
- 输入历史：↑↓ 召回历史提交（应用生命周期内跨会话保留）。
- 输入框为多行：Enter 发送，Ctrl+J / Alt+Enter 换行。

**边界与失败模式**：

- 未知命令也显示帮助（default 分支）；/cd /rename 缺参数回帮助。
- /clear /quit 必经确认菜单（不可逆）。
- /model 与 /config 共用 config_request，App 按 intent 标记决定打开哪个 overlay。
- /tools 有独立 intent——后台播种（挂载/config_updated）不弹工具面板，只有显式 /tools 才弹（共享标志会误消费）。

**场景走查**：用户输入 `/se` → 联想列出 /session → Tab 补全 → 回车打开会话选择器（空壳先开，session_list 响应到达后填充）。

### R-TUI-02 /config 配置树

**需求动机**：配置项分散在多个层级（顶层标量/provider 数组/权限三桶）——树形钻入让全部配置有一个统一入口，且校验/落盘/广播只走一条链路。

**详细行为**：

- 树形编辑器，根层条目：systemPrompt（标量，存路径不存正文）、defaultProvider/defaultModel（钻入选择器）、maxIterations/maxRetries（标量）、shellProgram（钻入本机扫描结果选择）、theme（主题选择）、permission（钻入三桶）、providers（钻入 provider/model 增删改）、skills / mcpServers（跳转对应管理面板）。
- 行交互按条目 kind 分派：标量 Enter 弹输入框（预填当前值）、布尔 ←→ 切换、枚举选择、数组项 d 键删除。
- providers 子树逐字段编辑（校验放宽——见 R-LLM-08），重名/校验失败由后端 validateConfig 回滚并 emit error。
- shellProgram 选择器列 detectShells 扫描结果（配置只在扫描结果中选择）。
- 树变更统一翻译成 config_set/add/remove 消息发后端。

**边界与失败模式**：

- 按键层复用渲染层算好的同一份 entries（ref 镜像）——杜绝两处 buildEntries 漂移。
- 权限树含只读说明行「（未列出的工具一律询问——固定安全默认）」不可编辑。
- 运行中配置编辑消息被后端阻塞（动工作集类）。

**场景走查**：/config → 钻入 providers → 添加 provider（空节点）→ 逐字段填 → 保存 → config_updated 广播 → 顶栏 provider/model 即时刷新。

### R-TUI-03 权限细化编辑（选择即钻入）

**需求动机**：权限规则的核心操作是「给某个工具加规则」——若流程是「回到桶层 → 添加 → 再钻入」，一次配置要 esc 往返多次。「选择即钻入」把这个高频路径压到一步。

**详细行为**：

- 权限选择器（selectTool）列出内建工具逐个 + MCP 服务整组（标注工具数/未运行状态，数据来自 tools_list 镜像的身份）——**选中后直接落到该键的细化层**（afterRunPath），免 esc 往返。
- 细化层两态：
  - 整选开关行恒可用（「✓ 整工具生效（回车取消——改为按模式限定）」/「· 整工具生效（回车切回；当前模式将保留）」）；
  - whole=false 时模式行就地编辑（scalar 改名/删除）+ 添加模式。
- 服务键为**勾选式**：对运行时工具清单勾选/取消（= 增删内部工具名）+ 通配规则行（含 `*` 或不在运行时清单的模式）+ 添加通配；服务未运行显示「已保存规则按保存内容生效」。
- 跨桶提示：同一键在其它桶也有规则时值列显示提示（防「已放行为什么还问」困惑）。

**边界与失败模式**：

- 整选时勾选/规则保留展示但不可更改（取消整选后恢复操作）。
- 通配改名做非空 + 去重补偿（fail-closed 的编辑器侧）。
- 模式缺锚点在后端加载/编辑期被拒（前端不重复实现校验）。

**场景走查**：allow 桶 → ＋添加工具 → 选择器选「playwright（MCP 服务）· 12 个工具」→ 直接落到 `mcp:playwright` 细化层 → 对 `browser_navigate` 回车勾选 → 保存广播。

### R-TUI-04 表单视图（/mcp、/skills 的新建编辑）

**需求动机**：MCP server 与 skill 的字段多（落点/名称/类型/command/args/env…），逐字段弹窗链（问一个答一个）既慢又无法回看已填内容——一屏表单是正解。

**详细行为**：

- 一屏多字段表单（form view）：↑↓ 在字段与保存行之间循环；Enter 编辑文本字段（弹输入框预填当前值，esc 回表单不丢已改内容）/ 循环切换选项字段（如落点 global/project、传输类型 stdio/http——显示 label 提交 value）。
- readonly 字段锁定（编辑态名称/落点不可改——名称即身份）。
- `s` 或保存行提交；esc 随时回列表不保存。
- 校验失败（名称空/command 空/args 非法 JSON/名称格式不符）提示后**留在表单**——已填内容不丢（宁可少配不可错配，不写半份配置）。

**边界与失败模式**：

- 编辑态预填现有 transport 明细、enabled 保留（编辑停用中的 server 不会误启用）。
- 表单带 returnView（来源面板）——esc/提交后回到列表。
- JSON 字段（args/env/headers）解析失败指明字段名。

**场景走查**：/mcp → a → 选 stdio → 表单五字段逐个填 → s 提交 → 校验通过落盘 → rebuild → 面板刷新出 running 状态行。

### R-TUI-05 弹层层级（esc 语义 / returnView 链）

**需求动机**：面板内会钻入详情与确认菜单（如 /mcp 详情、删除确认）——若 esc 一律关闭整个面板，用户在三层深处按一下 esc 就丢失全部导航位置。

**详细行为**：

- 全部弹层（菜单/信息/表单/输入框）支持 returnView 回退链：设置 view 时携带来源 view，esc **回到来源视图**；只有来源是主屏（returnView 缺省）的弹层 esc 才关闭面板。
- 典型链：/mcp 面板 → Enter 详情（info，returnView=mcp）→ d 删除确认（menu，returnView=mcp）→ esc 逐级回退到面板 → 再 esc 关面板。
- 校验失败的 notice 也带 returnView（info + returnView）——提示关闭后回到原视图。

**边界与失败模式**：

- 确认菜单的「确认删除」分支先 setView(空壳选择器/原面板) 再发消息——session_list/mcp_list 等推送只刷新已开的面板（响应不承担弹层职责，旧推送误弹层的教训）。
- permission 弹层不走 returnView（它由后端 permission_request 驱动开合）。

**场景走查**：用户在 /skills 面板 d 删除 → 确认菜单弹出于面板之上 → esc 取消回到 /skills 列表 → 再 esc 才回主屏。

### R-TUI-06 审批层（四档决策）

**需求动机**：落 ask 的工具调用必须阻塞等待用户决策——审批层是权限系统的终端侧交互面，决策选项与范围推导必须与后端语义一一对应。

**详细行为**：

- permission_request 到达 → view 切到 permission → 弹层显示工具名 + 参数（JSON 摘要）+ 决策项列表。
- 决策项由 `decisionItems(alwaysScope)` 组装：
  - 恒有「允许一次」「始终允许（本次会话）」；
  - agent 推导出范围模式时插入第四项「对此范围不再询问（<模式>）」（模式原文可见——用户点之前就知道授权范围）；
  - 恒有「拒绝」。
- 推导不出时维持三档（fail-safe）。
- ↑↓ 选择、回车提交 `permission_decision { id, decision }`；决策期间对话暂停（状态机 waiting_permission），决策后继续。

**边界与失败模式**：

- 决策期间取消（Ctrl+C）→ 挂起 Promise 被 rejectAll → 走取消路径。
- 范围提升落库的路径解析在后端（apply 时解析为绝对）——UI 只传模式原文。
- 弹层在输入框下方展开，视觉上与输入框一体。

**场景走查**：模型调 `edit_file` → 弹层列出参数与四档 → 用户选「对此范围不再询问（./src/**）」→ src 下后续编辑静默执行，/permissions 可撤销。

### R-TUI-07 @path 路径联想

**需求动机**：让用户在消息里引用项目文件时不必手打路径——`@` 联想补全准确路径，同时把联想范围锁在 cwd 内（与权限作用域一致），不提供越界候选。

**详细行为**：

- 输入末尾出现 `@<路径片段>`（token 正则允许前置空白/引号/中文括号）触发：片段按最后一个 `/` 拆成目录部分 + 名字前缀；目录部分逐层解析进子目录（`@src/ap` → 进 src 找 ap 前缀）。
- 候选**目录优先、文件在后**，各自字母序，全量返回不截断（目录多的仓库也要能看到文件），渲染层只画光标附近 8 行滑动窗口。
- 补全：目录候选带尾 `/`，继续输入即下钻一层；Tab/回车补全选中项（回车拦截为补全而非提交——仅在选中候选时）。
- 安全：目录部分经「词法包含 + realpath 包含」双重校验——`..`/绝对路径/盘符/越界符号链接一律不提供联想；隐藏文件不作候选（显式输 `@.git/` 仍可进入）。
- esc 关闭联想（显式 pathDismissed 状态——本次输入变化前不再弹出/拦截，输入一变即恢复）。
- 目录列表 3s TTL 缓存（大目录逐键重读会卡）；完整 token 恰好指向已存在的文件时补全已终结（弹框关闭）。

**边界与失败模式**：

- 片段输错中途态（目录不存在）→ 无候选不弹；无 cwd（未就绪）不弹。
- 文件被竞态删除 → 照常给候选。

**场景走查**：用户输入「帮我看看 @src/」→ 弹出 src 下条目 → 继续输入 `pa` → 过滤出 path-suggest.ts → 回车补全为完整相对路径 → 继续写需求后提交。

### R-TUI-08 浏览模式

**需求动机**：历史已打印进终端缓冲区（Static），但工具块默认折叠、思考块只显示前 3 行——需要键盘可及的「翻阅 + 展开」方式查看细节。

**详细行为**：

- Ctrl+↑/Ctrl+↓ 在已完成的消息块间移动焦点（含工具块；首次 Ctrl+↑ 从底部进入、聚焦最后一块），BrowseStatusBar 显示「第 N / 总数 + 块摘要 + 展开提示」。
- Enter 切换焦点块的折叠/展开（仅思考/工具块可展开——isExpandable 判定）；esc 退出浏览模式。
- 展开时：命令与输出分层显示（cmd 行弱化、输出着色）、edit_file 渲染 diff 带**真实行号**（解析回执「已替换 1 处（原第 N 行起）」锚点，无锚点不编造坐标）、diff 上下文行前后各保留 2 行。
- 展开状态变化 → 清屏 + Static 重挂载（已打印内容无法就地修改）。

**边界与失败模式**：

- 展开正文行数封顶 200 行（超大输出尾行标注剩余量）。
- 浏览模式下输入框失焦（focus 让位）。
- 焦点移动被限制在块数范围内。

**场景走查**：用户 Ctrl+↑ 三次聚焦一个 edit_file 块 → Enter 展开 → 看到 ± diff 与「第 12 行」标注 → esc 退出继续打字。

### R-TUI-09 状态栏

**需求动机**：agent 运行状态、当前模型、token 占用、工作目录是用户随时需要但不应占据主视区的一屏信息——常驻单行状态栏是终端应用的标准解。

**详细行为**：

- 常驻底部一行（动态区最底）：状态机状态标签（10 态，STATUS_LABELS 同源映射）、provider/model、会话名（title 或 id）、token 估算/窗口（如 `18.4k / 128k`）、会话累计用量、cwd。
- 数据源：每次状态变化随行的 status_state + status_request 主动查询；切换模型/配置后即时刷新（onConfigChanged 钩子不等下一轮对话）。
- 运行中每 2s 轮询 context_request 刷新 token 数字（流式过程中可见增长）。

**边界与失败模式**：

- 配置未就绪时相关字段留空（状态栏骨架仍在）。
- token 估算是本地粗估（口径见 R-SES-10）。
- cwd 独立于 provider 配置——未配置时 /cd 切换仍刷新状态栏。

**场景走查**：用户 /model 切到 deepseek → 状态栏 model 立即变化（无需发消息）→ 提交后状态标签在 Thinking/Responding/Executing 间流转。

### R-TUI-10 主题

**需求动机**：终端配色是长时间使用的舒适度关键，也是品牌表达——多主题 + 即时切换让用户按环境（深/浅色终端）与偏好选择。

**详细行为**：

- 多主题（dawn/forest/midnight 等，THEMES 注册表：name + label + palette），/config → theme → 枚举选择即时生效。
- 主题只控制颜色 token（palette：accent/surface/subtext/cyan/yellow/red 等语义色），不改变布局。
- 切换机制：themeRegistry.set 触发 onChange 订阅 → App 清屏 + Static 重挂载（已打印块按新 palette 重渲染）+ 动态区重渲染。
- 组件经 palette Proxy 透传读取（组件零改动跟随当前主题）；markdown 渲染与工具块着色同样走 token。

**边界与失败模式**：

- set 到不存在的主题名或同名 → 忽略（防御）。
- 主题选择即时生效但不持久化到 config（会话级偏好）。

**场景走查**：用户 /config → theme → 选 forest → 整屏颜色立即切换（含已打印历史块重渲染）→ 布局与滚动位置不变。

### R-TUI-11 会话选择器（/session）

**需求动机**：恢复会话需要在列表里快速定位——TUI 没有侧栏，选择器要承担「列表 + 过滤 + 删除」三件事。

**详细行为**：

- /session 先开空壳选择器（session_list 响应到达后填充——推送不承担弹层职责）。
- 选择器内：
  - 直接打字累积过滤串（query），退格删除字符，列表按 query 过滤（filterSessions 纯函数）；
  - ↑↓ 在过滤结果间循环移动；
  - 回车 resume 选中会话（发 resume_session，view 关闭）；
  - `d` 删除当前选中会话（**仅在未输入过滤时生效**——避免输入 d 搜索时误触发），转确认菜单：确认后先回空壳选择器再发 delete_session（删除当前会话的接管语义见 R-SES-05，列表由 session_list 广播重建）；
  - esc 关闭。

**边界与失败模式**：

- 过滤后 cursor 重置为 0（过滤集变化时旧 cursor 可能越界）。
- 空列表只有 esc 有意义。
- 运行中 resume/delete 被后端阻塞并 notice。

**场景走查**：/session → 输入 "vit" → 列表缩到 2 条 → ↑↓ 选中 → 回车 → 聊天区重建该会话全部消息块，状态栏 title/cwd 更新。

## 边界与立法

- 键盘路由：全局拦截（Ctrl+C）→ 按 view.kind 分派到各 feature 的 keys 处理器（纯逻辑、可单测）。
- Static/动态分层是渲染立法：Static 区打印一次即进终端缓冲（历史），Ink 只重绘底部动态区；修改已打印内容必须清屏重挂。
- 视图态（overlay 栈）是 UI 私有状态，与后端状态机正交；读 state 的按键处理必须走 ref 镜像（Ink 闭包旧值教训）。
