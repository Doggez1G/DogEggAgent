# Skills 与 MCP 能力设计（M4.1 / M4.2）

> 状态：已实施（2026-09-18）
> 日期：2026-09-18
> 前置：M1~M2.5 全部落地（feat/v0.2.0 @ 3392b04，357 测试）。

## 1. Skills（M4.1）——自有目录体系，格式对齐 Agent Skills 规范

### 1.1 目录与格式立法

- 只扫两处：**用户级** `~/.dogegg/skills/<name>/SKILL.md`、**项目级** `<项目>/.dogegg/skills/<name>/SKILL.md`；
- SKILL.md 格式对齐 Anthropic Agent Skills 规范：YAML frontmatter（`name`/`description`）+ 正文指令，
  可附带 `scripts/`、`references/` 资源；渐进披露——系统提示只注入 name + 一行 description + 路径，
  模型判断相关时用 read_file 读 SKILL.md 全文；
- **skill 名 = 目录名**（唯一事实源，frontmatter.name 仅文档性）；目录名立法 `[a-z0-9-]`（防路径穿越）；
- 同名冲突：项目级覆盖用户级（调用与命令联想取项目级），面板两组都可见并标注。

### 1.2 触发双通道

1. **显式**：`/<skill-name> [args]`——正文 `$ARGUMENTS` 占位替换（无占位且带参时追加大于说明），
   作为用户消息进轮次；进命令联想 / Cmd+K 面板 / /help；
2. **模型自取**：系统提示追加「可用 Skills」清单段（无 skill 时不注入）。

### 1.3 管理（/skills 面板，增删改查）

- 契约：`skills_request`（拉取）、`skills_manage { action: create|update|delete|get, scope, name, description?, content? }`、
  下行 `skills_list { skills: [{ name, description, scope, path }] }` 与 `skill_content { scope, name, content }`；
- **增**：选级（项目/用户）→ name → description → agent 生成骨架 SKILL.md（含 $ARGUMENTS 示例）即生效；
- **删**：确认后删除整个 skill 目录（含资源）；
- **改**：TUI = `$EDITOR` 打开 SKILL.md（spawnSync + raw mode 暂停/恢复 + 清屏重挂载 + 重拉）；
  WebUI = 编辑弹框全文保存（先经 `get` 取 content）；
- **查**：列表分项目/用户两组；Enter 经 `get` → info 面板预览全文。

### 1.4 系统集成

- 组装器：`ContextAssembler` 增可选 `extra` 段回调——Agent 注入 skills 清单段（无 skill 时不注入）；
- 权限豁免：read_file 落 ask 且目标在用户级 skills 目录内 → 自动 allow（agent 管理的资产；
  项目级在 cwd 下，读类默认放行已覆盖）。PermissionManager 构造增 `builtinReadDirs`；
- `set_cwd` 后项目级目录变化 → 重扫 + 广播。

## 2. MCP（M4.2）——对齐主流协议与配置惯例

### 2.1 配置源

- **全局**：`~/.dogegg/config.json` 新增 `mcpServers` 字段（configSchema 校验，进 /config 与设置页）；
- **项目**：`<项目>/.dogegg/.mcp.json`（`{ mcpServers: [...] }`，团队可提交）；同名 server 项目覆盖全局；
- 条目形态（数组、显式 name）：`{ name, enabled?, transport: { type: 'stdio', command, args?, env? } | { type: 'http', url, headers? } }`。

### 2.2 运行时（官方 SDK）

- 传输 v1：stdio（`StdioClientTransport`）+ Streamable HTTP（`StreamableHTTPClientTransport`）；官方
  `@modelcontextprotocol/sdk` 保证与真实 server 的握手/能力协商/取消兼容——协议细节学习不挡主线；
- 工具命名 `mcp__<server>__<tool>` 进注册表：注册表增 `unregister`；适配器 schema 用宽松
  `z.record(z.unknown())`（参数透传 server 强校验），`parameters` 直接用 MCP 的 JSON Schema；
- 权限：默认 ask（第三方不可信）；桶 key 通配 `mcp__fs__*` 天然可用（toolEntryMatches 已支持）；
- 输出：text 块拼接，超长走既有输出治理；调用超时默认 60s，signal 贯穿取消；
- 生命周期：`rebuild(merged)` diff 增删启停；崩溃/连接失败 → status=error + notice，下次 rebuild 重试；
  配置变更（config_updated / set_cwd / manage）→ rebuild → `tools_list` + `mcp_list` 重播。

### 2.3 管理（/mcp 面板，增删改查 + 状态）

- 契约：`mcp_request`、`mcp_manage { action: save|delete|toggle, scope: global|project, server?, name?, enabled? }`、
  下行 `mcp_list { servers: [{ name, enabled, type, status: running|starting|error|stopped, error?, tools }] }`；
- 全局写入走 ConfigEditor 新方法 `setMcpServers`（复用校验/落盘/广播链路）；项目写入 `.mcp.json`；
- 面板：列表（状态徽章 + 工具数）、增（类型 → 表单 → 写入位置）、改（保存即重启该 server）、
  删、启用/停用开关（enabled 只停不删）。

## 3. /config 统一入口

- TUI：配置树 root 增 `skills` / `mcpServers` action 节点（TreeCtx 增 openSkills/openMcp）→ 打开与
  `/skills`、`/mcp` 相同的面板（一套逻辑两个入口）；
- WebUI：设置页新增 Skills / MCP Servers 两个 section；`/skills`、`/mcp` 命令与 Cmd+K → 打开设置
  弹框并聚焦对应 section（SettingsModal 增 initialSection）。

## 4. 测试策略

| 范围 | 方式 |
|---|---|
| skills 解析/CRUD | tmp 目录单测：frontmatter 解析、骨架生成、目录名立法、项目覆盖用户 |
| invoke_skill | 黑盒：伪 client 断言用户消息 = 正文（$ARGUMENTS 已替换）|
| 权限豁免 | 用户级 skills 目录 read_file → allow |
| MCP | 进程内假 stdio server（SDK Server 类）→ Agent e2e：工具注册进注册表、tools_list 含 mcp 工具、调用返回 |
| 回归 | 全量测试不回退 |

## 5. 批次

| 批次 | 内容 |
|---|---|
| S1 | Skills 后端（模块 + 契约 + 系统提示 + 权限豁免）+ 单测 |
| S2 | Skills 前端（TUI 面板 + $EDITOR + 命令接入；WebUI section + 聚焦） |
| S3 | MCP 后端（config + .mcp.json + 管理器 + 动态注册）+ 假 server e2e |
| S4 | MCP 前端（TUI 面板 + WebUI section + /config 入口） |
| S5 | 文档同步 + 全量验证 |

## 5.5 实施评审修订（同日）

- **mcp_list 载荷携带 transport 明细**——面板「改」的数据源（编辑预填、名称与落点锁定；
  冗余的 type 字段移除，以 transport.type 为准）；
- **rebuild 串行化**（门面 promise 链）——触发源多，防交错重入导致的双进程/孤儿连接；
- **stopOne 同步化**——状态变更同步落、连接关闭后台执行（1s 竞速上限）：stdio 子进程退出
  时序偶发让 client.close() 不返回，同步 await 会卡死整条重建链（测试实证）；
- **skills 清单缓存**——系统提示段/token 估算是热路径，list() 加缓存；管理操作、setProjectDir、
  门面 emitSkillsList（skills_request 响应）失效——外部手改文件仍可见；
- **notice 增 channel 字段**——manage 失败的 notice 带 skills/mcp 定位，设置弹框内联显示
  （不再只落聊天区）。
