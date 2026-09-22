# 11：Skills 与 MCP（扩展能力的两大支柱）

> ⚠️ **存档**：本章为 v0.1 时代内容，部分已过时。当前版本学习指南见 [docs/versions/0.2/04-学习指南](../versions/0.2/04-学习指南/README.md)。

> 对应 spec：`docs/superpowers/specs/2026-09-18-skills-mcp-design.md`（含立法与测试策略）。

## 11.1 Skills——自有目录体系 + Agent Skills 格式

- **目录立法**：用户级 `~/.dogegg/skills/`、项目级 `<项目>/.dogegg/skills/`；SKILL.md 格式对齐
  Anthropic Agent Skills 规范（frontmatter name/description + 正文 + 可选 scripts/ 资源）；
- **名字 = 目录名**（唯一事实源，frontmatter.name 仅文档性）；目录名 `[a-z0-9-]`（防路径穿越 +
  命令名合法性）；同名项目覆盖用户（调用取项目级，面板两组都可见）；
- **渐进披露**：系统提示只注入 name + description + 路径（`ContextAssembler` 的 extra 段回调现算追加，
  无 skill 不注入）；模型判断相关时用 read_file 读 SKILL.md 全文——上下文成本最低；
- **双通道触发**：`/<skill-name> [args]`（正文 $ARGUMENTS 替换，无占位则追加参数段）+ 模型自取；
- **CRUD**（/skills 面板 + /config 树入口）：create 生成骨架（name+description 两步 prompt）→
  update 全文替换（TUI 走 $EDITOR：raw mode 暂停 → spawnSync → 恢复 + 清屏重挂 + 重拉）→
  delete 删目录（确认菜单，幂等）→ get 回 skill_content（详情/编辑弹框）；
- **权限豁免**：用户级 skills 目录在 PermissionManager 的 builtinReadDirs 内——read_file 落 ask
  时豁免为 allow（agent 管理的资产；项目级在 cwd 下被默认读放行覆盖）；
- **保留字**：内置命令名优先，同名 skill 不可覆盖（parseCommand 先查内置表）。

## 11.2 MCP——官方 SDK + 主流配置惯例

- **配置源**：全局 `~/.dogegg/config.json` 的 `mcpServers` 字段（configSchema 校验，进 /config 与
  设置页）；项目级 `.dogegg/.mcp.json`（团队可提交）；同名 server 项目覆盖全局（scope 随合并条目下发）；
- **条目**：`{ name, enabled?, transport: stdio{command,args,env} | http{url,headers} }`——
  enabled=false 只停用不删除；
- **运行时**（`agent/src/mcp/manager.ts`）：官方 `@modelcontextprotocol/sdk` Client；rebuild(diff) 增删
  启停；状态机 running/starting/error/stopped（错误信息面板可见，下次 rebuild 重试）；
- **工具接入**：`mcp__<server>__<tool>` 命名空间；注册表 unregister + 适配器（zod 仅对象级宽松校验，
  parameters 用 server 的原生 JSON Schema 透传）；权限默认 ask、桶 key 通配 `mcp__fs__*`；
  调用超时 60s + signal 贯穿取消；输出 text 块拼接；
- **生效链路**：manage/config_updated/set_cwd → rebuild(diff) → 变化才广播 mcp_list + tools_list
  （两端选择器自动跟上）。

## 11.3 与既有系统的咬合

- /config 树 root 增 skills / mcpServers 两个 action 节点（TreeCtx.openSkills/openMcp）——
  与 /skills、/mcp 面板同一套逻辑，统一入口不漂移；
- WebUI：/skills、/mcp 命令 → 设置弹框聚焦对应 section（Settings initialSection）；命令面板
  增 Skills 组（invoke_skill 直调）；
- 弹层语义沿袭立法：request 响应开面板、推送只刷新已开面板（TUI 面板壳 + 响应填充）；
- 架构矩阵：skills（无内部依赖）、mcp（→tools）作为新能力域加入 ALLOWED 矩阵。

## 11.4 已知边界

- skills 的 scripts/ 附属脚本经 shell 工具执行——权限系统自然审批，但 skill 本身不做沙箱；
- MCP v1 只做 tools；prompts（并入命令源）、resources、sampling/elicitation 后置；
- TUI 不做终端内大文本编辑——skills「改」走 $EDITOR，WebUI 走编辑弹框。
