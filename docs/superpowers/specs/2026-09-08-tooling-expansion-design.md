# 工具面扩展设计：ls / glob / grep 与权限升级（M1）

> 状态：草案 v2（2026-09-09 定稿：权限升级经讨论重写为参数化规则方案；待实施）
> 日期：2026-09-08（v2 修订 2026-09-09）
> 前置：v0.2.0 三连重构已落地（OOP 类化 / 后端纵切 / UI 纵切），250 测试全绿
> 定位：v0.2.0 里程碑 M1「能干活的 agent」——架构期结束，进入能力期
> 验收要求：探索能力 / 读类顺畅（免审批）/ 回执可控（上下文增量有界）

## 1. 背景与问题

当前 agent 只有 4 个工具（read_file / write_file / edit_file / shell），其中 read_file 需要确切路径——
agent 没有任何**探索**能力，进入陌生目录无法自主工作，dogfood 无法成立。同时存在一个现状痛点：
`classifyPermission` 对未列出工具默认 ask，而 config schema 的默认三桶为空——**今天 read_file 默认
也是 ask，每读一个文件弹一次审批**，顺畅度无从谈起。

本设计回答两个问题：① 探索类工具怎么建（规格、回执、输出治理）；② 权限模型怎么长（出厂默认 + 通配条目）。

## 2. 核心设计立场：专用工具，不走 shell

探索语义（列目录/找文件/搜内容）建专用工具而非代理 shell 命令，理由（立法级，写进工具文件头注释）：

1. **跨平台确定性**：本项目 Windows 默认解释器 cmd（无 ls/grep），bash/macOS 各版本标志位亦有差异；
   专用工具经 `node:fs` 实现，与 shell 完全无关（同 read_file 先例）。
2. **结构化参数**：JSON 参数 + zod 校验，比模型拼命令行（记标志位、引号、转义）可靠一个量级。
3. **权限粒度**：探索是只读高频操作，默认 allow；shell 是万能后门，必须留在 ask 桶。
   探索若走 shell，权限模型直接失效。
4. **输出治理有抓手**：schema 层强制分页/封顶/截断标注；shell 输出只能事后砍。

三工具对应 agent 进入陌生代码库的三个问题（由浅入深的探索漏斗）：

| 工具 | 回答 | 递归 | 读内容 | 成本 |
|---|---|---|---|---|
| `ls` | 这个目录里有什么 | 否（单层） | 否 | 最低 |
| `glob` | 哪些文件匹配这个模式 | 是 | 否 | 中 |
| `grep` | 这段代码在哪几行 | 是 | 是 | 最高（治理最严） |

## 3. 工具规格

三工具均为「一文件夹三件套」模板（`tools/<name>/{index,schema,tool}.ts`），registry `withBuiltins()` 各加一行。

### 3.1 ls

- 参数：`{ path: string }`（单层，不递归；递归找文件是 glob 的事）。
- 回执：每行一条 `<类型标记> <名字> <大小>`——目录加 `/` 后缀，大小 B/KB/MB 人类可读；
  隐藏文件（`.` 开头）**显示**（agent 需要看 .github/.gitignore 等）。
- 治理：条目封顶 500，超出附「（仅显示前 500 项，共 N 项）」。
- 忽略表**不适用**（用户点名看的目录，如实呈现；黑名单只作用于递归遍历，见 §5）。

### 3.2 glob

- 参数：`{ pattern: string, path?: string }`（path 缺省 = 会话 cwd）。
- 文法子集：`*`（单段内任意字符）、`**`（跨任意段）、`?`（单字符），其余字面量；`[]`/`{}` 后置（非目标）。
- 匹配前路径统一转 posix 形式（`/` 分隔），Windows 分隔符差异在 matcher 入口归一。
- 回执：每行一个相对路径，字母序（稳定、可复现）；命中封顶 100，超出附「（仅显示前 100 个，请收窄 pattern）」。
- matcher 为纯函数 `matchGlob(pattern, path): boolean`（或 globToRegExp），**落位 bridge/contract**
  ——glob 工具与权限参数化规则（§4.2）两处复用，UI 权限展示亦可用（符合「bridge = 契约纯派生」立法）。

### 3.3 grep

- 参数：`{ pattern: string, path?: string, glob?: string, case_insensitive?: boolean }`
  - pattern 默认按正则解析（模型最熟，对齐行业先例）；无效正则回执 `{ error }` 让模型自行改写，不中断轮次；
  - `glob?` 限定只搜匹配该模式的文件（如 `*.ts`）；
  - 不提供上下文行（-A/-B/-C）——模型有 read_file 可自行追读（非目标，见 §7）。
- 遍历：递归 `fs.readdir withFileTypes`，命中黑名单目录剪枝，二进制文件跳过（读首块含 `\0` 判定）。
- 回执格式：`相对路径:行号: 内容`（ripgrep 风格，模型在训练数据中最熟悉），行号 1-based。
  **该格式即「回执即契约」**：未来 UI 工具块展开按 `路径:行号:` 前缀解析着色（对齐 edit_file 行号锚点先例），
  格式改动必须工具与 UI formatter 两处同步。
- 治理（四层递进，全部在工具内部实现，常量不进 bridge——UI 不消费，与 COMPACTION_THRESHOLD 立法理由相反）：
  1. 单行截断 500 字符（截断行尾加 `…`）；
  2. 单文件命中封顶 20，超出附「（该文件还有 N 处未显示）」；
  3. 总命中封顶 100；
  4. 总输出 cap 8000 字符（对齐 read_file 先例），超出附「（输出已截断，请用更具体的 pattern 或 glob 收窄）」。
- 三种输出模式（`output_mode` 参数，缺省 `content`）：`content`（上述格式）；
  `files_with_matches`（每行一个文件路径，有命中即列）；`count`（每文件 `路径: 命中数`）。
  后两种是给模型「先粗后细」的探路方式——先 files_with_matches 锁定文件，再对单文件精确搜。

## 4. 权限升级

### 4.1 出厂默认（治「每读必批」痛点）

configSchema 的 permission **default 值**改为：

```json
{ "allow": ["read_file", "ls", "glob", "grep"], "reject": [], "ask": ["write_file", "edit_file", "shell"] }
```

- 语义**不变**（见 4.2 判定顺序第 4 条）——只把出厂默认配置从「全空」改为「读类 allow、写类 ask」。
  用户已有 config.json 中显式写的 permission 不受影响（zod 仅对缺字段填默认）。
- 对老用户的唯一行为变化：未写 permission 的配置，read_file 从每次弹批变为放行——方向是顺畅度，可接受。
- 刻意**不改** classify 的兜底语义、不在代码内置读类白名单：配置三桶必须是权限的唯一事实源（墓地见 §6）。

### 4.2 参数化规则（工具名 + 参数模式）

> ⚠️ 本节的「扁平条目数组」配置形态已被 M1.1（`2026-09-09-permission-config-design.md`）的
> **桶 → 工具 → 模式数组（空数组 = 整工具）** v2 形态取代——legacy 条目加载仍兼容（归一化转换），
> 判定优先级、匹配语义、fail-closed 立法原样生效。以下保留为引擎层的立法快照。

三桶条目从纯工具名升级为 union：**裸字符串（整工具，现状语法完全兼容）或规则对象（工具 + 参数模式）**。
参考 Claude Code 的 `Tool(specifier)` 模型，但用结构化对象替代字符串编码（墓地见 §6）。

```jsonc
"permission": {
  "allow": [
    "grep",                                          // 裸名：整工具放行
    { "tool": "read_file", "path": "docs/**" },      // 只许读 docs/ 下文件
    { "tool": "edit_file", "path": "src/**" },       // 只许改 src/ 下文件
    { "tool": "shell",    "command": "git *" }       // 以 git 开头的命令
  ],
  "ask":    [ { "tool": "shell", "command": "rm *" } ],
  "reject": [ { "tool": "shell", "command": "rm -rf *" } ]
}
```

**规则对象文法**：`{ tool: string } & Record<string, string>`——`tool` 精确名或通配（`*`/`?`/`**`，
复用 §3.2 matcher）；其余键值对 = 参数模式，**镜像工具自己的 zod schema 字段名**（read_file 的参数就叫
`path`，shell 的就叫 `command`），用户与模型无需学第二套语法。

**通用匹配引擎**（bridge 纯函数，一个实现覆盖所有工具，未来加工具零成本接入权限参数化）：

- 规则命中条件 = `tool` 字段匹配（精确或通配）**且**其余每个限定键在工具实际参数中存在同名字符串字段
  且值命中——**全部键命中才算命中**；
- **匹配语义分两类**：`path` 键用路径 glob（`*` 不跨段——`docs/*` 刻意不覆盖 `docs/x/y`，分段性是
  路径规则的安全性质）；其余键（shell 的 `command` 等）用平文本通配（`*` 跨任意字符——命令不是路径，
  斜杠无分段含义，`git *` 必须能匹配 `git commit -m "a/b"`）；
- 规则写了参数中不存在的键、或对应参数值不是字符串 → 规则不命中（**fail-closed**，安全默认）；
- 路径归一化归 agent 的 PermissionManager（需要 cwd 状态，bridge 保持纯）：参数中的 `path` 字段与规则中的
  `path` 模式都按 posix 分隔符 + 相对会话 cwd 归一后再匹配——cwd 来自调用方（ToolExecutor 持有 turn.cwd），
  set_cwd 切换目录后天然生效；
- **shell 规则立法**：glob 全匹配会命中 `git status && rm -rf /` 这类命令链——参数化 shell 规则定位为
  **「便利而非安全边界」**（文件头注释立法），危险命令靠 ask 桶显式压制；命令链拆分器（逐段判定）是
  独立的后续批次，不进本设计。

**判定顺序（升级）**：reject 任一规则命中 → **会话内 allow_always**（用户最新的显式意图，除 reject 外
压过一切——否则对 ask 桶工具的提升会失效）→ **ask 任一规则命中** → allow 任一规则命中 → 默认 ask。
即 **reject > sessionAllowed > ask > allow > 默认**；「宽放行 + 窄确认」成为可能（ask 规则压过 allow 规则），
且 **ask 桶为空时与旧实现判定逐字节一致**（旧实现里 ask 桶条目本就只是回落默认），现有配置零迁移。

**allow_always**：v1 保持整工具提升不变（ask 弹批后选「始终允许」把工具名提入 sessionAllowed）；
「对该目录/该命令前缀不再询问」的参数化提升列为后续增强。

**UI 同步**：`ui/shared/permission.ts` 的展示判定与后端共用同一 classifyPermission 与 matcher，两端永不漂移；
参数化规则不含在 sessionAllowed 提升语义内（display-only 层不变）。

**配置编辑器**：TUI 树形编辑器 / WebUI settings 对规则对象的增删编辑列为独立 UI 批次——本批次规则靠
config.json 手编（编辑器本就支持自由填字段，对象条目可导航查看）。

## 5. 忽略表（递归遍历共用）

glob 与 grep 共用同一份忽略规则（ls 不适用，见 §3.1）：

- **内置黑名单目录**（递归剪枝）：`node_modules`、`.git`、`dist`、`build`、`out`、`.next`、`coverage`、
  `.dogegg` 等；常量落在 agent 侧（tools 私有 support 文件），UI 不消费故不进 bridge。
- **二进制跳过**：读文件首块含 `\0` 即跳过（不依赖扩展名白名单——扩展名枚举不完）。
- 完整 `.gitignore` 解析（嵌套/取反/目录锚定）列为后续增强，非本批次。

## 6. 墓地（被否决方案）

| 方案 | 否决理由 |
|---|---|
| 调外部 ripgrep | 引入外部二进制依赖与分发问题（Windows），违背「手写学机制」的项目精神 |
| shell 代理（dir/findstr） | 跨平台语法漂移、自由字符串不可靠、权限粒度失效（§2） |
| minimatch 等匹配库 | matcher 是本批学习核心且需 bridge/UI 复用，手写常用子集成本可控 |
| `Tool(specifier)` 字符串编码（Claude 式） | 括号嵌套解析坑（shell 命令含括号）、违背「运行时校验统一用 zod」立法、树形编辑器难渲染自由串 |
| 每工具自定义权限 matcher（Claude 式） | 规则字段镜像工具 schema + 通用引擎 = 一份实现覆盖所有工具，新工具零成本接入 |
| classifyPermission 内置读类白名单 | 策略藏进代码，配置三桶不再是唯一事实源 |
| shell 参数化规则做严格安全边界（本批） | 命令链拆分（`&&`/`;`/管道/反引号）是正经解析工程，独立成批；本批立法「便利非边界」 |
| 完整 .gitignore 解析（本批） | 嵌套规则/取反工作量翻倍，内置黑名单已覆盖 90% 痛点 |
| grep 上下文行（-A/-B/-C） | 参数面与治理组合数膨胀；模型有 read_file 可自行追读 |

## 7. 非目标（本批次不做）

- shell 命令前缀权限规则（独立批次）
- `[]`/`{}` glob 文法、.gitignore 完整解析（后续增强）
- grep 上下文行、多 pattern、正则 flags 暴露
- MCP / 子 agent（M1.5 / M3 里程碑）
- UI 侧 grep 结果跳转（编辑器联动类功能）

## 8. 测试策略

| 范围 | 方式 |
|---|---|
| 三工具 | 临时目录实测（照 file-tools.test.ts 先例）：正常路径、空结果、超封顶截断标注、无效正则回执 error、二进制跳过、黑名单剪枝、隐藏文件、Windows 分隔符归一 |
| glob matcher | 纯函数穷举：`*`/`**`/`?` 组合、posix 归一、字面量点号转义 |
| 权限 | classifyPermission 参数化规则：裸名兼容、tool 通配、参数模式命中、fail-closed（规则键不存在/值非串）、路径归一化（posix + 相对 cwd）、优先级 reject > ask > allow > 默认、sessionAllowed 整工具提升不变 |
| 出厂默认 | configSchema 默认值断言 + 未写 permission 的老配置加载后行为 |
| 表征测试 | agent.turn.test.ts 增一个「grep 工具调用」场景锁消息序列（submit → tool_start → tool_end → message → finished） |
| UI | tool-display 三个 formatter 单测（折叠头/展开正文/命中行号着色） |

## 9. 批次概览（详细计划见 docs/plans/2026-09-08-tooling-expansion.md）

| 批次 | 内容 | 风险 |
|---|---|---|
| T1 | bridge matcher（globToRegExp/matchGlob）+ traverse（walker/ignore）+ 三工具三件套 + 治理 + 全量单测（不动权限/不动 UI） | 低 |
| T2 | permission 条目 union + 通用匹配引擎 + agent 归一化 + 出厂默认 + UI 展示同步 + 测试 | 中（契约改动） |
| T3 | tool-display 三 formatter + 表征测试补充 + 文档同步（设计文档 §5/§8 / learning 06/08 / README）+ dogfood 验收 | 低 |

dogfood 验收（T3 完成判定）：在本仓库用 dogegg 完成一次真实小任务（如定位某常量的全部引用并汇总），
全程读类零审批、上下文占用有界；踩坑记录进 `.scratch/`。

## 10. 文档同步清单（T3 内完成）

- 设计文档 §8 工具清单 4 → 7；§5 权限模型补参数化规则与出厂默认
- learning/06-tools.md：三工具专章 + 输出治理四层 + matcher 落位 bridge 的理由
- learning/08-config-permission.md：出厂默认与参数化规则（引擎/归一化/优先级/shell 立法）
- README「项目特点」工具能力更新
