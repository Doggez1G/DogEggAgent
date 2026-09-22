# 07-MCP客户端

`agent/src/mcp/manager.ts` 的 `McpManager` 管理全部 MCP 服务的连接生命周期：官方 SDK Client 之上的薄封装，做 diff 重建与状态广播。

## 生命周期

```
配置变化 → rebuild(desired)：
  停止：被移除 / 停用 / 传输配置变化的现有连接（stopOne）
  启动：新增 / 未运行 的连接（startOne：SDK Client + Stdio/StreamableHTTP transport → connect → listTools）
  状态：starting → running / error（原因人话可见）
  广播：mcp_list（配置+状态）+ tools_list（注册表快照，身份随行）
```

- 全部异步，不阻塞消息循环；`stopOne` 状态同步落、连接关闭后台执行（1s 竞速上限——stdio 子进程退出时序偶发让 close 不返回，同步 await 会卡死重建链）。
- 重建由 `mcpRebuildChain` 串行化（promise 链）——并发 rebuild 请求排队收敛。

## 工具注册（经注册表关口）

- `syncRegistry`：先按身份摘除本服务旧工具，再把服务的工具逐个注册——注册携带身份 `{ kind: 'mcp', server, name }`（权限服务键与 UI 分组的事实源）。
- **按服务隔离**：单服务注册冲突（合规关口抛错）→ 该服务落 error 可见、清理半挂工具，其余服务照常。
- 摘除按身份（labelsWhere）而非前缀字符串扫描——哈希标签不带 `mcp__` 前缀，前缀扫描会漏删。

## 调用回路

模型按标签调用 → 适配器查 `rt.client` → `callTool({ name: 内部原名 })` 发给服务（60s 超时）→ 结果文本块拼接回填；服务离线/未注册 → 错误结果回模型。

## 广播

状态变化即广播 mcp_list + tools_list（`listTools()` 携带身份）——面板/设置/权限细化的数据源，`/cd` 与配置变化都走同一刷新路径。
