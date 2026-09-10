# 会话提升范围化设计（M1.2）：参数化 allow_always 与 /permissions 细粒度撤销

> 状态：已确认，待实施
> 日期：2026-09-09
> 前置：M1.1 权限配置 v2 已实施（锚点作用域、双匹配语义、桶内分组，见 ADR-0010）
> 背景：对 shell 点「始终允许」等于交出整个会话的执行权（会话提升压过 ask 桶规则）——提升缺少粒度。

## 1. 目标

弹层新增第四档「对此范围不再询问」：把当次调用固化为一条**会话内范围规则**（shell 取首词前缀、
path 工具取所在目录），让日常使用不必在「每次都问」与「整工具放行」之间二选一。同时 `/permissions`
的呈现与撤销按工具分组、可下钻到单条模式。shell 命令链拆分器**明确不做**（模型命令复杂度不可控，
拆对代价是无底洞）——链式命令的防线维持现状（用户自律 + reject 桶 + 默认 ask），后续另议。

## 2. 范围推导（agent 侧纯函数，UI 不推导）

推导发生在 agent（`agent/permission/derive.ts` 纯函数：tool + input + cwd → `{ pattern } | undefined`），
原则：**最窄的可复用范围，且推导不出就少一档（fail-safe）**。

| 主参数 | 推导 | 例 |
|---|---|---|
| command（shell） | 首词前缀：有后续参数 → `首词 *`；无 → 首词精确 | `git status` → `git *`；`ls` → `ls` |
| path（read/write/edit/ls/glob/grep） | 所在目录 → `./<dir>/**`；**文件在 cwd 根部时回退精确 `./<file>`**（父目录即 cwd 时若给 `./**` 等于放行全项目） | `docs/guide.md` → `./docs/**`；`guide.md` → `./guide.md` |

模式在推导时即经 resolve 解析为**绝对形式**（cwd 手里就有）——resume 换目录后规则仍指向当初批准的
目录，`/permissions` 展示真实授权范围。

## 3. 契约（扁平四值枚举；契约只带数据，措辞归各 UI）

```ts
PermissionDecision = 'allow_once' | 'allow_always' | 'allow_always_scoped' | 'reject'
//                                            对此工具不再询问  对此范围不再询问

// agent → UI：permission_request 增可选 alwaysScope（仅数据：推导出的模式；缺省 = 维持三档）
{ type: 'permission_request', id, tool, input, alwaysScope?: { pattern: string } }

// agent → UI：permissions_list 从 { tools: string[] } 改为分组形态（与存储同构）
{ type: 'permissions_list', permissions: { tool: string; patterns: string[] }[] }  // patterns 空 = 整工具

// UI → agent：permission_revoke 增可选 pattern（带 = 撤单条；不带 = 撤整工具）
{ type: 'permission_revoke', tool: string, pattern?: string }
```

UI 侧措辞自行组装：TUI「对此范围不再询问（`git *`）」、WebUI「Always allow: `git *`」。
决策不加 scope 之类组合字段——第四档就是第四个枚举值，点它即接受 request 里给的模式。

## 4. 会话存储（新字段，无旧版适配）

```jsonc
{ "id": "a1b2", "cwd": "...",
  "sessionPermissions": [                                   // ★ 替换 allowedTools（旧字段直接无视，不迁移不报错）
    { "tool": "read_file", "patterns": ["D:/proj/docs/**"] },
    { "tool": "shell",     "patterns": ["git *"] }
  ] }
```

- `patterns: []` = 整工具提升（原 allow_always 落库形态）；
- 模式批准时已解析为绝对形式，resume 换目录后仍指向当初批准的范围；
- 旧会话（含 `allowedTools`）照常加载消息与上下文，仅会话内提升视为空（重新问一次即可）。

## 5. 运行时语义

- manager：`sessionAllowed: Set<string>` → `sessionRules: Map<tool, string[]>`（空数组 = 整工具）；
  会话提升层判定复用配置规则的分派（path → matchGlob、command → matchWildcard）；
- `allow_always`（整工具）落库 `patterns: []` 并**覆盖**同工具已有窄范围（提宽不提示，/permissions 可见）；
  `allow_always_scoped` 向同工具**追加**模式（去重）；
- **撤销语义与配置编辑器刻意不同**：配置桶里删光模式 = 留在桶内变整工具（桶的出现在即授权）；
  /permissions 里每条模式是独立授权事件——撤掉最后一条模式，该工具的提升记录**整条移除**；
- 撤销粒度：有模式的工具可下钻逐条撤（`permission_revoke { tool, pattern }`），整工具提升直接撤
  （`{ tool }`）；每次撤销后重新推送 permissions_list。

## 6. UI

- **TUI 权限弹层**：三档变四档（`alwaysScope` 存在才渲染第四档，措辞含模式串）；
- **TUI /permissions 面板**：工具列表 → 有模式者 Enter 下钻逐条撤（含「撤销全部」行）、整工具者就地撤；
- **WebUI 权限 banner**：四按钮（同 TUI 条件）；信息面板 Permissions 区按工具分组渲染（展示层，
  撤销交互留后续）；Tool Calls 行的提升标签：`allow_always_scoped` 显示为 `scoped`。

## 7. 测试策略

| 范围 | 方式 |
|---|---|
| derive | 纯函数单测：shell 首词/无参精确、path 目录级、根部文件精确回退、无法推导 undefined |
| manager | 范围提升落库/追加去重/整工具覆盖、会话层判定（含 path 归一化已内置）、细粒度撤销、删光即移除 |
| 契约 | zod schema 新字段（request.alwaysScope / decision 第四值 / permissions_list 分组 / revoke.pattern） |
| 表征 | 权限流场景扩展：scoped 决议 → 后续同范围调用免审批；撤销后恢复询问 |
| UI | TUI 弹层四档按键、/permissions 下钻撤销；WebUI banner 四按钮、信息面板分组渲染 |

## 8. 批次概览（详见 docs/plans/2026-09-09-permission-promotion.md）

| 批次 | 内容 |
|---|---|
| R1 | 契约 + derive + manager 会话规则表 + 会话存储新字段 + 表征/单测 |
| R2 | TUI 弹层四档 + /permissions 下钻撤销 |
| R3 | WebUI banner 四按钮 + 信息面板分组 + 文档同步 |
