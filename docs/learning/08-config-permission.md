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
├─ manager.ts    # PermissionManager：运行时层（allow_always 会话内提升）
└─ (classify 已下沉 bridge —— contract/permission.ts)
```

权限是**两层**的：

1. **配置层（静态三桶）**：`classifyPermission(cfg, tool, sessionAllowed?)` 在 bridge 契约里——reject 优先（最安全）、allow 次之、未列出默认 ask（倾向安全）。它是 permission schema 的**唯一解释者**：agent 运行时用它决策，UI 用它显示权限标签，两端永不漂移。
2. **运行时层（会话内提升）**：用户对某工具选 allow_always 后，本会话内不再询问：

```ts
export class PermissionManager {
  private sessionAllowed = new Set<string>()
  classify(tool: string) { return classifyPermission(this.cfg, tool, this.sessionAllowed) }
  apply(tool: string, decision: PermissionDecision) {  // allow_always → 提升进 sessionAllowed
    if (decision === 'allow_always') this.sessionAllowed.add(tool)
  }
  reset()      // 会话隔离：新建/切换会话清空
  revoke(tool) // /permissions 面板撤销
  listAllowed(): string[]   // 授权列表（持久化进 session，resume 恢复）
}
```

**会话隔离**是关键语义：allow_always 存进会话文件（05 章），新建会话时 `reset()` 清空、resume 时按存档恢复——「我信任这个工具」是会话级的承诺，不跨会话泄漏。

## 权限决策的完整链路（跨三域）

```
tool-executor（turn 域）：classify → 'ask'
  → trans(waiting_permission) + requestPermission(tool, args)
    → 门面 emit permission_request  ← UI 弹层
  ← 用户决议：permission_decision { id, decision }
    → PendingPermissions.resolve()  ← Promise 决议，turn 继续跑
  → permission.apply(decision)      ← allow_always 则提升
```

链路上每个环节都可直接替换：SDK 无头使用时注入程序化 `permissionHandler`；测试里注入 `async () => 'allow_once'`（见 `test/turn/loop.test.ts`）。
