# R-MCP 工具系统-MCP

接入 MCP（Model Context Protocol）服务器，把外部工具纳入统一的工具/权限/展示体系。

## 需求点

- **R-MCP-01 配置与作用域**：server 配置放全局 `~/.dogegg/config.json` 的 `mcpServers` 字段，或项目 `.dogegg/.mcp.json`（同名项目覆盖全局）；`enabled` 停用不删除。
- **R-MCP-02 传输类型**：`stdio`（本地子进程：command + args + env）与 `http`（Streamable HTTP：url + headers）。
- **R-MCP-03 生命周期**：连接状态机 `starting → running / error`，停用/删除 → `stopped`；配置变化走 diff 重建（无变化幂等空转），状态经 mcp_list 实时广播。
- **R-MCP-04 工具注册**：服务的每个工具独立注册为 `mcp__<server>__<tool>`（注册关口统一合规——不合规名整体哈希为 `h-<hash>` 标签）；原生 JSON Schema 透传给模型（参数校验权在服务）。
- **R-MCP-05 单服务隔离**：单服务启动/注册失败落 error 状态可见，不拖垮其它服务。
- **R-MCP-06 冲突可见**：注册标签与已有工具冲突 → 后注册方失败并提示，绝不静默覆盖。
- **R-MCP-07 来源身份**：每个 MCP 工具注册时记录身份 `{ server, name }`——权限服务键匹配与 UI 分组的唯一事实源，不从 LLM 可见名解析。
- **R-MCP-08 启停**：`enabled` 停用即断连摘工具（保留配置）；配置 CRUD（增删改/启停）经 /mcp 面板或 WebUI 设置。
- **R-MCP-09 服务键权限**：权限桶键支持 `mcp:<服务名>`——整组（whole）或按内部工具名勾选/通配（详见 05-权限与安全）。
- **R-MCP-10 调用**：模型按标签调用 → 适配器经归属转发给服务（发服务侧原始工具名）→ 结果回填；60s 调用超时。

## 边界与立法

- 服务名零约束（任意字符）：前缀键 `mcp:<名>` 保证与内建工具名无歧义；裸服务名键加载期拒绝。
- 项目级 server 定义于 `.dogegg/.mcp.json`（随仓库共享）。
- 工具数上限、服务级元工具聚合均为非目标（原生 JSON Schema 透传优先）。
