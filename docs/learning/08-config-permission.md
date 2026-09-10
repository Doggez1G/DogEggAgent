# 08 · config 与 permission：配置域与权限域

> 配置是 agent 的「神经系统」（用哪个模型、什么权限策略），权限是「行为边界」。
> 两者都围绕 bridge 契约里的 schema 工作——**schema 的唯一解释者在契约包**。

## config/ 的三个组件

```
config/
├─ store.ts        # ConfigStore：查找/读取/落盘（路径策略为模块私有）
├─ resolve.ts      # resolveCurrent：当前 provider + model 的解析
├─ controller.ts   # ConfigController：config_set/add/remove/request 命令面
└─ editor/         # ConfigEditor：编辑 + 校验 + 回滚（paths 文法 / mutate / validate）
```

### ConfigStore：宽容加载 + 严格校验

```ts
const parsed = configSchema.parse(data)   // zod：校验 + 填默认值
// 有 provider 时补 defaultProvider/defaultModel（回落到首个）
```

- **找不到配置文件是合法状态**：返回空配置（providers 为空），程序照常启动、UI 引导用户 /config——**空配置 ≠ 错误**，这是引导式初始化的基础。
- zod schema 本体在 bridge（`contract/config.ts`），agent 与 ui 共享同一份类型与默认值——配置的「形状」只有一个解释者。

### ConfigEditor：快照回滚

树形配置编辑的难点：用户改到一半失败（重名、非法值），不能把配置留在半写坏的状态。editor 的做法：

```ts
// 每次编辑前快照 → mutate → validate → 失败则回滚 lastGood
this.lastGood = structuredClone(this.config)
```

`paths.ts` 实现点号路径文法（`providers.0.models.1.maxOutput`），让 TUI/WebUI 的树形编辑器能逐字段导航——**set/add/remove 全部走同一条文法解析**，三端（agent、TUI、WebUI）对「路径」的理解一致。

编辑成功后的联动在门面（`onConfigChanged`）：整体替换 ctx 的 config/permission/assembler 三个成员，然后 `ConfigStore.save()` 落盘。

### resolveCurrent：容错的当前模型解析

```ts
export function resolveCurrent(config: Config): { provider: ProviderConfig; model: ModelConfig } {
  const provider = config.providers.find((p) => p.name === config.defaultProvider) ?? config.providers[0]!
  const model = provider.models.find((m) => m.name === config.defaultModel) ?? provider.models[0]!
  return { provider, model }
}
```

defaultProvider 未命中回落首个 provider，model 同理。调用方需先经 `isConfigured`（在 bridge）判定——**isConfigured 也是契约的纯派生**，agent 不重写。

## permission/：两层权限模型

```
permission/
├─ manager.ts    # PermissionManager：运行时层（allow_always 会话内提升 + 路径归一化）
└─ (匹配引擎下沉 bridge —— contract/permission.ts + contract/glob.ts)
```

权限是**两层**的：

1. **配置层（静态三桶，v2 分组形态）**：`classifyPermission(cfg, tool, args?, sessionAllowed?)` 在 bridge
   契约里。三桶顶层不变，桶内 = **工具 → 模式数组**（`"shell": ["git *"]`，空数组 = 整工具生效）——
   模式经主参数表（`primarySpecifier`：shell → command，其余 → path）落到工具实际参数上，任一模式命中
   即该条生效，无参数可比 fail-closed。**路径模式的作用域由锚点前缀显式声明，归一化只做解析不决定
   作用域，glob 算子不兼职标记**：`./`（cwd）、`~/`（主目录）、盘符（绝对子树）、`*` 开头（从文件
   系统根匹配，`**/x` 全盘任意深度而 `*/x` 仅盘根一层）；字面量打头的裸模式（`docs/**`）拒绝加载
   （schema 校验，编辑器内经回滚浮出）。**匹配函数按主参数分派**：`path` → `matchGlob`（分段 glob，
   `*` 单段、`**` 跨段——路径有层级，段边界是安全性质）；`command` 与工具名 → `matchWildcard`
   （平文本通配，`*` = 任意字符——命令没有层级概念）。归一化用 `path.resolve` 折叠整条路径的
   `..`/`.`（不止第一个）。判定顺序 **reject > 会话内 allow_always > ask 规则 > allow 规则 > 默认 ask**——
   窄的 ask 模式能压过宽的 allow（「例外强制确认」），会话提升是用户最新显式意图（除 reject 外最高，
   否则对 ask 桶工具的提升会失效）。参数化 shell 规则立法为「便利而非安全边界」（命令链拆分器是
   独立后续批次）。路径归一化（模式与参数 → 相对 cwd 的 posix）归 manager（cwd 由 ToolExecutor 传入，
   set_cwd 后天然生效），bridge 保持纯。**书写格式与内存模型分离**：config.json 的 legacy 扁平条目在
   加载期经 zod transform 归一为 v2（`contract/config.ts`），保存统一写 v2——引擎与判定语义零改动
   （见 `2026-09-09-permission-config-design.md`）。
2. **运行时层（会话内提升）**：用户对某工具选 allow_always 后，本会话内不再询问：

```ts
export class PermissionManager {
  private sessionAllowed = new Set<string>()
  // cwd 由调用方（ToolExecutor）传入——path 类规则/参数归一到相对 cwd 的 posix 坐标系后交给引擎。
  classify(tool: string, args?: ToolArgs, cwd?: string) {
    return classifyPermission(this.cfg, tool, this.normalizeArgs(args, cwd), this.sessionAllowed)
  }
  apply(tool: string, decision: PermissionDecision) {  // allow_always → 提升进 sessionAllowed
    if (decision === 'allow_always') this.sessionAllowed.add(tool)
  }
  reset()      // 会话隔离：新建/切换会话清空
  revoke(tool) // /permissions 面板撤销
  listAllowed(): string[]   // 授权列表（持久化进 session，resume 恢复）
}
```

**会话隔离**是关键语义：提升存进会话文件（05 章），新建会话时 `reset()` 清空、resume 时按存档恢复——「我信任这个工具」是会话级的承诺，不跨会话泄漏。

**范围提升（allow_always_scoped）**：弹层第四档「对此范围不再询问」——把当次调用固化为一条会话内
范围规则，不必在「每次都问」与「整工具放行」间二选一。范围由 agent 推导（`permission/derive.ts`
纯函数）：shell 取首词前缀（`git status` → `git *`），path 取所在目录（`docs/guide.md` → `./docs/**`，
根部文件回退精确）；推导时即解析为绝对模式入库，resume 换目录后仍指向当初批准的范围。
提升落库为 `sessionRules: Map<tool, patterns>`（patterns 空 = 整工具；整工具提升覆盖窄范围，
范围追加去重），与配置规则共用同一套分派匹配。`/permissions` 按工具分组展示、可下钻逐条撤销
（撤光即整条移除——与配置桶「删光模式留整工具」刻意不同：每条提升是独立的授权事件）。

## 权限决策的完整链路（跨三域）

```
tool-executor（turn 域）：classify(tool, args, cwd) → 'ask'
  → trans(waiting_permission) + requestPermission(tool, args)
    → 门面 emit permission_request  ← UI 弹层
  ← 用户决议：permission_decision { id, decision }
    → PendingPermissions.resolve()  ← Promise 决议，turn 继续跑
  → permission.apply(decision)      ← allow_always 则提升
```

**出厂默认**（config schema 的 permission default，设计 §4.1）：读类 allow（read_file/ls/glob/grep）、
写类 ask（write_file/edit_file/shell），v2 形态即 `allow: { read_file: [], ls: [], glob: [], grep: [] }`——
探索免审批是 dogfood 顺畅度的前提；仅对「配置未写 permission 字段」的加载生效，用户显式配置不受影响。

链路上每个环节都可直接替换：SDK 无头使用时注入程序化 `permissionHandler`；测试里注入 `async () => 'allow_once'`（见 `test/turn/loop.test.ts`）。
