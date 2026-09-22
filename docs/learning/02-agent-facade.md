# 02 · 门面与 ctx：Agent 类与可变状态的唯一持有者

> ⚠️ **存档**：本章为 v0.1 时代内容，部分已过时。当前版本学习指南见 [docs/versions/0.2/04-学习指南](../versions/0.2/04-学习指南/README.md)。

> 本章回答两个问题：外部世界怎么和 agent 说话（门面）、agent 内部哪些东西是可变的、归谁管（ctx）。

## 门面 Agent 的职责边界

`agent.ts`（~330 行）只做四件事，多一件都是越界：

```ts
export class Agent {
  constructor(private port: AgentPort, config: Config, cwd: string, opts: AgentOptions = {}) {
    // 1. 组装：构造 ctx + 所有协作类，然后自订阅 port
    this.ctx = { config, permission: new PermissionManager(...), assembler: ..., machine: new StateMachine('idle'), gate: new BusyGate() }
    this.port.onMessage((msg) => { this.send(msg).catch(() => {}) })
  }

  // 2. 路由：20 种入站消息 → 对应特征的控制器
  async send(cmd: UiToAgentMessage): Promise<void> {
    switch (cmd.type) {
      case 'submit':         /* 配置检查 + 解析参数 */ await this.turnRunner.submit(cmd.text, this.resolveTurnParams()); break
      case 'resume_session': this.sessionManager.resume(cmd.id); break
      case 'config_set':     this.configController.set(cmd.path, cmd.value); break
      case 'cancel':         this.ctx.gate.cancel(); this.pending.rejectAll(new CancelledError()); break
      // ...纯查询（status/tools/context/system/log/permissions）在门面直接 emit
    }
  }

  // 3. 出站：emit = 日志埋点 + port.post（纯出站，不再镜像状态）
  // 4. 派生：resolveTurnParams() 在命令时刻解析 provider 连接参数（值传入）
}
```

注意路由 switch 里没有业务逻辑——每条命令的实现都在特征自己的控制器里（TurnRunner / SessionManager / ConfigController）。**门面是路由器，不是处理器**。

## ctx：可变状态的唯一持有者

后端有五样东西会在运行期变化：配置（编辑会整体替换）、权限（同）、上下文组装器（system prompt 路径可能被改）、状态机（每轮 fire）、闸门（进/出忙区）。它们全部住在一个普通对象里：

```ts
// ctx.ts —— 无方法的普通对象（所有权立法见 spec §4）
export interface AgentContext {
  config: Config
  permission: PermissionManager
  assembler: ContextAssembler
  machine: StateMachine
  gate: BusyGate
}
```

四条约定（违反即设计错误）：

1. **其余组件持 ctx 稳定引用、调用时读取**。例如 TurnRunner 里写的是 `this.deps.ctx.config.maxIterations`——每次提交读到的是**当下**的配置，配置编辑后天然生效，不需要任何刷新通知。
2. **禁止把 ctx 的成员包成 accessor 回调外传**。历史上这里是 6 个 `() => T` 闭包（`config()`、`permission()`……），每个都是一根「回指门面内脏的探针」——读代码的人必须理解每个闭包背后是哪个字段、什么时候会被替换。改成 ctx 后这类探针在结构上不可能存在。
3. **派生值在命令时刻解析成值传入**。连接参数（`TurnParams`：client/model/maxOutput…）由门面在 submit 前解析好，作为**值**传给 `turnRunner.submit(text, params)`——而不是让 runner 自己回头去问。一次解析、全程使用，轮中途配置变了也不影响本轮（这正是语义：一轮对话用的模型不该中途变）。
4. **禁止往 ctx 加业务方法**。ctx 是纯状态袋；派生查询（如 `resolveCurrent`）留在 config 域。

配置编辑时，门面整体替换 ctx 的三个成员：

```ts
private onConfigChanged(config: Config): void {
  this.ctx.config = config
  const savedAllowed = this.ctx.permission.snapshot()      // 保留运行时 allow_always 授权
  this.ctx.permission = new PermissionManager(config.permission)
  for (const t of savedAllowed) this.ctx.permission.apply(t, 'allow_always')
  this.ctx.assembler = new ContextAssembler(config.systemPrompt, this.registry)
}
```

注意 `machine` 和 `gate` **从不替换**——只被 fire 和 enter/leave。

## emit：出站的唯一出口

agent 对外说的每一句话都过 `emit()`，它只做两件事：

```ts
private emit(m: AgentToUiMessage): void {
  if (m.type === 'state')      this.logger.log(id, 'state', `${m.from} → ${m.to}`)
  else if (m.type === 'tool_start') this.logger.log(id, 'tool', ...)
  // ...按消息类型打日志（/log 面板按 scope 过滤）
  this.port.post(m)   // 转发给 Port（TUI 进程内直达 / WebUI 走 SSE）
}
```

历史上这里还有第三件事——`machine.sync(m.to)` 镜像另一台状态机。状态机归一后（见 03 章）这台镜像机器不存在了，emit 回归纯粹。**入站日志**（如 `permission_decision`）则在 `send()` 里打——入站与出站的日志本来就是两个方向。

## 状态推送：emitState

状态迁移只有一个入口：

```ts
private emitState(input: TransitionInput): void {
  const prev = this.ctx.machine.state
  const next = this.ctx.machine.fire(input)   // ← 全项目唯一状态机
  if (next !== prev) {
    this.emit({ type: 'state', from: prev, to: next })
    // 状态变化时附带 status_state（token 估算 + 当前模型），让状态栏实时刷新
    try {
      const cur = this.current()
      this.emit({ type: 'status_state', ..., estimatedTokens: this.estimateCurrentTokens(), windowTokens: cur.contextWindow })
    } catch { /* 配置未就绪时跳过 */ }
  }
}
```

`fire` 里的迁移表有 **VALID_FROM 防护**：非法的（状态, 输入）组合原地不动。这意味着重复 fire 是幂等的——这个性质是状态机能被安全归一的前提。

## 一个真实的教训：为什么所有权值得较真

重构前的 TurnRunner 依赖长这样（节选）：

```ts
// ❌ 旧设计：6 根探针
{ config: () => Config, permission: () => PermissionManager, assembler: () => ContextAssembler,
  state: () => State, turnParams: () => TurnParams, ... }
```

每个闭包都指向门面的某个可变字段，读代码的人要回答「这个闭包背后是什么、何时被替换、为什么不能直接持有」——三个问题全靠脑子记。ctx 方案把这些问题**结构性消灭**：持有稳定引用即可，替换发生在 ctx 内部，与使用者无关。这也是为什么后续加功能便宜——新组件只要拿到 ctx，就自动获得了「永远读最新配置」的能力。
