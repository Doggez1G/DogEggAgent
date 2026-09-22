# 06 · tools：工具域与扩展模板

> ⚠️ **存档**：本章为 v0.1 时代内容，部分已过时。当前版本学习指南见 [docs/versions/0.2/04-学习指南](../versions/0.2/04-学习指南/README.md)。

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
export interface ToolContext {
  cwd: string
  signal: AbortSignal
  shellProgram?: string   // 仅 shell：解释器映射（cmd/powershell/bash），缺省按平台解析
  shellTimeoutMs?: number // 仅 shell：单命令超时毫秒，缺省 120s（超时杀进程树，已有输出回填模型）
}
```

**为什么要两份 schema？** zod schema 服务于运行时校验（LLM 返回的 arguments 是 JSON 字符串，解析后用 zod 严格校验），JSON schema 服务于模型认知（放进 `tools` 参数告诉模型能调什么）。两者形状不同、缺一不可。

**ToolResult 是 union 而非 throw**——工具失败返回 `{ error }`，成为 tool 消息回填模型，不中断 loop。模型看到错误可以自己调整策略（换路径、换个方式），这是 agent「自愈」能力的基础。真正的 throw 只处理意外崩溃（executor 会兜底成 tool_end）。

## 活注册表

```ts
// agent/src/tools/registry.ts
export class ToolRegistry {
  static withBuiltins(): ToolRegistry {   // 内置七工具（读类：read_file/ls/glob/grep；写类：write_file/edit_file/shell）
    return new ToolRegistry([new ReadFileTool(), new WriteFileTool(), new EditFileTool(), new ShellTool(), new LsTool(), new GlobTool(), new GrepTool()])
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
├─ ls/  glob/  grep/             # 探索类三件套（见「输出治理」一节）
├─ traverse/                     # 递归遍历能力（walker + 忽略表）——glob/grep 共用底座
│  ├─ walker.ts                  # walkFiles：黑名单剪枝、symlink 跳过、产出 posix 相对路径
│  └─ ignore.ts                  # IGNORED_DIRS（node_modules/.git/dist…）+ isBinaryFile（\0 判定）
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
- **shell 超时**：单命令 120s（`shellTimeoutMs` 可配）——超时同样走 kill-tree，且把**已产生的输出**回填模型（附「命令超时未结束」说明），不静默丢弃；否则一个不退出的常驻进程会卡死整轮对话。
- **shell 解释器**：`support/interpreter.ts` 把配置里的 shellProgram 映射成 `{ program, flag }`（cmd /c、powershell -Command、bash -c），含防御：含非 ASCII 的配置值回退平台默认。
- **执行目录**：所有文件操作相对 `ctx.cwd`——这就是会话的 cwd 持久化（05 章）有意义的理由。

## 探索类工具与输出治理（ls / glob / grep）

探索三工具对应 agent 进入陌生代码库的三个问题——`ls`「这个目录里有什么」（单层）、`glob`「哪些文件
匹配这个模式」（递归找名）、`grep`「这段代码在哪几行」（递归搜内容）。三者是**专用工具而非 shell 代理**：
跨平台（Windows cmd 无 ls/grep）、结构化参数（zod 校验比拼命令行可靠）、权限粒度（读类默认 allow、
shell 必须留 ask）、输出治理有抓手（schema 层封顶）。实现经 `node:fs`（`traverse/walker.ts` 共用底座），
与 shell 完全无关。

**grep 的四层输出治理**——搜索结果天然不可控，四层递进保证回执有确定上界（这是探索工具的核心设计课）：

1. 单行截断 500 字符（minified 代码/长字符串一行几千字符）；
2. 单文件命中封顶 20（生成文件里同一 pattern 密集出现），附「还有 N 处」补数说明；
3. 总命中封顶 100（命中文件数失控）；
4. 总字符 cap 8000（对齐 read_file 先例），超出提示收窄 pattern。

`glob` 封顶 100 附「请收窄 pattern」、`ls` 封顶 500，同一思想。grep 还带三种输出模式
（content / files_with_matches / count）——「先粗后细」是模型自己该学会的工作流。

**glob matcher 落位 bridge**（`bridge/src/contract/glob.ts`）：`globToRegExp`/`matchGlob` 是纯函数，
glob 工具、权限参数化规则、UI 权限展示三端共用一份实现（「bridge = 契约纯派生」立法的另一实例）。
文法子集 `*`（单段）`**`（跨段含零段）`?`（单字符）；边界语义：`src/**` 不匹配 `src` 本身、
`**/x` 含根级 `x`。

## 回执即契约（跨层格式，勿随手改）

`content` 是给模型看的，但其中两处**固定格式**同时被 UI 层解析（`ui/src/shared/tool-display.ts`，各有立法注释）——改格式必须两处同步：

| 工具 | content 格式 | UI 层怎么用 |
|---|---|---|
| shell | 首行 `exit=N`（超时附「（超时说明）」），其后是 stdout/stderr | 成功丢弃 exit 行（✓ 已表达），exit≠0 提升为头行红色「✕ 退出 N」，输出为正文 |
| edit_file | `已替换 1 处（原第 N 行起）`——锚点是 old_string 在原文件中的起始行 | diff 展开按锚点标真实行号（删=旧位置，存=新位置）；旧格式回执优雅降级不标 |
| grep | `相对路径:行号: 内容`（ripgrep 风格，模型训练数据里最熟悉的形状） | 头行结果段按行形区分「N 处命中 / N 个文件」，展开正文保留坐标原文 |

模型同样受益于这些格式（shell 的 exit 码供其判断成败、edit 的锚点供其定位后续编辑、grep 的坐标供其
精确 read_file），所以格式活在工具回执里而非 UI 专设字段。

## 测试

`agent/test/tools/file-tools.test.ts` 直接实例化工具、注入临时目录的 ctx 跑 execute——工具是无状态类，测试不需要 registry 之外的任何东西。shell 的解释器映射有独立的纯函数测试（`shell.test.ts`）。
