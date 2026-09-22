# R-MCP 工具系统-MCP

> 接入 MCP（Model Context Protocol）服务器，把外部工具纳入统一的工具/权限/展示体系。用户不写代码即可扩展 agent 能力——配一个 server，它的全部工具就出现在模型可用清单里，并受同一套权限网关与审批流约束。覆盖：server 配置（两级作用域、两种传输）、连接生命周期、工具注册与身份、启停 CRUD、服务键权限、调用回路。

## 功能点清单

| 点号 | 功能点 | 一句话概要 | 详见设计实现 |
|---|---|---|---|
| R-MCP-01 | 配置与作用域 | 全局 config 与项目 .mcp.json 两级落点、同名覆盖合并 | [07-MCP客户端](../02-设计实现/07-MCP客户端.md) |
| R-MCP-02 | 传输类型 | stdio 本地子进程与 http 远程两种判别联合 | [07-MCP客户端](../02-设计实现/07-MCP客户端.md) |
| R-MCP-03 | 连接生命周期与 diff 重建 | 状态机 + rebuild 幂等收敛到期望状态 | [07-MCP客户端](../02-设计实现/07-MCP客户端.md) |
| R-MCP-04 | 工具注册与合规 | 命名空间标签、不合规哈希、原生 JSON Schema 透传 | [07-MCP客户端](../02-设计实现/07-MCP客户端.md)、[04-工具注册表与合规关口](../02-设计实现/04-工具注册表与合规关口.md) |
| R-MCP-05 | 单服务隔离 | 单个坏 server 只落自身 error，不拖垮对话 | [07-MCP客户端](../02-设计实现/07-MCP客户端.md) |
| R-MCP-06 | 冲突可见 | 注册标签冲突抛错，绝不静默覆盖 | [04-工具注册表与合规关口](../02-设计实现/04-工具注册表与合规关口.md) |
| R-MCP-07 | 来源身份 | ToolIdentity 是归属语义的唯一事实源 | [04-工具注册表与合规关口](../02-设计实现/04-工具注册表与合规关口.md) |
| R-MCP-08 | 启停与 CRUD | 两端 mcp_manage 增删改启停、写回落点正确 | [07-MCP客户端](../02-设计实现/07-MCP客户端.md) |
| R-MCP-09 | 服务键权限 | mcp:<服务名> 键批量授权与勾选细化 | [07-MCP客户端](../02-设计实现/07-MCP客户端.md)、[06-权限引擎](../02-设计实现/06-权限引擎.md) |
| R-MCP-10 | 调用 | callTool 回路 60s 超时、失败回填不终止对话 | [07-MCP客户端](../02-设计实现/07-MCP客户端.md) |

## 域机制概览

**期望状态 vs 运行状态（diff 重建）。** McpManager 内部维护一张 `服务名 → 运行时（配置 + scope + 状态 + SDK client + 工具清单）` 的 Map。`rebuild(desired)` 是唯一的状态迁移入口：传入「当前应有的 server 列表」（全局 config.mcpServers ⊕ 项目 .dogegg/.mcp.json 合并而成，同名项目覆盖全局，scope 随条目下发），对比运行状态做增删启停——停止侧先停（被移除/停用/transport 配置变化的），启动侧后起（启用中但尚未运行/传输变化的：connect → listTools → running）。多次调用幂等收敛到 desired；无变化时空转不广播。

**重建的串行化。** 触发源很多（agent 启动、config_updated、set_cwd、面板 CRUD），agent 门面把 rebuild 串成 Promise 链（`mcpRebuildChain`）防止交错重入——交错会让同一 server 被起两个进程、旧 client 变孤儿泄漏。merge 在执行时刻取值，总是最新配置。

**工具挂载与身份。** 每个运行中 server 的工具以 `mcp__<server>__<tool>` 为 LLM 可见标签独立注册进 ToolRegistry，注册必带身份 `{ kind: 'mcp', server, name }`（server=配置服务名，name=服务侧声明的内部工具名）。身份是权限服务键匹配与 UI 分组的唯一事实源——从不解析 LLM 可见名（哈希标签不可读也无妨）。server 的工具清单变化时「先摘后挂」：先按身份摘除该服务全部旧工具，再注册新清单。参数不本地强校验：zod 仅做「对象」级宽松校验，服务声明的原生 JSON Schema 原样透传给模型——参数校验权在服务。

**单服务隔离。** 启动失败（连不上、协议错误）→ 该服务状态落 error（错误原因随 mcp_list 可见），不抛出；注册失败（合规关口的命名冲突）→ 该服务整体落 error 并摘除其全部工具——绝不因一个坏 server 拖垮对话或其它 server。

**调用回路与全异步生命周期。** 模型按标签调用 → 适配器 `execute` → 经归属的 SDK client `callTool({ name: 服务侧原始工具名, arguments })`（**发给服务的是内部原名**，不是命名空间标签）→ content 数组拼接为文本回填模型；单次调用 60s 超时（`CALL_TIMEOUT_MS`）且接收轮次取消信号，一切失败形态都以 `{ error }` 作为 tool 消息回填——不终止对话。rebuild 由门面 fire-and-forget 调用，状态经 `mcp_list`（配置+状态+工具清单）与 `tools_list`（注册表变化）成对广播，全部生命周期不阻塞对话消息循环。

### R-MCP-01 配置与作用域

- **需求背景与动机**：有些 server 是个人工具（全局配一次到处用），有些是项目专属（如数据库迁移 server，只对某个仓库有意义且应随仓库共享给团队）——两个落点缺一不可。没有项目落点，团队每个成员都得手工重配一遍；没有全局落点，个人高频工具要在每个仓库重复填写。
- **功能规格**：
  - 输入与前置：
    1. 全局落点：`~/.dogegg/config.json` 的 `mcpServers` 字段（所有项目可用）。
    2. 项目落点：`<repo>/.dogegg/.mcp.json`（随仓库共享，格式 `{ "mcpServers": [...] }`，与全局同 schema——`mcpServerSchema` 单一出处）。
    3. 每个 server 条目三字段：`name`（唯一标识；无字符集约束——中文、`__`、空格均合法，仅要求非空，见 R-MCP-09）、`enabled`（默认 true，停用不删除）、`transport`（判别联合，见 R-MCP-02）。
  - 处理规则：
    4. 合并立法（mergeMcpServers）：同名 server 项目覆盖全局（整体覆盖，不做字段级合并）；其余全局条目保留；顺序全局在前、项目在后。
    5. 每条目携带 scope（global/project）随合并结果下发——面板的启停/删除需要知道写回哪一层；合并产出 `McpMergedEntry { server, scope }` 数组，是 rebuild(desired) 的直接输入。
  - 输出与用户可见表现：
    6. 合并结果即 /mcp 面板与 mcp_list 快照的条目全集，每条可见 scope 标注。
  - 配置与命令入口：
    7. 写入项目文件自动 `mkdir -p .dogegg`；CRUD 经 TUI /mcp 或 WebUI 设置区走 `mcp_manage` 消息落对应层（见 R-MCP-08）。
- **边界与失败模式**：
  - 项目文件读取容错——文件缺失 / JSON 损坏 / 条目校验失败 → 一律视为空数组（项目配置错误不拖垮全局）。
  - `.gitignore` 现状若忽略 `.dogegg/`，项目级共享需自行调整 ignore（部署侧决策）。
  - 项目同名覆盖是「整个条目」替换——全局条目的 enabled/transport 不会与项目条目做字段级融合。
- **验收标准**：
  1. 当全局与项目各有一个同名 server 且 transport 不同，则运行与面板展示均为项目版本且 scope=project。
  2. 当 `.mcp.json` 是非法 JSON，则合并结果等于全局条目全集，agent 正常启动无 notice 中断。
  3. 当在项目层新增一条 stdio server，则 `.dogegg/` 目录与 `.mcp.json` 被自动创建且文件顶层为 `mcpServers` 数组。
  4. 当删除项目文件后触发重建，则该项目 server 停止并从面板消失，全局条目不受影响。
  5. 当项目同名条目 enabled=false 覆盖全局运行中的条目，则该 server 被停用（覆盖后的条目为准）。
- **场景走查**：团队把 playwright server 写进 `.dogegg/.mcp.json` 提交 → 同事 clone 后启动 agent → 该 server 自动出现在合并结果中（scope=project）→ 状态卡片可见。

### R-MCP-02 传输类型

- **需求背景与动机**：MCP server 一类是本地子进程（如 npx 启动的文件系统 server），一类是远程托管服务（如云端浏览器 server）——传输抽象必须同时覆盖，否则一类用户只能改代码接入。
- **功能规格**：
  - 输入与前置：
    1. **stdio**：`command`（可执行程序）+ `args`（JSON 数组，如 `["-y", "@modelcontextprotocol/server-xxx"]`，缺省空数组）+ `env`（JSON 对象，可选）；agent 通过 stdin/stdout 与其通信（StdioClientTransport）。
    2. **http**：`url`（端点）+ `headers`（JSON 对象，可选，通常放 `{"Authorization": "Bearer x"}`）（StreamableHTTPClientTransport）。
  - 处理规则：
    3. transport 是判别联合（`type: 'stdio' | 'http'`），schema 层按 type 校验各自字段（discriminatedUnion）；配置编辑表单按 type 展开对应字段。
    4. schema 缺省值：args 缺省空数组，env/headers 为可选 record——手写最小配置只需 command（stdio）或 url（http）。
    5. env 语义：undefined 时继承父进程环境（SDK 默认行为），显式对象时仅提供指定变量——值原样透传 SDK，不做加工。
  - 输出与用户可见表现：
    5. mcp_list 快照携带 transport 明细（含 type），面板按状态卡呈现并供编辑预填。
- **边界与失败模式**：
  - stdio 子进程启动失败（命令不存在/端口被占）→ connect 抛错 → 状态 error 带原因。
  - http 的 URL 非法 → `new URL()` 抛错 → 同样 error 可见。
  - headers 里的密钥属用户自己的配置——mcp_list 明细随快照下发供编辑预填（无隐私边界：用户看自己的配置）。
- **验收标准**：
  1. 当配置 type=stdio 且 command 指向不存在的程序，则该服务状态为 error 且错误信息含启动失败原因。
  2. 当配置 type=http 且 url 为非法字符串，则同样落 error 且原因可见。
  3. 当 stdio 条目不写 env，则子进程继承 agent 的父进程环境变量。
  4. 当 http 条目写 headers，则每次请求按 headers 原文携带（如 Bearer token 生效）。
- **场景走查**：用户在 /mcp 选「http」新建 → 填 url 与 headers → 保存 → 状态卡从 starting 变 running，工具数显示 N。

### R-MCP-03 连接生命周期与 diff 重建

- **需求背景与动机**：配置（增删改/启停）随时变化，运行中的连接必须收敛到期望状态；同时生命周期事件不能阻塞对话——用户在长对话中途启用 server，对话不应卡顿。
- **功能规格**：
  - 触发条件：
    1. agent 启动、config_updated（含 mcpServers 编辑）、set_cwd（项目级 .mcp.json 随 cwd 变化）、面板 CRUD（mcp_manage）均触发 rebuild；启动时 fire-and-forget 拉起已配置的 server（失败在 mcp_list 里可见，不阻塞构造）。
  - 处理规则：
    2. 状态机：`starting`（startOne 立即落此态并广播，面板显示转圈）→ `running`（connect + listTools 成功，error 清空、工具清单填充）或 `error`（失败，含人话原因、工具清单清空）。
    3. 停止侧：被移除/停用/transport 配置变化（`JSON.stringify(transport)` 对比）的先停——`stopOne` 同步落状态 + 摘工具，连接关闭后台 1s 竞速执行；被移除的顺带清出 Map（面板不再出现），仅停用/配置变化的保留壳体让 listStatus 反映最新配置（停用态为 stopped）。
    4. 启动侧：启用中但尚未运行/传输变化的逐个启动（connect → listTools → 状态 running）。
    5. stopOne 状态变更同步完成（广播/面板即时可见），client.close 后台执行并与 1s 定时器竞速——stdio 子进程退出时序偶发让 close 不返回，同步 await 会卡死整个 rebuild 串行链。
    6. 多次调用幂等收敛到 desired；无变化时空转不广播；重建收尾再清一轮被移除后残留的空壳。
  - 输出与用户可见表现：
    7. 变化后自动成对广播 `mcp_list`（配置+状态+工具清单）与 `tools_list`（注册表变化）。
- **边界与失败模式**：
  - rebuild 链式排队（`mcpRebuildChain`）——前序失败不中断后续（catch 后链继续），状态在 mcp_list 可见。
  - disabled 条目跳过启动、保持 stopped。
  - `JSON.stringify(transport)` 对比保证「同类型但参数变化」也会重启。
  - error 态壳体保留原因，不自动重试——修复后的重试由下一次 rebuild 承担（见 R-MCP-05）。
- **验收标准**：
  1. 当对话运行中途发送 mcp_manage 新增 server，则对话消息循环不被阻塞，状态卡先 starting 后 running。
  2. 当仅修改 stdio server 的 args 而类型不变，则旧进程被停止并以新参数重启。
  3. 当删除一个运行中的 server，则其工具从 /tools 消失且 mcp_list 中不再出现该条目。
  4. 当 close 挂起超过 1s，则竞速兜底生效，后续 rebuild 不被卡死。
  5. 当 disabled 条目触发 rebuild，则保持 stopped 且不发起任何连接。
- **场景走查**：用户 /mcp 里 t 键停用 server → mcp_manage(toggle) → config_updated → rebuild 发现 enabled=false → stopOne 摘工具 → 面板状态点变灰，/tools 清单里该服务工具消失，全程对话无感。
- **场景走查（新增）**：用户 /cd 切到带项目级 .mcp.json 的目录 → set_cwd 触发 rebuild → 新项目专属 server 从 starting 变 running，旧项目的项目级 server 被停止摘除——全程无需重启 agent。

### R-MCP-04 工具注册与合规

- **需求背景与动机**：server 的工具名不受 agent 控制且不可预期（可能含中文、超长、非法字符）——直接透传给模型会让请求 400（供应商对函数名的硬约束），一次不合规就废掉整轮对话。
- **功能规格**：
  - 处理规则：
    1. 服务的每个工具**独立注册**为 `mcp__<server>__<tool>`（命名空间防撞 + 权限可通配），description 缺省时回退 `(MCP <server>) <tool>`。
    2. 注册走统一合规关口（R-TLB-08）：LLM 可见名硬约束 `[a-zA-Z0-9_-]{1,64}`（OpenAI 系与 Anthropic 系一致，非法名在 API 请求层会拒绝整个请求）；标签不合规 → 整体哈希 `h-<12hex>`（sha256 确定性，同名必同标签），变换落在 Tool 对象本身，保证 schemas() 发出的名字必然合规。
    3. 与已有工具冲突（含内建工具、其它服务的工具）→ `register` 抛错 → 该服务整体落 error 可见失败（见 R-MCP-06）。
    4. 服务声明的**原生 JSON Schema 原样透传**为工具的 `parameters`——模型看到的参数定义与服务文档一致。
    5. agent 侧 zod 仅做对象级宽松校验（`z.record(z.string(), z.unknown())`），参数校验权在服务（服务返回 isError 时 agent 如实回填，见 R-MCP-10）。
    6. 挂载走「先摘后挂」：先按身份摘除该服务全部旧工具，再注册新清单（见 R-MCP-07）。
    7. register 返回最终注册标签——常规情况等于原名，哈希情况为 `h-<hash>`，调用方据此对接身份语义；identity 缺省为 builtin（内建构造路径零改动接入）。
  - 输出与用户可见表现：
    7. /tools 与 tools_list 中该服务工具带身份标注（内建 / MCP · 服务名），哈希标签行同时可见内部工具名。
- **边界与失败模式**：
  - server 名本身含非法字符（如中文）→ 整个标签不合规 → 该服务全部工具哈希化——服务照常可用，只是 LLM 可见名不可读。
  - 身份（server/name 原文）完好保留在 ToolIdentity 里，权限与展示不受影响。
  - 哈希是 sha256 截断的确定性变换——服务重启/重连后同一工具必得同一标签，权限规则与 UI 分组跨重启不漂移。
- **验收标准**：
  1. 当服务声明工具 `read-file` 且服务名为 `fs`，则模型可见标签为 `mcp__fs__read-file` 且 parameters 与服务 schema 逐字段一致。
  2. 当标签含中文被哈希化，则模型调用 `h-<12hex>` 仍能路由回原始名执行。
  3. 当某工具标签与内建工具重名，则该服务落 error 且其已注册工具全部摘除。
- **场景走查**：服务 `浏览器` 声明工具 `打开网页` → 标签 `mcp__浏览器__打开网页` 不合规 → 哈希为 `h-a1b2c3d4e5f6` → 模型调用该标签 → 适配器按身份把原始名 `打开网页` 发给服务。

### R-MCP-05 单服务隔离

- **需求背景与动机**：用户可能同时接 5 个 server，其中一个是坏的（命令写错、网络不通）。隔离失败会让「一个坏 server」升级为「agent 完全不可用」。
- **功能规格**：
  - 处理规则：
    1. 任一服务的启动失败只影响自身：startOne 的 catch 把状态落 error + 记录原因，不向上抛。
    2. syncRegistry 的注册失败把该服务状态落 error、摘除其全部工具（含冲突前已注册的——清掉半挂状态），其余服务照常运行。
    3. rebuild 的 Promise 链 catch 掉一切——前一个服务的失败不阻断后续服务的启动。
  - 输出与用户可见表现：
    4. 坏服务在面板上是清晰的红色状态卡 + 错误行，对话与其它服务无感。
    5. error 信息随 mcp_list 明细下发，两端面板直接展示。
- **边界与失败模式**：
  - 失败后重试路径：用户修复配置保存 → config_updated → rebuild → startOne 重新尝试。
  - error 态服务的工具不在注册表中（不占模型 schema）。
  - 启动成功但 listTools 抛错同样落 error（工具清单为空壳）。
- **验收标准**：
  1. 当三个 server 中一个 command 拼错，则两个 running、一个 error，模型 schema 中只有前两者的工具。
  2. 当坏服务修复并保存，则下一次 rebuild 将其重启至 running。
  3. 当注册期发生命名冲突，则该服务全部工具（含冲突前已挂的）从注册表消失。
  4. 当 error 服务被删除后以正确配置重新添加，则 rebuild 直接启动新条目至 running（无残留旧壳）。
- **场景走查**：三个 server 中 `db-migrate` 的 command 拼错 → 启动后两个 running、一个 error（错误行：spawn ENOENT）→ 对话照常，模型只用另外两个服务的工具。

### R-MCP-06 冲突可见

- **需求背景与动机**：两个 server 声明了同名工具、或 MCP 工具标签与内建工具重名时，静默覆盖（后注册顶掉先注册）会让先注册的工具无声失联——模型调用它时才发现不存在，排查极其困难。
- **功能规格**：
  - 处理规则：
    1. 注册标签（常规名或哈希标签）与已有工具冲突 → `register` 抛错 → 后注册方失败。
    2. 错误信息含冲突标签、原名与建议——完整文案为「工具注册名冲突：`<标签>`（原名 `<原名>`）已被占用——请调整来源命名（如 /mcp 中的服务名）」，用户改服务名即可解决（服务名是标签的组成部分）。
    3. 冲突检测覆盖所有来源：内建、其它 MCP 服务、同服务内重名工具。
    4. 检测发生在 register 时刻（同步、无异步竞态）——注册顺序即 rebuild 遍历序，失败方隔离落点见 R-MCP-05。
  - 输出与用户可见表现：
    4. 失败方服务在面板显示 error 态，错误行即冲突信息（见 R-MCP-05 的隔离落点）。
- **边界与失败模式**：
  - 冲突只发生在「同标签」——不同服务的不同工具名各自带服务名前缀，天然无冲突。
  - 哈希标签撞车概率可忽略（12 位 hex）。
  - 失败方是「后注册者」，先注册方不受影响。
- **验收标准**：
  1. 当服务 A 先注册成功后服务 B 的某工具标签与其相同，则 B 落 error、A 的工具保持可用。
  2. 当两个服务名不同但工具同名，则两者各自以 `mcp__A__x` / `mcp__B__x` 注册成功互不冲突。
  3. 当冲突发生，则错误文本中能定位到冲突标签与改名列建议。
- **场景走查**：server A 与 B 都有工具 `query` → A 先注册成功（`mcp__A__query`）、B 的标签 `mcp__B__query` 不冲突——只有服务名完全相同（配置重名，已被 R-MCP-01 合并立法排除）或哈希碰撞才冲突。

### R-MCP-07 来源身份

- **需求背景与动机**：「这个工具来自哪个服务」的答案被多处消费（权限服务键匹配、UI 分组展示、按归属摘除）。如果各处自行解析 LLM 可见名（按 `__` 拆分），哈希标签与名字含 `__` 的服务都会拆错——身份必须成为唯一事实源。
- **功能规格**：
  - 处理规则：
    1. 每个 MCP 工具注册时记录身份 `{ kind: 'mcp', server, name }`：server = 配置服务名（原文，无字符集约束），name = 服务侧声明的内部工具名（原文）。
    2. 消费方一——权限引擎 `mcpServerHit`：按 `identities.get(tool)` 取身份，在其 `mcp:<服务名>` 前缀键上匹配（见 R-MCP-09）。
    3. 消费方二——McpManager.unregisterServerTools：`labelsWhere(id => id.kind === 'mcp' && id.server === server)` 找到全部标签逐个摘除（先摘后挂的「摘」侧；哈希标签不带 `mcp__` 前缀，前缀字符串扫描会漏删，按身份摘除是唯一可靠方式）。
    4. 消费方三——UI：tools_list 随行身份，WebUI Available Tools 卡按服务分组、TUI /config 权限选择器按服务枚举内部工具名（勾选式细化）。
    5. 注册表的身份访问口三个：`identityOf(label)` 单查、`identities()` 全量快照（权限引擎注入用）、`labelsWhere(谓词)` 按身份找标签（按服务摘除用）；tools_list 每条为 `ToolListItem { name, description, identity }`。
  - 输出与用户可见表现：
    6. tools_list 每条必带 identity（注册表不变量「凡注册必有身份」）。
- **边界与失败模式**：
  - 身份与工具同增同删（unregister 双 Map 同步删除）。
  - 身份快照是只读视图（ReadonlyMap）——消费方（权限引擎/UI）只能读不能改写注册表。
  - 服务离线时身份仍在权限规则里匹配（纯配置匹配，见 R-MCP-09）。
- **验收标准**：
  1. 当工具被哈希化，则 WebUI 分组仍按身份显示在原服务组下并标注内部短名。
  2. 当服务被停止，则 labelsWhere 按身份摘除的标签数等于该服务此前注册的工具数（哈希工具不漏删）。
  3. 当权限规则以 `mcp:<服务名>` 书写，则匹配结果与该服务的工具是否哈希化无关。
- **场景走查**：哈希化的工具 `h-a1b2c3d4e5f6` 身份 `{ server: '浏览器', name: '打开网页' }` → WebUI 分组显示在「浏览器」服务组下、行内标注内部短名「打开网页」；权限键 `mcp:浏览器` 的规则对它生效。

### R-MCP-08 启停与 CRUD

- **需求背景与动机**：调试时需要临时关掉一个 server（不停用配置就丢失）；server 配置本身需要增删改。两端 UI 必须能力对等，且写回落点（全局/项目）必须正确——写错层的配置会在错误的作用域生效或丢失。
- **功能规格**：
  - 配置与命令入口：
    1. `enabled: false` 停用 = 断开连接 + 摘除工具，配置保留（调试/临时关闭，t 键/按钮切回）。
    2. 增删改启停经 /mcp 面板（TUI：a 新建→选传输类型→表单、e 编辑、t 启停、d 删除确认、Enter 详情）或 WebUI 设置 MCP Servers 区（状态卡片 + 表单 + 删除确认），两端走同一套 `mcp_manage` 消息（action: save/delete/toggle + scope + server/name/enabled）。
    3. 实现归属：global scope 走 ConfigEditor（`replaceMcpServers` → 复用校验/落盘/config_updated 广播链路 → rebuild）；project scope 直写 `.dogegg/.mcp.json` 后显式触发 rebuild。
    4. 编辑态预填现有 transport 明细（来自 mcp_list 快照），enabled 保留（编辑停用中的 server 不会误启用）。
  - 处理规则：
    5. save 按 name upsert——名称是身份，锁定不可改；delete 按 name 过滤移除；toggle 仅翻转 enabled。
    6. 消息缺参（save 无 server、delete/toggle 的 name 未命中）→ notice 提示（「缺少 server 配置」/「未找到 server：X」），不改配置。
    7. global 侧写配置经配置编辑统一入口——同样受 gate busy 阻塞与 zod 校验（与 /config 编辑双重保险）；delete 成功后除重建广播外显式补推一次 mcp_list。
    8. project 侧直写文件后显式触发 rebuild 并补推 mcp_list（不经 config_updated 链路）。
  - 输出与用户可见表现：
    7. 保存/启停成功后 mcp_list 与 /tools 清单自动刷新（rebuild 成对广播）。
- **边界与失败模式**：
  - 校验失败（名称空/command 空/args 非 JSON 数组/env 非 JSON 对象）→ notice 提示并留在表单，不写配置（宁可少配不可错配）。
  - 运行中（gate busy）管理操作被阻塞（「运行中，请稍候」）——写配置与重建会影响 in-flight 工具。
- **验收标准**：
  1. 当在 TUI 与 WebUI 分别执行同一 save，则落点层与最终配置完全一致（同一 schema 校验）。
  2. 当编辑一个 scope=project 的 server，则改动只写入 `.mcp.json`，全局 config.json 不变。
  3. 当 gate busy 时发送 mcp_manage，则收到「运行中，请稍候」且配置未变。
  4. 当表单提交非法 args（非 JSON 数组），则留在表单且 notice 指明原因。
  5. 当 toggle 一个不存在的服务名，则 notice「未找到 server：X」且两侧配置均不变。
- **场景走查**：TUI /mcp → a → 选 stdio → 表单填 command=`npx`、args=`["-y","@modelcontextprotocol/server-filesystem","."]` → s 保存 → 全局配置落盘 → rebuild → 状态 running → /tools 出现 `mcp__<server>__read_file` 等。

### R-MCP-09 服务键权限

- **需求背景与动机**：MCP 工具需要批量授权（整组放行）与细化（只放行某几个），且匹配必须与 LLM 可见名解耦（哈希标签不可读）。服务键还要与内建工具键的键空间正交，避免歧义。
- **功能规格**：
  - 输入与前置：
    1. 权限桶键支持 `mcp:<服务名>`（**必须带前缀**——裸服务名键在 config 加载期被 superRefine 拒绝：前缀化立法下裸键会静默失配，加载期直接报错并指明写法）。
  - 处理规则：
    2. 规则语义与 v3 一致：`whole: true` 整组生效——该服务下所有工具，服务升级新增工具自动覆盖；`whole: false` 时 patterns 与**服务内部工具名**做平文本精确/通配匹配（matchWildcard，如 `browser_close`、`browser_*`）——这是「哪些工具被本规则覆盖」的**启用匹配，永不涉及工具执行参数**（MCP 参数 schema 服务自定义，无主参数概念）。
    3. 匹配按注册期身份：引擎取 `identities.get(标签)`，`kind === 'mcp'` 才走服务键分支，查 `bucket['mcp:<id.server>']`。
    4. 服务名零字符约束：前缀 `mcp:` 隔离保证与内建工具名（不含冒号）、其它服务名（含 `__`、中文、空格、与内建同名）均无歧义。
    5. 服务离线时规则保留（纯配置匹配，不依赖运行状态），重连自动生效。
    6. 服务删除后规则成为孤儿（UI 可见可清理，不自动删除）；项目级服务键授权随 `.dogegg/` 进 git 与仓库共享。
  - 输出与用户可见表现：
    7. WebUI Permissions 区对服务键提供勾选式细化（见 R-MCP-07 消费方三），TUI /config 同键可编辑；两端写回的都是同一 v3 规则形态（whole + patterns）。
- **边界与失败模式**：
  - 跨桶优先级不受服务键影响——「allow 整组 + ask 勾选个别」可行，反向被桶优先级压制（见 R-PRM-07）。
  - 身份快照由 agent 在 classify 时现取（提供者函数而非静态快照）——MCP 启停后匹配永远基于最新注册表。
- **验收标准**：
  1. 当 `mcp:playwright` 配 whole=true，则该服务全部工具（含重启后新增的）按本桶处理。
  2. 当 patterns 为 `browser_*`，则内部名 `browser_navigate` 命中而 `page_pdf` 不命中。
  3. 当配置里写裸键 `playwright` 且 mcpServers 存在同名服务，则加载报错并指明应写 `mcp:playwright`。
  4. 当服务离线，则其规则仍参与判定（不因连接状态失效）。
- **场景走查**：用户在 WebUI Permissions 区对 `mcp:playwright` 勾选 `browser_navigate` 与 `browser_*` → 保存后模型调 `mcp__playwright__browser_navigate` → 引擎按身份命中 → allow；调 `browser_pdf`（未勾选）→ 未命中 → 默认 ask。

### R-MCP-10 调用

- **需求背景与动机**：调用回路是 MCP 集成的最后一环——模型给出的标签要路由回正确的服务与正确的内部名，失败要有界（超时）且可恢复（不终止对话），否则一个慢服务能挂死整轮。
- **功能规格**：
  - 触发条件与输入：
    1. 模型按 LLM 可见标签调用（常规名或哈希标签）→ zod 宽松校验 → 权限网关（服务键判定 + 固定安全默认：三桶无规则时第三方工具默认 ask）。
  - 处理规则：
    2. 适配器经归属的 client `callTool({ name: tool.name /* 服务侧原始工具名 */, arguments })`，传 `{ signal: ctx.signal, timeout: 60_000 }`——单次调用 60s 超时，且轮次取消会中断调用。
    3. 结果处理：content 数组逐块取 text（非 text 块 JSON 序列化）以换行拼接；`result.isError` → `{ error: text || 'MCP 工具 X 执行失败' }`；异常（超时/连接断开）→ `{ error: 'MCP 调用失败：<原因>' }`。
    4. 回填走统一的 runAndEmit 通道：emit tool_start → execute → 结果文本经 truncate 截断 → emit tool_end（带 error 标记）——超长输出不会撑爆 context，UI 渲染与内建工具同构；ctx.signal 来自轮次的取消控制器。
  - 输出与用户可见表现：
    4. 所有失败形态都作为 tool 消息回填模型——模型可换路或向用户说明，对话不终止。
- **边界与失败模式**：
  - 服务离线（client 为空）→ `{ error: 'MCP server X 未运行' }`。
  - 调用期间 server 被停用 → rt.client 置空 → 下一次调用报「未运行」。
  - 60s 超时是 SDK 层 Promise 超时——服务慢但最终返回也按超时算（有界等待优先于无限等待）。
  - 取消传播：ctx.signal abort → SDK 中断 → catch 回填。
- **验收标准**：
  1. 当模型调用某 MCP 工具并获服务正常返回，则回填文本与 content 逐块拼接结果一致。
  2. 当服务返回 isError，则回填 `{ error }` 且错误文本取自服务返回（无文本时用兜底文案）。
  3. 当服务 60s 内未响应，则调用以「MCP 调用失败：…」回填，轮次继续而非挂死。
  4. 当调用期间用户取消轮次，则调用被中断并回填，无悬空 Promise。
  5. 当服务返回超长文本，则回填内容被截断到统一上限（与内建工具一致）。
- **场景走查**：模型调 `mcp__playwright__browser_navigate { url: 'https://example.com' }` → ask 审批放行 → 适配器向服务发 `{ name: 'browser_navigate', arguments: { url: … } }` → 服务返回截图描述文本 → 回填模型继续推理；服务宕机时同调用回填「MCP 调用失败：…」，模型改用 read_file 方案。

## 边界与立法

- 服务名无字符集约束是立法（`mcp:` 前缀隔离保证无歧义；schema 仅要求非空）；唯一拒绝场景：裸服务名键与 mcpServers 服务同名（加载期拒绝，见 05-权限与安全 R-PRM-03 的交叉校验）。
- 工具数量上限、服务级元工具聚合（把 N 个工具折叠成 1 个）均为**非目标**——原生 JSON Schema 透传优先。
- 项目级 server 定义于 `.dogegg/.mcp.json`，随仓库共享（注意：.gitignore 现状忽略 `.dogegg/`，共享需自行调整 ignore，属部署侧决策）。
