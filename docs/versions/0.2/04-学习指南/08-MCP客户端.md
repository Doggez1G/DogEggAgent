# 08-MCP客户端

MCP（Model Context Protocol）让 agent 挂载外部工具。`agent/src/mcp/manager.ts` 的 `McpManager` 是官方 SDK `Client`（`@modelcontextprotocol/sdk`）之上的一层薄封装；配置来源与合并见 `agent/src/mcp/project.ts`。

## 配置与合并（mcp/project.ts）

- 全局：`config.mcpServers`（schema 见 `bridge/src/contract/config.ts` 的 `mcpServerSchema`）；项目级：`<cwd>/.dogegg/.mcp.json`（同 schema，读容错——缺失/损坏/校验失败一律空数组，项目配置错误不拖垮全局）。
- `mergeMcpServers()`：**同名项目覆盖全局**，顺序全局在前、项目新增在后，每条带 `scope: 'global' | 'project'`（面板启停/删除需要知道写回哪一层）。
- 传输判别联合 `mcpTransportSchema`：`stdio`（command/args/env，本地进程）与 `http`（url/headers，远程 Streamable HTTP）；`enabled: false` 只停用不删除。

## rebuild diff（幂等收敛）

触发源很多：Agent 构造（`agent/src/agent.ts` 第 115 行启动即拉起）、`config_updated`（onConfigChanged）、`set_cwd`（项目配置随 cwd 变）、/mcp 面板 manage。`agent.ts` 用 **`mcpRebuildChain` 串行化**（第 203 行）：`this.mcpRebuildChain = this.mcpRebuildChain.then(() => this.mcp.rebuild(...)).catch(() => {})`——链式排队防交错重入，注释写明后果：「交错会让同一 server 被起两个进程、旧 client 变孤儿泄漏」。merge 在**执行时刻**取值（`this.mergeMcp()` 现算），所以排队期间改配置也不会用旧快照。

`rebuild(desired)` 三步（一次重建的状态流）：

```text
desired: McpMergedEntry[]（mergeMcpServers 现算）
  ① 停止侧：现有 server 中 被移除 / enabled=false / transport JSON 变化 → stopOne(name)
     （同步落 stopped + 摘工具；被移除的从 map 删除，其余保留壳体带新配置）
  ② 启动侧：desired 中 enabled 且（新增 / transport 变化 / 非 running）→ await startOne()
     （starting → broadcast → connect + listTools → running / error）
  ③ changed 才 broadcast()：syncRegistry → mcp_list + tools_list
```

1. **停止侧**：遍历现有 server，被移除/停用/transport JSON 不相等的 → `stopOne(name)`；被移除的顺带从 map 删除，其余保留壳体（让 `listStatus` 反映最新配置）。
2. **启动侧**：desired 中 enabled 的——新增/transport 变化/尚未 running 的才 `startOne(entry)`；disabled 跳过（保持 stopped）。
3. **清理 + 广播**：清掉无主空壳；`changed` 才 `broadcast()`（幂等空转不广播）。

## startOne（SDK Client + 两种 transport）

`startOne()`（manager.ts 第 80 行）：先置 `status: 'starting'` 并 `broadcast()`（UI 立即可见），然后 `new Client({ name: 'dogegg-agent', version: '0.2.0' })`，按 transport 类型选 `StdioClientTransport`（env 数组语义：undefined 继承父进程）或 `StreamableHTTPClientTransport`，`client.connect()` → `client.listTools()` → 存 `rt.tools`、`status = 'running'`。**任何失败 → `status = 'error'` + error 文案，不抛出**——失败在 /mcp 面板可见，不阻塞消息循环。

## syncRegistry：按服务隔离与身份注册

`broadcast()` 内部先 `syncRegistry()` 再发 `mcp_list` + `tools_list`。`syncRegistry()`（第 126 行）：

- 先 `unregisterServerTools(name)` 摘掉所有运行中服务的旧工具（server 工具清单可能变化），再逐服务注册适配器：`registry.register(adapter, { kind: 'mcp', server: serverName, name: t.name })`——**注册必带身份**。
- **单服务隔离**：某服务注册失败（如命名冲突触发注册关口的 throw，见 07-工具系统）→ 该服务落 `status: 'error'` 并 `unregisterServerTools` 清掉半挂状态，其余服务照常挂载。
- 摘除按身份不按前缀：`labelsWhere((id) => id.kind === 'mcp' && id.server === serverName)`——哈希标签（不合规名整体哈希，见 `agent/src/tools/registry.ts`）不带 `mcp__` 前缀，前缀扫描会漏删。这是 ADR-0012「身份立法」的落地。

## 工具适配器（makeAdapter）

`mcp__<server>__<tool>` 是 LLM 可见的命名空间标签（不合规时由注册关口哈希）。与内建工具的差异：

```ts
// agent/src/mcp/manager.ts（适配器骨架，第 152 行起）
{
  name: `mcp__${serverName}__${tool.name}`,
  schema: z.record(z.string(), z.unknown()),   // 只校验「是对象」
  parameters: tool.inputSchema,                // 原生 JSON Schema 透传
  execute: async (args, ctx) => {
    const result = await client.callTool({ name: tool.name, arguments: args },
      undefined, { signal: ctx.signal, timeout: CALL_TIMEOUT_MS })
    ...
  },
} satisfies Tool
```

- **参数不本地强校验**：`schema: z.record(z.string(), z.unknown())` 只做「是对象」级宽松校验；`parameters` 直接透传 server 提供的原生 JSON Schema——真实校验权在 server。
- **执行**：`client.callTool({ name: tool.name, arguments }, undefined, { signal: ctx.signal, timeout: CALL_TIMEOUT_MS })`，`CALL_TIMEOUT_MS = 60_000`；`ctx.signal` 把 agent 的取消传导给 MCP 调用。结果把 text 块拼接；`isError` 或异常返回 `{ error }`。

## stopOne：同步状态 + 后台关连接

`stopOne()`（第 107 行）**同步**完成：置 `status: 'stopped'`、清 tools、摘除工具——广播与面板即时生效；`client.close()` 放到 `Promise.race([close, setTimeout(1000)])` 后台执行。立法：stdio 子进程退出时序偶发让 close 不返回，同步 await 会卡死 rebuild 与其后的整条串行链。

## 状态广播与权限联动

- `listStatus()` 快照带 transport 明细（面板编辑预填——用户自己的配置，无隐私边界）、status、error、工具清单。
- **服务键权限联动**：注册进来的每个工具的身份随 `identities()` 进入权限引擎（`agent.ts` 构造 PermissionManager 时传入 `() => this.registry.identities()`），`mcp:<服务名>` 桶键即刻生效（见 06-权限系统）；MCP 工具三桶无规则时的默认落点与所有工具一致——**ask**（固定安全默认）。
- 面板管理：`agent.ts` 的 `handleMcpManage()`——global 走 `configController.replaceMcpServers()`（复用校验/落盘/config_updated/rebuild 全链路），project 直写 `.mcp.json` 后显式 `rebuildMcp()` + `emitMcpList()`。

> 测试：`agent/test/mcp/mcp.test.ts` 覆盖 rebuild diff、身份注册与摘除；服务键匹配见 `agent/test/permission/mcp-server-keys.test.ts`。
