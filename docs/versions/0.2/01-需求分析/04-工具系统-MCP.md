# R-MCP 工具系统-MCP

接入 MCP（Model Context Protocol）服务器，把外部工具纳入统一的工具/权限/展示体系。用户不写代码即可扩展 agent 能力——配一个 server，它的全部工具就出现在模型可用清单里。

## 工作原理概述

**期望状态 vs 运行状态（diff 重建）。** McpManager 内部维护一张 `服务名 → 运行时（配置 + scope + 状态 + SDK client + 工具清单）` 的 Map。`rebuild(desired)` 是唯一的状态迁移入口：传入「当前应有的 server 列表」（全局 config.mcpServers ⊕ 项目 .dogegg/.mcp.json 合并而成，同名项目覆盖全局，scope 随条目下发），对比运行状态做增删启停：

- 停止侧：被移除/停用/transport 配置变化的先停——`stopOne` 同步落状态 + 摘工具，连接关闭后台 1s 竞速执行（被移除的顺带清出 Map，仅配置变化的保留壳体让 listStatus 反映最新配置）；
- 启动侧：启用中但尚未运行/传输变化的逐个启动——connect → listTools → 状态 running。

多次调用幂等收敛到 desired；无变化时空转不广播。触发源很多（启动、config_updated、set_cwd、面板 CRUD），agent 门面把 rebuild 串成 Promise 链防止交错重入——交错会让同一 server 被起两个进程、旧 client 变孤儿泄漏。merge 在执行时刻取值，总是最新配置。

**工具挂载与身份。** 每个运行中 server 的工具以 `mcp__<server>__<tool>` 为 LLM 可见标签独立注册进 ToolRegistry，注册必带身份 `{ kind: 'mcp', server, name }`（server=配置服务名，name=服务侧声明的内部工具名）。身份是权限服务键匹配与 UI 分组的唯一事实源——从不解析 LLM 可见名（哈希标签不可读也无妨）。server 的工具清单变化时「先摘后挂」：先按身份摘除该服务全部旧工具，再注册新清单。参数不本地强校验：zod 仅做「对象」级宽松校验（`z.record(z.string(), z.unknown())`），服务声明的原生 JSON Schema 原样透传给模型——参数校验权在服务。

**单服务隔离。** 启动失败（连不上、协议错误）→ 该服务状态落 error（错误原因随 mcp_list 可见），不抛出；注册失败（合规关口的命名冲突）→ 该服务整体落 error 并摘除其全部工具——绝不因一个坏 server 拖垮对话或其它 server。

**调用回路。** 模型按标签调用 → 适配器 `execute` → 经归属的 SDK client `callTool({ name: 服务侧原始工具名, arguments })`（**发给服务的是内部原名**，不是命名空间标签）→ content 数组拼接为文本（text 块取 text，非 text 块 JSON 序列化）回填模型；`result.isError` → 以 `{ error }` 形式回填。单次调用 60s 超时（`CALL_TIMEOUT_MS`），且接收轮次取消信号。服务离线/未注册 → `{ error: 'MCP server X 未运行' }` 回模型——不终止对话。

**生命周期全异步。** rebuild 由门面 fire-and-forget 调用，状态经 `mcp_list`（配置+状态+工具清单）与 `tools_list`（注册表变化）成对广播；全部生命周期不阻塞对话消息循环。

## 需求点

### R-MCP-01 配置与作用域

**需求动机**：有些 server 是个人工具（全局配一次到处用），有些是项目专属（如数据库迁移 server，只对某个仓库有意义且应随仓库共享给团队）——两个落点缺一不可。

**详细行为**：

- server 配置两个落点：
  - 全局 `~/.dogegg/config.json` 的 `mcpServers` 字段（所有项目可用）；
  - 项目 `<repo>/.dogegg/.mcp.json`（随仓库共享，格式 `{ "mcpServers": [...] }` 与全局同 schema）。
- 合并立法：同名 server 项目覆盖全局，其余全局条目保留，顺序全局在前、项目在后；每条目携带 scope（global/project）下发——面板的启停/删除需要知道写回哪一层。
- 每个 server 条目：`name`（唯一标识，零字符约束——见 R-MCP-09）、`enabled`（默认 true，停用不删除）、`transport`（判别联合，见 R-MCP-02）。

**边界与失败模式**：

- 项目文件读取容错——文件缺失 / JSON 损坏 / 条目校验失败 → 一律视为空数组（项目配置错误不拖垮全局）。
- 写入时自动 `mkdir -p .dogegg`。
- `.gitignore` 现状若忽略 `.dogegg/`，项目级共享需自行调整 ignore（部署侧决策）。

**场景走查**：团队把 playwright server 写进 `.dogegg/.mcp.json` 提交 → 同事 clone 后启动 agent → 该 server 自动出现在合并结果中（scope=project）→ 状态卡片可见。

### R-MCP-02 传输类型

**需求动机**：MCP server 一类是本地子进程（如 npx 启动的文件系统 server），一类是远程托管服务（如云端浏览器 server）——传输抽象必须同时覆盖。

**详细行为**：

- **stdio**：本地子进程——`command`（可执行程序）+ `args`（JSON 数组，如 `["-y", "@modelcontextprotocol/server-xxx"]`）+ `env`（JSON 对象，可选）；agent 通过 stdin/stdout 与其通信（StdioClientTransport）。env 语义：undefined 时继承父进程环境（SDK 默认），显式对象时仅提供指定变量。
- **http**：远程 Streamable HTTP 服务——`url`（端点）+ `headers`（JSON 对象，可选，通常放 `{"Authorization": "Bearer x"}`）（StreamableHTTPClientTransport）。
- transport 是判别联合（`type: 'stdio' | 'http'`），配置编辑表单按 type 展开对应字段。

**边界与失败模式**：

- stdio 子进程启动失败（命令不存在/端口被占）→ connect 抛错 → 状态 error 带原因。
- http 的 URL 非法 → `new URL()` 抛错 → 同样 error 可见。
- headers 里的密钥属用户自己的配置——mcp_list 明细随快照下发供编辑预填（无隐私边界：用户看自己的配置）。

**场景走查**：用户在 /mcp 选「http」新建 → 填 url 与 headers → 保存 → 状态卡从 starting 变 running，工具数显示 N。

### R-MCP-03 连接生命周期与 diff 重建

**需求动机**：配置（增删改/启停）随时变化，运行中的连接必须收敛到期望状态；同时生命周期事件不能阻塞对话——用户在长对话中途启用 server，对话不应卡顿。

**详细行为**：

- 状态机：`starting`（连接中，startOne 立即落此态并广播，面板显示转圈）→ `running`（connect + listTools 成功）或 `error`（失败，含人话原因）；停用/删除 → `stopped`。
- 配置变化触发 diff 重建（见工作原理概述）：停掉已移除/停用/transport 变化的连接，启动新增/未运行的。
- 变化后自动成对广播 `mcp_list` + `tools_list`。
- stopOne 状态变更同步完成（广播/面板即时可见），client.close 后台执行并与 1s 定时器竞速——stdio 子进程退出时序偶发让 close 不返回，同步 await 会卡死整个 rebuild 串行链。

**边界与失败模式**：

- rebuild 链式排队（`mcpRebuildChain`）——前序失败不中断后续（catch 后链继续），状态在 mcp_list 可见。
- disabled 条目跳过启动、保持 stopped。
- `JSON.stringify(transport)` 对比保证「同类型但参数变化」也会重启。

**场景走查**：用户 /mcp 里 t 键停用 server → mcp_manage(toggle) → config_updated → rebuild 发现 enabled=false → stopOne 摘工具 → 面板状态点变灰，/tools 清单里该服务工具消失，全程对话无感。

### R-MCP-04 工具注册与合规

**需求动机**：server 的工具名不受 agent 控制且不可预期（可能含中文、超长、非法字符）——直接透传给模型会让请求 400（供应商对函数名的硬约束）。

**详细行为**：

- 服务的每个工具**独立注册**为 `mcp__<server>__<tool>`（命名空间防撞 + 权限可通配），description 缺省时回退 `(MCP <server>) <tool>`。
- 注册走统一合规关口（R-TLB-08）：标签不合规 → 整体哈希 `h-<12hex>`（确定性，同名必同标签）；与已有工具冲突（含内建工具、其它服务的工具）→ 抛错 → 该服务整体落 error 可见失败。
- 服务声明的**原生 JSON Schema 原样透传**为工具的 `parameters`——模型看到的参数定义与服务文档一致。
- agent 侧 zod 仅做对象级宽松校验，参数校验权在服务（服务返回 isError 时 agent 如实回填）。

**边界与失败模式**：

- server 名本身含非法字符（如中文）→ 整个标签不合规 → 该服务全部工具哈希化——服务照常可用，只是 LLM 可见名不可读。
- 身份（server/name 原文）完好保留在 ToolIdentity 里，权限与展示不受影响。

**场景走查**：服务 `浏览器` 声明工具 `打开网页` → 标签 `mcp__浏览器__打开网页` 不合规 → 哈希为 `h-a1b2c3d4e5f6` → 模型调用该标签 → 适配器按身份把原始名 `打开网页` 发给服务。

### R-MCP-05 单服务隔离

**需求动机**：用户可能同时接 5 个 server，其中一个是坏的（命令写错、网络不通）。隔离失败会让「一个坏 server」升级为「agent 完全不可用」。

**详细行为**：

- 任一服务的启动/注册失败只影响自身：startOne 的 catch 把状态落 error + 记录原因，不向上抛。
- syncRegistry 的注册失败把该服务状态落 error、摘除其全部工具（含冲突前已注册的——清掉半挂状态），其余服务照常运行。
- 坏服务在面板上是清晰的红色状态卡 + 错误行，对话与其它服务无感。
- rebuild 的 Promise 链 catch 掉一切——前一个服务的失败不阻断后续服务的启动。

**边界与失败模式**：

- 失败后重试路径：用户修复配置保存 → config_updated → rebuild → startOne 重新尝试。
- error 态服务的工具不在注册表中（不占模型 schema）。
- error 信息随 mcp_list 明细下发，两端面板直接展示。

**场景走查**：三个 server 中 `db-migrate` 的 command 拼错 → 启动后两个 running、一个 error（错误行：spawn ENOENT）→ 对话照常，模型只用另外两个服务的工具。

### R-MCP-06 冲突可见

**需求动机**：两个 server 声明了同名工具、或 MCP 工具标签与内建工具重名时，静默覆盖（后注册顶掉先注册）会让先注册的工具无声失联——模型调用它时才发现不存在，排查极其困难。

**详细行为**：

- 注册标签（常规名或哈希标签）与已有工具冲突 → `register` 抛错 → 后注册方失败。
- 错误信息含冲突标签与建议（「请调整来源命名（如 /mcp 中的服务名）」）——用户改服务名即可解决（服务名是标签的组成部分）。
- 冲突检测覆盖所有来源：内建、其它 MCP 服务、同服务内重名工具。

**边界与失败模式**：

- 冲突只发生在「同标签」——不同服务的不同工具名各自带服务名前缀，天然无冲突。
- 哈希标签撞车概率可忽略（12 位 hex）。
- 失败方是「后注册者」，先注册方不受影响。

**场景走查**：server A 与 B 都有工具 `query` → A 先注册成功（`mcp__A__query`）、B 的标签 `mcp__B__query` 不冲突——只有服务名完全相同（配置重名，已被 R-MCP-01 合并立法排除）或哈希碰撞才冲突。

### R-MCP-07 来源身份

**需求动机**：「这个工具来自哪个服务」的答案被多处消费（权限服务键匹配、UI 分组展示、按归属摘除）。如果各处自行解析 LLM 可见名（按 `__` 拆分），哈希标签与名字含 `__` 的服务都会拆错——身份必须成为唯一事实源。

**详细行为**：

- 每个 MCP 工具注册时记录身份 `{ kind: 'mcp', server, name }`：server = 配置服务名（原文，零字符约束），name = 服务侧声明的内部工具名（原文）。
- 消费方：
  - 权限引擎 `mcpServerHit`——按 `identities.get(tool)` 取身份，在其 `mcp:<服务名>` 前缀键上匹配（见 R-MCP-09）；
  - McpManager.unregisterServerTools——`labelsWhere(id => id.kind === 'mcp' && id.server === server)` 找到全部标签逐个摘除（先摘后挂的「摘」侧）；
  - UI——tools_list 随行身份，WebUI Available Tools 卡按服务分组、TUI /config 权限选择器按服务枚举内部工具名（勾选式细化）。

**边界与失败模式**：

- 注册表不变量「凡注册必有身份」；身份与工具同增同删（unregister 双 Map 同步删除）。
- 服务离线时身份仍在权限规则里匹配（纯配置匹配，见 R-MCP-09）。

**场景走查**：哈希化的工具 `h-a1b2c3d4e5f6` 身份 `{ server: '浏览器', name: '打开网页' }` → WebUI 分组显示在「浏览器」服务组下、行内标注内部短名「打开网页」；权限键 `mcp:浏览器` 的规则对它生效。

### R-MCP-08 启停与 CRUD

**需求动机**：调试时需要临时关掉一个 server（不停用配置就丢失）；server 配置本身需要增删改。两端 UI 必须能力对等，且写回落点（全局/项目）必须正确。

**详细行为**：

- `enabled: false` 停用 = 断开连接 + 摘除工具，配置保留（调试/临时关闭，t 键/按钮切回）。
- 增删改启停经 /mcp 面板（TUI：a 新建→选传输类型→表单、e 编辑、t 启停、d 删除确认、Enter 详情）或 WebUI 设置 MCP Servers 区（状态卡片 + 表单 + 删除确认），两端走同一套 `mcp_manage` 消息。
- 实现归属：global scope 走 ConfigEditor（`replaceMcpServers` → 复用校验/落盘/config_updated 广播链路 → rebuild）；project scope 直写 `.dogegg/.mcp.json` 后显式触发 rebuild。
- 编辑态预填现有 transport 明细，enabled 保留（编辑停用中的 server 不会误启用）。

**边界与失败模式**：

- save 按 name upsert——名称是身份，锁定不可改。
- 校验失败（名称空/command 空/args 非 JSON 数组/env 非 JSON 对象）→ notice 提示并留在表单，不写配置（宁可少配不可错配）。
- 运行中（gate busy）管理操作被阻塞（「运行中，请稍候」）——写配置与重建会影响 in-flight 工具。

**场景走查**：TUI /mcp → a → 选 stdio → 表单填 command=`npx`、args=`["-y","@modelcontextprotocol/server-filesystem","."]` → s 保存 → 全局配置落盘 → rebuild → 状态 running → /tools 出现 `mcp__<server>__read_file` 等。

### R-MCP-09 服务键权限

**需求动机**：MCP 工具需要批量授权（整组放行）与细化（只放行某几个），且匹配必须与 LLM 可见名解耦（哈希标签不可读）。服务键还要与内建工具键的键空间正交，避免歧义。

**详细行为**：

- 权限桶键支持 `mcp:<服务名>`（**必须带前缀**——裸服务名键在 config 加载期被 superRefine 拒绝：前缀化立法下裸键会静默失配，加载期直接报错并指明写法）。
- 规则语义与 v3 一致：
  - `whole: true` 整组生效——该服务下所有工具，服务升级新增工具自动覆盖；
  - `whole: false` 时 patterns 与**服务内部工具名**做平文本精确/通配匹配（matchWildcard，如 `browser_close`、`browser_*`）——这是「哪些工具被本规则覆盖」的**启用匹配，永不涉及工具执行参数**（MCP 参数 schema 服务自定义，无主参数概念）。
- 匹配按注册期身份：引擎取 `identities.get(标签)`，`kind === 'mcp'` 才走服务键分支，查 `bucket['mcp:<id.server>']`。
- 服务名零字符约束：前缀 `mcp:` 隔离保证与内建工具名（不含冒号）、其它服务名（含 `__`、中文、空格、与内建同名）均无歧义。
- 服务离线时规则保留（纯配置匹配，不依赖运行状态），重连自动生效。
- 服务删除后规则成为孤儿（UI 可见可清理，不自动删除）；项目级服务键授权随 `.dogegg/` 进 git 与仓库共享。

**边界与失败模式**：

- 跨桶优先级不受服务键影响——「allow 整组 + ask 勾选个别」可行，反向被桶优先级压制。
- 身份快照由 agent 在 classify 时现取（提供者函数而非静态快照）——MCP 启停后匹配永远基于最新注册表。

**场景走查**：用户在 WebUI Permissions 区对 `mcp:playwright` 勾选 `browser_navigate` 与 `browser_*` → 保存后模型调 `mcp__playwright__browser_navigate` → 引擎按身份命中 → allow；调 `browser_pdf`（未勾选）→ 未命中 → 默认 ask。

### R-MCP-10 调用

**需求动机**：调用回路是 MCP 集成的最后一环——模型给出的标签要路由回正确的服务与正确的内部名，失败要有界（超时）且可恢复（不终止对话）。

**详细行为**：

- 模型按 LLM 可见标签调用（常规名或哈希标签）→ zod 宽松校验 → 权限网关（服务键判定 + 固定安全默认：三桶无规则时第三方工具默认 ask）。
- 适配器经归属的 client `callTool({ name: tool.name /* 服务侧原始工具名 */, arguments })`，传 `{ signal: ctx.signal, timeout: 60_000 }`——单次调用 60s 超时，且轮次取消会中断调用。
- 结果处理：content 数组逐块取 text（非 text 块 JSON 序列化）以换行拼接；`result.isError` → `{ error: text || 'MCP 工具 X 执行失败' }`；异常（超时/连接断开）→ `{ error: 'MCP 调用失败：<原因>' }`。
- 所有失败形态都作为 tool 消息回填模型——模型可换路或向用户说明，对话不终止。

**边界与失败模式**：

- 服务离线（client 为空）→ `{ error: 'MCP server X 未运行' }`。
- 调用期间 server 被停用 → rt.client 置空 → 下一次调用报「未运行」。
- 60s 超时是 SDK 层 Promise 超时——服务慢但最终返回也按超时算（有界等待优先于无限等待）。
- 取消传播：ctx.signal abort → SDK 中断 → catch 回填。

**场景走查**：模型调 `mcp__playwright__browser_navigate { url: 'https://example.com' }` → ask 审批放行 → 适配器向服务发 `{ name: 'browser_navigate', arguments: { url: … } }` → 服务返回截图描述文本 → 回填模型继续推理；服务宕机时同调用回填「MCP 调用失败：…」，模型改用 read_file 方案。

## 边界与立法

- 服务名零约束是立法（`mcp:` 前缀隔离保证无歧义）；唯一拒绝场景：裸服务名键与 mcpServers 服务同名（加载期拒绝，见 05-权限与安全 R-PRM-03 的交叉校验）。
- 工具数量上限、服务级元工具聚合（把 N 个工具折叠成 1 个）均为**非目标**——原生 JSON Schema 透传优先。
- 项目级 server 定义于 `.dogegg/.mcp.json`，随仓库共享（注意：.gitignore 现状忽略 `.dogegg/`，共享需自行调整 ignore，属部署侧决策）。
