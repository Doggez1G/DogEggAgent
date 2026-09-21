# DogEggAgent 配置说明（v0.2.x）

> 本文档对应 `dogegg-agent` **0.2.x**。配置加载失败时，终端报错会提示本文件；请核对每一项的格式与本页一致。
> 配置文件位置：**项目内 `.dogegg.json` 优先**，否则 `~/.dogegg/config.json`。找不到配置文件不是错误——程序照常启动并引导你 `/config`。

## 字段总览

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `systemPrompt` | string（可选） | 内置提示词 | system prompt 文件路径（支持 `~`、相对配置文件所在目录） |
| `defaultProvider` | string（可选） | 首个 provider | 默认 provider 名（须与 providers[].name 一致） |
| `defaultModel` | string（可选） | 该 provider 首个 model | 默认模型名（须与 models[].name 一致） |
| `maxIterations` | number | `-1`（无限） | 单次提交最大轮次；`-1` 无限，正整数为上限（无人值守批处理用） |
| `maxRetries` | number | `3` | LLM 请求失败重试次数 |
| `shellProgram` | string（可选） | 按平台 | shell 解释器（Windows `cmd`，其他 `bash`） |
| `permission` | object | 见下 | 工具权限三桶（0.2.x：桶 → 键 → `{ whole, patterns }` 规则） |
| `providers` | array | `[]` | provider 列表（见下） |

## permission（权限三桶：桶 → 键 → { whole, patterns }）

完整示例——一份「读类顺畅、shell 按需审批、危险命令拒绝」的实用配置：

```json
{
  "permission": {
    "allow": {
      "read_file": { "whole": true,  "patterns": [] },
      "ls":        { "whole": true,  "patterns": [] },
      "glob":      { "whole": true,  "patterns": [] },
      "shell":     { "whole": false, "patterns": ["git *", "npm run *"] }
    },
    "ask": {
      "edit_file": { "whole": false, "patterns": ["./src/**"] },
      "shell":     { "whole": false, "patterns": ["rm *"] }
    },
    "reject": {
      "shell": { "whole": false, "patterns": ["rm -rf *"] }
    }
  }
}
```

**出厂默认**（配置文件**完全不写 `permission` 字段**时生效）：`read_file` / `ls` / `glob` / `grep` 四个读类整工具放行，`write_file` / `edit_file` / `shell` 整工具按 ask 审批。注意**显式配置会整体覆盖出厂默认**（不是合并）——自己写 `permission` 时想让读类免审批，就要像上面示例一样显式列出。

> **格式演进不兼容**：配置格式只支持当前版本。旧格式（模式数组、条目数组）加载会报错并提示本文档——按报错改写或删除 `permission` 字段回退出厂默认后经 /config 重配即可。

### 桶内规则的两种状态（whole 字段）

三桶顶层结构一致，桶内是「键 → 规则」的映射，键有两类——内建工具名与 MCP 服务名：

- **`whole: true`** → 整键生效：`"read_file": { "whole": true, "patterns": [] }` 表示该工具的
  所有调用都按本桶处理；`"mcp:playwright": { "whole": true, "patterns": [] }` 表示该服务下
  所有工具都按本桶处理（见下节）。此时 patterns 不参与匹配，仅作取消整选后的恢复内容；
- **`whole: false`** → 只有**命中 patterns 的调用**按本桶处理，未命中的调用按「未列出工具」
  走默认 ask。patterns 为空数组表示键存在但当前不命中任何规则（编辑中的空选态）。

### MCP 服务键（以服务为权限单元）

桶键除内建工具名外，还可以是 **MCP 服务键 `mcp:<服务名>`**（服务名即 `mcpServers` 里的 `name`，
如 `mcp:playwright`）。`mcp:` 前缀使服务键与内建工具键的键空间彻底正交——服务名不受任何字符
限制也不会与内建工具名歧义。服务是一个权限单元——匹配按工具注册期记录的服务归属进行，
**与工具的内部名字无关**：

- **`whole: true`** → 整组生效：该服务下的所有工具都按本桶处理（服务升级新增工具自动覆盖）；
- **`whole: false`** → patterns 条目匹配的是**服务内部工具名**（服务 `tools/list` 声明的名字，
  如 `browser_close`、`browser_*`），精确名或 `*` 通配皆可。注意这是**工具启用匹配**，
  永不涉及工具执行参数——参数模式（路径/命令）只属于内建工具。

例——整组放行、仅该服务的单个工具每次询问：

```json
{
  "permission": {
    "allow": { "mcp:playwright": { "whole": true,  "patterns": [] } },
    "ask":   { "mcp:playwright": { "whole": false, "patterns": ["browser_evaluate"] } }
  }
}
```

配合判定顺序：`browser_evaluate` 每次弹审批，其余 playwright 工具直接放行。反向组合
（ask 整组 + allow 个别）不成立——ask 桶命中即询问，压过 allow 的精确规则。

服务键的匹配不解析任何 LLM 可见名（工具注册期即记录归属），服务名可以包含任意字符。
LLM 侧的函数名若不符合模型供应商的命名规定（字符集 `[a-zA-Z0-9_-]`、长度 ≤64），注册表会
自动将其整体哈希为 `h-<哈希>` 标签——这只影响模型看到的调用名，权限匹配与界面展示始终使用
真实服务名与内部工具名。

### 模式约束的是工具的哪个参数（主参数表）

模式字符串匹配的是工具调用时实际传入的参数，**每个工具固定约束一个主参数**：

| 工具 | 主参数 | 模式示例 | 语义 |
|---|---|---|---|
| `shell` | `command` | `"git *"` | 以 git 开头的命令（`*` = 任意字符，含空格与 `/`） |
| `read_file` / `write_file` / `edit_file` / `ls` / `glob` / `grep` | `path` | `"./docs/**"` | 该路径下的文件（`*` 不跨 `/`，`**` 跨任意层） |

通配符语义**按主参数分派**：路径有层级，段边界是安全性质——`./docs/*` 刻意不覆盖 `./docs/sub/x.md`（要跨层写 `**`）；命令是平文本，`git *` 要能匹配含 `/` 的提交信息。

**作用域锚点**（path 模式的写法，决定相对哪里解析）：

| 锚点 | 作用域 | 例 |
|---|---|---|
| `./` 或 `../` | 会话工作目录（cwd） | `./**`、`../shared/**` |
| `~/` | 用户主目录 | `~/notes/**` |
| 盘符（如 `D:/`） | 该绝对子树 | `D:/allowed/**` |
| `*` 开头 | 从文件系统根匹配 | `**/test`（全盘任意深度） |

**裸名字（如 `docs/**`、`test`）会被加载拒绝**并报「缺少作用域前缀」——必须写明锚点，避免歧义。
此校验**仅对内建 path 工具生效**：MCP 服务键等其余键的数组条目是工具名选择器（如 `browser_close`），
不做路径锚点校验。

### 判定顺序

一次调用按固定顺序判定，**先命中先生效**：

1. `reject` 任一规则命中 → 拒绝；
2. 会话内「始终允许」提升（`/permissions` 可见，随会话存续）→ 放行；
3. `ask` 任一规则命中 → 弹层审批（即使 allow 有更宽的规则——窄的 ask 压过宽的 allow）；
4. `allow` 任一规则命中 → 放行；
5. 全部未命中 → 默认 ask（固定安全默认，无法配置关闭）。

**已知的诚实取舍**：命令模式的通配会命中命令链（`git *` 也能匹配 `git x && rm y`），因此 shell 的参数化规则是**便利而非安全边界**——危险命令请用 `ask`/`reject` 桶显式压制。

### 会话内提升 vs 配置

弹层里选「始终允许」的授权是**会话级**的（随会话存续，`/permissions` 可撤销，新建会话清空）；本节的配置规则是**持久的**。两者独立生效，判定时会话提升优先于 ask 规则。

## providers[]（模型接入）

每个 provider 一个对象：

```json
{
  "providers": [
    {
      "name": "openai",
      "protocol": "openai",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "models": [
        { "name": "gpt-4o", "contextWindow": 128000, "maxOutput": 16384, "reasoning": false }
      ]
    }
  ]
}
```

- `name`：provider 名（provider 与 model 各自需要唯一，编辑期空名暂允许多个）；
- `protocol`：目前仅 `"openai"`（OpenAI 兼容端点均可，如 DeepSeek / vLLM）；
- `models[].contextWindow`：上下文窗口 tokens（决定自动压缩阈值 80%）；
- `models[].reasoning`：是否推理模型（思考内容会被持久化并在 resume 后恢复）。

## 常见错误

- **`权限模式 "xxx" 缺少作用域前缀`**：path 类模式必须写明锚点——`./`（cwd）、`~/`（主目录）、盘符（绝对）或 `*` 开头（从根匹配）；裸名字（如 `docs/**`）会被加载拒绝。整工具授权写空数组 `[]`，不要写 `"**"`；
- **`expected: array` / 配置校验失败**：0.2.x 的 permission 是「桶 → 工具 → 模式数组」结构（见本页主示例）；0.1.x 的旧扁平写法（`"allow": ["read_file"]` 字符串数组）加载时会**自动归一**为新形态，保存时统一写新格式——若手工维护配置请尽早改写；
- **配置里写了参数化规则但没生效**：检查三件事——桶内是否为「工具名 → 模式数组」、模式是否写了主参数对应的锚点/通配、该调用是否被更早的 reject/会话提升截住（判定顺序见上）；
- provider/model 名重复：编辑期重名会被回滚并提示。
