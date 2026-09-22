# 07 - MCP 客户端

> 职责：管理全部 MCP（Model Context Protocol）服务的连接生命周期——把配置里的 server 声明收敛到运行中的 Client 实例、把服务的工具适配进注册表、把状态广播给 UI。`agent/src/mcp/manager.ts` 是官方 SDK Client 之上的一层薄封装；`agent/src/mcp/project.ts` 负责项目级配置与合并。
>
> **交互图**：[MCP 生命周期](./assets/mcp-lifecycle.html)（rebuild diff → startOne/stopOne → syncRegistry → 调用回路）。

## 1. 职责与边界

| 文件 | 职责 |
|---|---|
| `agent/src/mcp/manager.ts` | McpManager：rebuild diff、startOne/stopOne、syncRegistry、工具适配器、状态广播 |
| `agent/src/mcp/project.ts` | .dogegg/.mcp.json 读写（容错）+ mergeMcpServers 合并立法 |
| `agent/src/agent.ts` | rebuildMcp 串行链（mcpRebuildChain）+ handleMcpManage CRUD 分层 |
| `bridge/src/contract/config.ts` | mcpServerSchema / mcpTransportSchema（stdio/http 判别联合，config.ts:25-42） |
| `agent/src/tools/registry.ts` | 注册关口（身份登记、合规哈希、冲突抛错） |

立法总纲（manager.ts:13-19 注释）：工具名 `mcp__<server>__<tool>`（LLM 可见命名空间标签，不合规由注册关口整体哈希）；注册必带身份 `{ kind: 'mcp', server, name }`（权限服务键按身份匹配，与标签字面无关）；参数不本地强校验（zod 仅"对象"级宽松校验，真实校验权在 server——原生 JSON Schema 透传给 LLM）；第三方工具默认走权限 ask（三桶无规则时的固定安全默认）；生命周期全部异步不阻塞消息循环。

## 2. 核心数据结构

```ts
// manager.ts:21-30
export type McpStatus = 'running' | 'starting' | 'error' | 'stopped'
interface McpServerRuntime {
  config: McpServerConfig          // { name, enabled, transport: stdio|http 判别联合 }
  scope: 'global' | 'project'      // 条目来自哪一层（写回哪一层的依据）
  status: McpStatus
  error?: string
  client?: Client                  // 官方 SDK Client（stopped/error 时为 undefined）
  tools: { name, description, inputSchema }[]  // tools/list 的原文
}
```

配置来源两层（bridge config.ts:22-24 + project.ts:5-6）：全局放 config.json 的 `mcpServers`，项目级放 `<cwd>/.dogegg/.mcp.json`（同 schema）；`enabled=false` 只停用不删除（调试时保留配置）。`McpMergedEntry { server, scope }`（project.ts:31-34）是 rebuild 的输入单元。

## 3. 关键流程走查

### 3.1 合并立法（project.ts:38-43）

`mergeMcpServers(global, project)`：全局条目中被项目同名覆盖的剔除，其余在前；项目条目全量在后（:39-42）。**scope 随条目下发**——manager 状态与 /mcp 面板的启停/删除需要知道写回哪一层（:37 注释）。项目文件读取容错三连（project.ts:15-24）：文件缺失 / JSON 损坏 / 条目校验失败 → 空数组（**项目配置错误不拖垮全局**，:7 注释）。写入时 `mkdirSync(recursive)` 建目录、格式化两空格 + 尾换行（:26-29）。

### 3.2 rebuild diff 算法（manager.ts:51-77）

`rebuild(desired)` 期望状态 → diff 停启，幂等收敛（多次调用收敛到 desired，:50 注释）：

1. **停止侧**（:56-64）：遍历现有 servers，三种情况任一命中即 `stopOne(name)`——被移除（desired 找不到）、停用（`!next.server.enabled`）、**传输配置变化**（`JSON.stringify(transport)` 不相等——结构化比较 stdio/http 判别联合的最简手段）。被移除的顺带 `servers.delete`；仍在的保留壳体并更新 config/scope，让 listStatus 反映最新配置（:61）；
2. **启动侧**（:66-72）：遍历 desired 中 enabled 的条目——已 running 且传输未变的跳过（幂等核心，:69）；其余 `await startOne(entry)`（串行 await，避免并发 connect 交错）；
3. **清理**（:74）：被移除后残留的空壳从 map 删除；
4. `changed` 为真 → `broadcast()`（:76）。无变化时幂等空转、不广播（agent.ts:339 注释）。

### 3.3 触发源与串行链（agent.ts:200-209）

rebuild 的触发源多：启动（agent.ts:115）、config_updated（onConfigChanged，agent.ts:340）、set_cwd（agent.ts:503）、/mcp 面板 manage（agent.ts:258）。门面用 **promise 链串行化**（agent.ts:203-209）：

```ts
private mcpRebuildChain: Promise<void> = Promise.resolve()
private rebuildMcp(): Promise<void> {
  this.mcpRebuildChain = this.mcpRebuildChain
    .then(() => this.mcp.rebuild(this.mergeMcp()))
    .catch(() => { /* 重建失败不中断后续重建——状态在 mcp_list 可见 */ })
  return this.mcpRebuildChain
}
```

不串行化的后果（agent.ts:202 注释）：交错重入会让同一 server 被起两个进程、旧 client 变孤儿泄漏。merge 在**执行时刻**取值（链上每个 rebuild 调 `this.mergeMcp()`）——总是最新配置，排队中的重复请求自动收敛。

### 3.3 一次 rebuild diff 的具体走查

假设现有运行中：`{fs: stdio(node fs.js) global}`、`{web: http(url-a) global}`；desired 合并结果：`{fs: stdio(node fs.js) global}`（未变）、`{web: http(url-b) global}`（URL 改了）、`{db: stdio(node db.js) project}`（新增，enabled）、`{old: …}` 已从配置删除：

1. 停止侧：fs 比对通过（同名 + enabled + transport JSON 相等）→ 不动；web 的 transport JSON 不等 → `stopOne('web')`（状态 stopped、摘除 mcp__web__* 工具、后台 1s 竞速 close）+ 更新壳体 config；old 在 desired 中找不到 → stopOne + 从 map 删除；
2. 启动侧：db enabled 且无 existing → `await startOne`（starting 广播 → connect → listTools → running 广播）；fs 已 running 且 transport 相等 → 跳过；web 刚被 stopOne（status=stopped）→ 重新 startOne（连接 url-b）；
3. 清理：无残留（old 已在第 1 步删除）；
4. changed=true → broadcast：mcp_list 反映 fs=running / web=running（新 URL）/ db=running / old 消失；tools_list 的 MCP 组相应增删。

`mcp_list` 单条载荷字段（manager.ts:32-41 → 契约 agent-to-ui.ts:43）：`name / enabled / scope / transport（明细——编辑预填）/ type / status / error? / tools[{name, description}]`——配置与运行时状态**一个快照发全**，面板不需要第二次查询。

### 3.4 startOne——两种 transport（manager.ts:80-102）

1. 先落壳体 `status='starting'` 并立即 broadcast（:82-84）——UI 马上看到 starting 态；
2. new SDK `Client({ name: 'dogegg-agent', version: '0.2.0' })`（:86）；
3. transport 按判别联合二选一（:87-89）：`stdio` → `StdioClientTransport({ command, args, env })`（本地子进程；env 语义：undefined → 继承父进程环境，显式对象 → 仅提供指定变量，:197-200）；`http` → `StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })`（远程 Streamable HTTP）；
4. `await client.connect(transport)` → `await client.listTools()`（:90-91）——工具清单含原生 `inputSchema`；
5. 成功：`rt.status='running'`、清 error、缓存 tools（:92-95）；**任何失败：`status='error'` + 人话 error + 清 client/tools，不抛出**（:96-101）——失败在面板可见而非炸消息循环。

### 3.5 stopOne——同步状态 + 后台关（manager.ts:107-121）

状态变更**必须同步完成**（摘工具、`status='stopped'`、清 tools，:110-114）——广播/面板即时可见；连接关闭是**后台事务**：`Promise.race([client.close().catch(...), sleep(1000)])`（:116-119）。1s 竞速的原因（:105-106 立法注释）：stdio 子进程退出时序偶发让 close 不返回，同步 await 会卡死 rebuild 与其后的整个串行链。竞速失败（1s 后 close 还没回）也不影响正确性——close 最终完成或进程随父退出，无资源语义依赖。

### 3.6 syncRegistry——身份注册与按服务隔离（manager.ts:126-149）

1. **先摘后挂**：先对**所有**服务 `unregisterServerTools`（:127）——server 工具清单可能变化，全量重建避免残留；
2. 逐服务（仅 running 态）逐工具 `registry.register(makeAdapter(...), { kind: 'mcp', server: serverName, name: t.name })`（:132）——身份携带服务裸名 + 内部原名，是权限服务键与 UI 分组的唯一事实源；
3. **按服务隔离**（:134-139）：单服务注册失败（合规关口的命名冲突等）→ 该服务 `status='error'` + 清 tools + `unregisterServerTools(serverName)` 清掉**半挂状态**（冲突前已注册的本服务工具一并摘除）——其余服务照常挂载（:125 注释）；
4. **摘除按身份**（:145-149）：`labelsWhere((id) => id.kind === 'mcp' && id.server === serverName)` 找本服务全部标签再逐个 unregister——**绝不按前缀扫描**：哈希标签不带 `mcp__` 前缀，前缀扫描会漏删（:144 注释）。

### 3.7 广播（manager.ts:190-194）

`broadcast()` = `syncRegistry()` + emit `mcp_list`（listStatus 快照，transport 明细随行供面板编辑预填，:181）+ emit `tools_list`（注册表快照，身份随行）。startOne 的 starting、成功/失败、rebuild 的停止——所有状态变化都经它，UI 的 /mcp 面板与 /tools 视图永远反映当前事实。

### 3.8 调用回路（makeAdapter，manager.ts:152-173）

适配器核心（节选）：

```ts
execute: async (args, ctx) => {
  const client = rt.client
  if (!client) return { error: `MCP server ${serverName} 未运行` }
  const result = await client.callTool(
    { name: tool.name, arguments: (args ?? {}) },
    undefined,
    { signal: ctx.signal, timeout: CALL_TIMEOUT_MS })  // 60s
```

1. 适配器名 = `mcp__${serverName}__${tool.name}`（:153）——LLM 可见命名空间标签；不合规（如服务名含中文）由注册关口哈希为 `h-<hex>`（《04》§2.1）；
2. schema = `z.record(z.string(), z.unknown())` 宽松透传（:157）；parameters = server 的原生 inputSchema（:158）——不本地重复建模校验权；
3. `execute`：`rt.client` 已被停掉 → `{ error: 'MCP server X 未运行' }`（:160-161）；否则 `client.callTool({ name: tool.name, arguments }, undefined, { signal: ctx.signal, timeout: 60_000 })`（:163）——**发的是内部原名**（不是标签），60s 超时（CALL_TIMEOUT_MS，:43）且接轮次 AbortSignal（取消传播到 MCP 调用）；
4. 结果拼装（:164-167）：content 数组逐块取 text（非 text 块 JSON.stringify），join 换行；`result.isError` → `{ error: text }` 回给模型；异常 → `{ error: 'MCP 调用失败：...' }`——全部走 ToolResult 错误约定，不抛出。

结果拼装对多模态块的兜底立法：非 text 块（image/resource 等 v1 不支持的类型）被 `JSON.stringify` 成文本回填——信息不静默丢失，模型至少知道"这里有个非文本块"。

### 3.9 /mcp 面板 CRUD 的归属分层（agent.ts:217-260）

- **global**：走 `configController.replaceMcpServers(next)`（agent.ts:225）——复用配置编辑器的校验/落盘/config_updated 广播链路，config_updated 钩子触发 rebuild；save = 同名替换或追加（:221-226）；delete = 过滤后写回（:228-231）；toggle = 翻转 enabled（:233-239）；
- **project**：直写 `.dogegg/.mcp.json`（readProjectMcp/writeProjectMcp，:244-256）后显式触发 rebuild + emitMcpList（:258-259）——不走 ConfigEditor（项目文件不是 config.json 的一部分）。

## 4. 关键立法与不变量

- **INV-1 幂等收敛**：rebuild(desired) 多次调用结果一致；无变化不广播。
- **INV-2 状态同步、连接异步**：stopOne 的状态落定是同步的（UI 即时可见），close 是带 1s 上限的后台事务。
- **INV-3 身份归属**：注册必带 `{kind:'mcp', server, name}`；摘除按身份谓词，永不前缀扫描。
- **INV-4 校验权在 server**：适配器不本地强校验参数，inputSchema 原样给 LLM。
- **INV-5 失败可见不炸链**：startOne/注册冲突落 error 态；rebuild 链的单次失败被吞（状态面板可见），后续重建不受阻。
- **INV-6 默认 ask**：MCP 工具三桶无规则时固定走权限 ask（安全默认零配置成立）。

## 5. 失败模式与恢复

| 失败 | 行为 | 恢复 |
|---|---|---|
| stdio 程序不存在/启动失败 | startOne catch → status=error + error 文本 | 面板看原因，修配置后 /mcp save 触发重启 |
| connect/listTools 网络失败 | 同上（不抛出、不重试） | /mcp toggle 或 save 重触发 rebuild |
| 工具注册冲突（服务名/工具名撞车） | 该服务整体 error + 半挂工具清理（:138），其余服务照常 | 改服务名或停用冲突方 |
| 调用时服务已停 | 适配器返回"未运行"错误回模型 | 模型改换路径或用户重启服务 |
| callTool 超时/异常 | 60s 超时 / catch → error 回填 | 模型可见，工具不挂死轮次 |
| close 挂起 | 1s 竞速放弃等待（:116-119） | 无泄漏语义依赖 |
| 项目 .mcp.json 损坏 | 读取容错为空数组（project.ts:21-23） | 修文件或经 /mcp 面板重写 |
| 并发 rebuild 交错 | mcpRebuildChain 串行化（agent.ts:203-209） | 排队收敛到最新 desired |

## 6. 与其它子系统的接缝

- **→ 04 注册表**：register/unregister/labelsWhere 是全部挂载与摘除通道；身份立法见《04》§4。
- **→ 06 权限**：服务键 `mcp:<server>` 按身份匹配；第三方工具默认 ask。
- **→ 02 轮次**：适配器 execute 接收轮次的 cwd/signal；工具错误走统一 ToolResult 约定。
- **→ 10 配置**：global CRUD 复用 ConfigEditor 校验回滚链；config_updated 联动 rebuild。
- **→ 11/12 前端**：mcp_list + tools_list 双广播支撑 /mcp 面板（TUI features/mcp、WebUI settings/mcp）；notice channel='mcp' 定位面板内联错误。
- **→ 09 会话**：set_cwd/new_session 改变 cwd → 项目级合并结果变化 → rebuild（agent.ts:503）。
