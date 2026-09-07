# 06 · tools：工具域与扩展模板

> 工具是 code agent 的手脚。本章讲工具契约、活注册表，以及「加一个新工具」的标准动作。

## Tool 契约：双 schema

```ts
// agent/src/tools/types.ts
export interface Tool {
  name: string
  description: string
  schema: z.ZodTypeAny              // 运行时校验 LLM 给的参数（zod）
  parameters: Record<string, unknown>  // 暴露给 LLM 的 OpenAI JSON schema
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>
}

export type ToolResult = { content: string } | { error: string }
export interface ToolContext { cwd: string; signal: AbortSignal; shellProgram?: string }
```

**为什么要两份 schema？** zod schema 服务于运行时校验（LLM 返回的 arguments 是 JSON 字符串，解析后用 zod 严格校验），JSON schema 服务于模型认知（放进 `tools` 参数告诉模型能调什么）。两者形状不同、缺一不可。

**ToolResult 是 union 而非 throw**——工具失败返回 `{ error }`，成为 tool 消息回填模型，不中断 loop。模型看到错误可以自己调整策略（换路径、换个方式），这是 agent「自愈」能力的基础。真正的 throw 只处理意外崩溃（executor 会兜底成 tool_end）。

## 活注册表

```ts
// agent/src/tools/registry.ts
export class ToolRegistry {
  static withBuiltins(): ToolRegistry {   // 内置四工具
    return new ToolRegistry([new ReadFileTool(), new WriteFileTool(), new EditFileTool(), new ShellTool()])
  }
  register(tool: Tool): void { this.tools.set(tool.name, tool) }
  get(name: string): Tool | undefined
  all(): Tool[]
  schemas(): object[]   // 每次现算 OpenAI tools 参数
}
```

`register()` 是公开的——将来接 MCP 时，远程工具在运行期注册进来即可，不用改任何既有代码。`schemas()` **每次现算**（历史上曾有 import 期固化的模块级快照，导致运行期注册的工具永远不生效——这是注册表必须「活」的原因）。

## 一工具一文件夹：本域的扩展模板

```
tools/
├─ registry.ts  types.ts  index.ts
├─ read_file/
│  ├─ index.ts   # 纯 re-export：export { ReadFileTool } from './tool'
│  ├─ schema.ts  # readFileSchema（zod）+ readFileParameters（JSON schema）
│  └─ tool.ts    # class ReadFileTool implements Tool
├─ write_file/ …  edit_file/ …
└─ shell/
   ├─ index.ts  schema.ts  tool.ts
   └─ support/          # shell 的私有支撑归类（不对外）
      ├─ interpreter.ts # shellProgram → { program, flag }（跨平台解释器映射）
      └─ kill-tree.ts   # 取消时杀进程树（win: taskkill /T；POSIX: 进程组）
```

**加一个新工具的完整动作**（以 grep 为例）：

1. 新建 `tools/grep/{index,schema,tool}.ts`，照抄 read_file 的三件套；
2. `registry.ts` 的 `withBuiltins()` 加一行 `new GrepTool()`；
3. （可选）在 config 的 permission 桶里决定它的默认权限。

结束。不需要动 loop、executor、UI 的任何代码——工具的元数据（name/description/parameters）由 registry 自动组装进每次 LLM 请求，执行由 executor 统一驱动。这就是「扩展位模板」的含义。

## 工具的取消与安全

- **取消**：`ctx.signal` 挂在 spawn 的 abort 上，cancel 时 `kill-tree` 杀整个进程树（Windows 用 taskkill /T，POSIX 用 detached 进程组 kill）。工具是唯一「正在跑外部进程」的地方，取消语义最复杂。
- **shell 解释器**：`support/interpreter.ts` 把配置里的 shellProgram 映射成 `{ program, flag }`（cmd /c、powershell -Command、bash -c），含防御：含非 ASCII 的配置值回退平台默认。
- **执行目录**：所有文件操作相对 `ctx.cwd`——这就是会话的 cwd 持久化（05 章）有意义的理由。

## 测试

`agent/test/tools/file-tools.test.ts` 直接实例化工具、注入临时目录的 ctx 跑 execute——工具是无状态类，测试不需要 registry 之外的任何东西。shell 的解释器映射有独立的纯函数测试（`shell.test.ts`）。
