# Skills 与 MCP 实施计划

> 日期：2026-09-18
> 规格：`docs/superpowers/specs/2026-09-18-skills-mcp-design.md`。
> 每批次末尾 `npm run typecheck && npm run test:run` 全绿才进入下一批次。

## 批次 S1：Skills 后端

1. bridge 契约：`skills_list` / `skill_content`（下行）、`skills_request` / `skills_manage` / `invoke_skill`（上行，zod 同步）；
2. `agent/src/skills/`（parser + manager）：目录扫描（用户/项目，项目覆盖）、frontmatter 最小解析、
   骨架生成、CRUD（目录名立法 + 路径安全）、`forInvocation`（$ARGUMENTS 替换）；
3. 门面接线：skills_request / skills_manage / invoke_skill 三命令；set_cwd 重扫广播；
4. `ContextAssembler` 增 extra 段回调 → 系统提示注入 skills 清单；
5. `PermissionManager` 增 builtinReadDirs → 用户级 skills 目录 read_file 豁免；
6. 测试：parser/manager 单测（tmp 目录）、invoke_skill 黑盒、权限豁免、系统提示注入。

## 批次 S2：Skills 前端

1. 契约镜像：两端 skills_list 状态 + parseCommand/matchCommands 接受动态 skill 命令；
2. TUI：view 增 `skills` 面板（分组列表/详情/删除确认/两步创建）、`$EDITOR` 接入（raw mode 暂停恢复）；
3. TUI /config 树 root 增 skills action 节点（TreeCtx.openSkills）；
4. WebUI：设置页 Skills section（列表/创建表单/编辑弹框/删除确认）、/skills 聚焦、命令面板收录。

## 批次 S3：MCP 后端

1. configSchema 增 `mcpServers`（数组，name/enabled/transport 判别联合）+ 默认 [];
2. `.dogegg/.mcp.json` 项目级读写 + 全局/项目合并（同名项目优先）；
3. `agent/src/mcp/`：manager（rebuild diff / SDK Client / stdio+http 传输 / 状态机）、工具适配器
   （mcp__<server>__<tool>，宽松 zod + 原生 JSON Schema 透传）；ToolRegistry.unregister；
4. 门面：mcp_request / mcp_manage（global 走 ConfigEditor.setMcpServers；project 直写 .mcp.json）、
   config_updated / set_cwd 后 rebuild、tools_list + mcp_list 重播；
5. 测试：进程内假 stdio server（SDK Server 类）→ e2e 注册/调用；config 合并单测。

## 批次 S4：MCP 前端

1. TUI：view 增 `mcp` 面板（状态列表/增删改启停）、/config 树 mcp 节点（TreeCtx.openMcp）；
2. WebUI：设置页 MCP Servers section（状态列表/表单/启停/删除）、/mcp 聚焦。

## 批次 S5：文档与收尾

1. spec 状态更新、learning 文档补章、CLAUDE.md 索引、/help 命令清单；
2. 全量验证（typecheck + 全部测试 + build×2）。
