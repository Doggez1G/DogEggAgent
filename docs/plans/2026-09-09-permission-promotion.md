# 会话提升范围化（M1.2）实施计划

> 日期：2026-09-09
> 规格：`docs/superpowers/specs/2026-09-09-permission-promotion-design.md`。
> 每批次末尾 `npm run typecheck && npm run test:run` 全绿才进入下一批次；commit 由用户按批次自行提交。

## 基线

- M1.1 已实施（314 测试全绿）：配置 v2、锚点作用域、双匹配语义、两端编辑器。
- 现状：`sessionAllowed: Set<string>` 整工具提升；`allowedTools: string[]` 会话字段；`permissions_list { tools }`。

## 批次总览

| 批次 | 内容 |
|---|---|
| R1 | 契约四值 + derive + manager 会话规则表 + 会话存储 sessionPermissions + 表征/单测 |
| R2 | TUI 弹层四档 + /permissions 下钻撤销 |
| R3 | WebUI banner 四按钮 + 信息面板分组渲染 + 文档同步 |

---

## 批次 R1：契约 + 引擎 + 存储

- bridge `shared.ts`：`PermissionDecision` 增 `'allow_always_scoped'`；
- bridge `agent-to-ui.ts` + schema：`permission_request.alwaysScope?: { pattern }`；`permissions_list.permissions: { tool, patterns }[]`；
- bridge `ui-to-agent.ts` + schema：`permission_revoke.pattern?: string`；
- agent `permission/derive.ts`（新）：`deriveAlwaysScope(tool, input, cwd)`——shell 首词前缀/精确、path 目录级/根部精确回退；
- agent `permission/manager.ts`：`sessionRules: Map<tool, patterns>`；`apply(tool, decision, pattern?)`（整工具覆盖/范围追加去重）；会话层判定复用分派；`revoke(tool, pattern?)` 细粒度（删光即移除条目）；`snapshotPermissions()`；
- agent `turn/pending.ts` + `agent.ts`：挂起项记录 alwaysScope；`allow_always_scoped` 决议取出模式；`permissions_request/revoke` 发分组列表；
- agent `session/`：快照字段 `allowedTools` → `sessionPermissions`；resume 逐条 apply（旧 allowedTools 忽略）；
- 测试：derive 单测、manager 范围提升/撤销用例、loader 会话新字段、表征扩展（scoped 决议免审批）。

## 批次 R2：TUI

- features/permission（弹层）：`alwaysScope` 存在渲染第四档（文案含模式串），keys 与决议消息适配；
- /permissions 面板：分组列表 → 有模式 Enter 下钻逐条撤（含撤销全部行）、整工具就地撤；Esc 层级回退；
- 测试：keys/渲染相关单测适配。

## 批次 R3：WebUI + 文档

- permission-banner：第四按钮（`alwaysScope` 存在时），决议消息带第四值；
- 信息面板 Permissions 区：按工具分组渲染（展示层）；
- `shared/permission.ts` displayPerm：`allow_always_scoped` → `scoped`；
- 文档：learning/08 增范围提升小节；根设计文档 §5 会话提升段更新；README 权限句微调；
- 验证：typecheck + 全量测试 + build + build:web 全绿。

## 收尾（用户）

- 按批次 commit；dogfood 时实际体验四档弹层与 /permissions 下钻。
