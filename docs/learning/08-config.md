# 08 · 配置系统

## Config Schema

配置用 zod schema 定义在 bridge（单一事实源）：

```ts
// bridge/src/contract/config.ts
const modelSchema = z.object({
  name: z.string(),
  contextWindow: z.number().int().positive().default(128000),
  maxOutput: z.number().int().positive().default(16384),
  reasoning: z.boolean().default(false),
})

const providerSchema = z.object({
  name: z.string(),
  protocol: z.enum(['openai']),
  baseURL: z.string(),
  apiKey: z.string(),
  models: z.array(modelSchema).default([]),
})

const configSchema = z.object({
  systemPrompt: z.string().optional(),
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  maxIterations: z.number().int().positive().default(50),
  maxRetries: z.number().int().min(0).default(3),
  shellProgram: z.string().optional(),
  permission: permissionSchema.default({ allow: [], reject: [], ask: [] }),
  providers: z.array(providerSchema).default([]),
})
```

**关键设计**：schema 刻意放宽——name/baseURL/apiKey/models 允许暂时为空。这是为了支持 `/config` 的「先创建空节点、逐字段填写」编辑流程。能否真正对话由 `isConfigured()` 判定，而非 schema 强制非空。

```ts
function isConfigured(config: Config): boolean {
  // 至少有一个完整 provider，且 defaultProvider/defaultModel 能解析到非空模型
  ...
}
```

## 配置文件定位

```ts
// agent/src/config/loader/find.ts
function findConfig(): string | null {
  const local = join(process.cwd(), '.dogegg.json')   // 项目内优先
  if (existsSync(local)) return local
  const user = join(homedir(), '.dogegg', 'config.json')  // 否则用户级
  if (existsSync(user)) return user
  return null  // 都没有 → 空配置，不报错
}
```

**项目内优先**——项目级 `.dogegg.json` 覆盖全局配置，适合项目特定 provider 设置。

## 加载与默认值填充

```ts
// agent/src/config/loader/load.ts
function loadConfig(raw?: unknown): Config {
  let data = raw ?? (findConfig() ? JSON.parse(readFileSync(...)) : {})
  const parsed = configSchema.parse(data)  // zod parse 填默认值
  // 有 provider 时补 defaultProvider/defaultModel（回落到首个）
  if (parsed.providers.length > 0) {
    const defaultProvider = parsed.defaultProvider ?? parsed.providers[0]!.name
    ...
  }
  return parsed  // 空配置保持空——让工具启动、引导用户去 /config
}
```

**空配置是合法状态**——找不到配置文件不报错，进入 TUI 后引导用户 `/config`。

## 树形配置编辑器

`/config` 把 config 的 JSON 结构渲染成一棵可导航的树。

### ConfigPath 导航路径

```ts
type ConfigPath =
  | { kind: 'root' }
  | { kind: 'permission' }
  | { kind: 'permissionBucket'; bucket: 'allow' | 'reject' | 'ask' }
  | { kind: 'providers' }
  | { kind: 'provider'; index: number }
  | { kind: 'models'; providerIndex: number }
  | { kind: 'model'; providerIndex: number; modelIndex: number }
  | { kind: 'selectProvider' }
  | { kind: 'selectModel' }
  | { kind: 'selectShell' }
  | { kind: 'selectTheme' }
  | { kind: 'selectTool'; bucket: 'allow' | 'reject' | 'ask' }
```

`parentPath(path)` 返回父层——用于 Esc/← 返回。

三个新 selector 层（TUI 专属增强）：

- **selectShell**：`shellProgram` 从 `detectShells()` 检测结果中选择（execFileSync 无 shell 探测 + 缓存），另留手动输入兜底。检测逻辑在 `tui/config/shells.ts`（TUI 同进程直接探测；server 的 /api/shells 是 WebUI 等价物）。
- **selectTheme**：5 套主题运行时切换——直接调前端 `setTheme(key)`，不走 config_set（纯 UI 偏好）。切换触发清屏 + Static 重挂载，历史按新主题重绘。
- **selectTool**：权限桶添加工具从 `KNOWN_TOOLS`（shared/tools.ts：read_file/write_file/edit_file/shell）中选择，排除已在桶中的项——替代早期手输名字输入。

### buildEntries 生成字段列表

根据当前 path 和 config 生成一层字段列表：

```ts
// ui/src/tui/config/build.ts（overlays/config 只是 re-export barrel）
function buildEntries(config, path, ctx): Entry[] {
  switch (path.kind) {
    case 'root':
      return [
        { label: 'systemPrompt', kind: 'scalar', value: config.systemPrompt ?? '', save: (v) => ctx.set('systemPrompt', v) },
        { label: 'defaultProvider', kind: 'goto', value: ..., subPath: { kind: 'selectProvider' } },
        { label: 'providers', kind: 'goto', value: `${config.providers.length} 个`, subPath: { kind: 'providers' } },
        ...
      ]
    case 'provider':
      return [
        { label: 'name', kind: 'scalar', value: p.name, save: (v) => ctx.set(`providers.${path.index}.name`, v) },
        { label: '删除此 provider', kind: 'action', run: () => ctx.remove('providers', path.index) },
        ...
      ]
    ...
  }
}
```

5 种 entry 类型：
- `scalar`：标量字段，回车就地输入
- `prompt`：新增项（如添加工具名），回车弹输入框
- `bool`：布尔（reasoning），←→ 切换
- `goto`：钻入子层（回车进入 subPath）
- `action`：执行动作（添加/删除/选中即设）

### 路径解析（paths.ts）

config 编辑通过三个通用 path 操作：`config_set`/`config_add`/`config_remove`。点号路径解析成强类型操作：

```
config_set { path: 'defaultProvider', value: 'openai' }
  → parseConfigSet → { kind: 'top', field: 'defaultProvider', value: 'openai' }

config_set { path: 'providers.0.models.1.contextWindow', value: 128000 }
  → parseConfigSet → { kind: 'model', providerIndex: 0, modelIndex: 1, field: 'contextWindow', value: 128000 }

config_add { path: 'providers', value: {...} }
  → parseConfigAdd → { kind: 'provider', value: {...} }

config_remove { path: 'providers', index: 1 }
  → applyRemove → config.providers.splice(1, 1)
```

**运行时类型检查**（`asString`/`asNumber`/`asStringArray`/`asBoolean`）替代 `as` 断言——避免错误类型的值静默通过。

## ConfigEditor：事务回滚

```ts
// agent/src/config/editor/editor.ts
class ConfigEditor {
  private lastGood: Config  // 最后合法快照

  constructor(config: Config) {
    this.lastGood = structuredClone(config)
  }

  set(path, value) {
    const op = parseConfigSet(path, value)
    if (!op) return { ok: false, error: `无效的配置路径：${path}` }
    applySet(this.config, op)
    return this.afterEdit()
  }

  private afterEdit(): { ok: boolean; error?: string } {
    const result = validateConfig(this.config, this.lastGood)
    if (!result.ok) {
      this.config = structuredClone(result.config)  // 回滚到 lastGood
      return { ok: false, error: result.error }
    }
    this.config = result.config
    this.lastGood = structuredClone(this.config)  // 更新快照
    return { ok: true }
  }
}
```

**`lastGood` 快照模式**——任何编辑后统一重校验（zod + 重名检查），失败自动回滚到最后一次合法状态。用户不会处于半写坏的状态。

**允许空名编辑**——`findDuplicateName` 只检查非空名判重，允许多个空名节点共存（编辑期"先创建空节点再填字段"流程）。

## resolveCurrent

```ts
// agent/src/config/resolve/current.ts
function resolveCurrent(config): { provider: ProviderConfig; model: ModelConfig } {
  const provider = config.providers.find((p) => p.name === config.defaultProvider) ?? config.providers[0]!
  const model = provider.models.find((m) => m.name === config.defaultModel) ?? provider.models[0]!
  return { provider, model }
}
```

defaultProvider/defaultModel 未命中时回落首个——删除默认 provider 不会崩溃。
