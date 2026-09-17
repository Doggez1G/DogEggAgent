# M2.5 打磨批次设计：配置指引、@path 补全、.gitignore、会话标题与 realpath

> 状态：已实施（含 2026-09-15 评审轮修订，见 §8）
> 日期：2026-09-10
> 前置：M1~M2 已全部落地（feat/v0.2.0 @ 8b93819，326 测试）。

## 1. realpath 堵 symlink 逃逸（安全正确性）

**问题**：权限的路径匹配是**词法**的（`path.resolve` 只折叠字符串，不查询文件系统）。cwd 内的
符号链接指向 cwd 外时（`D:\proj\notes.txt → D:\私密\notes.txt`），词法解析认为目标在 cwd 内、
命中放行规则，实际读取经操作系统链接解析读到了 cwd 外的文件——「cwd 内随意读」的承诺被绕过。

**决策**：classify 时对参数 path 做 `fs.realpathSync`（操作系统真实路径），**按真实位置匹配**
（规则模式保持词法——模式描述授权意图，参数必须以真实身份命中它）。方向安全：链接逃逸后
真实路径超出模式范围 → 失配 → 落 ask（而非误放行）。

- 目标不存在（write_file 新建）：对**真实父目录** realpath + 文件名拼接（新建文件按其将落入的
  真实目录判定）；父目录也不存在 → 退回词法解析（极端兜底）；
- Windows junction 同样按 symlink 解析 ✓（无需管理员权限，测试可用 junction 构造）；
- 已知边界（立法注明）：模式侧不做 realpath（glob 无法解析）——刻意给链接目录写死放行规则的
  场景会失配，方向保守。

## 2. .gitignore 支持（grep / glob 遍历）

- `traverse/ignore-gitignore.ts`：解析项目根 `.gitignore` 的核心子集——`#` 注释、空行跳过、
  尾 `/` = 仅目录、前 `/` = 锚定根、含 `/` 的模式相对根锚定、无 `/` 的模式匹配任意层级的
  目录/文件名、`!` 取反（**后匹配优先**，gitignore 顺序语义）；不实现嵌套 .gitignore 与 `**` 前
  导之外的扩展语义（内置黑名单继续生效）；
- `walker.ts` 接受可选 `gitignore?: (relPath: string, isDir: boolean) => boolean` 谓词，
  匹配者跳过；grep/glob 装入：加载根 .gitignore → 构造谓词 → 传入遍历；
- 默认**启用**（无 .gitignore 时为空谓词，行为不变）。

## 3. 会话标题：自动生成 + /rename

- 会话文件与 `SessionSummary` 增 `title?: string`；列表展示 `title ?? preview`；
- **自动生成**：首轮成功结束后（gate 释放前后台执行，带 in-flight 去重），用当次 client 发一次
  廉价调用（系统提示词：只输出 ≤20 字标题，无引号无前后缀；输入 = 首条用户消息 + 首条助手回复
  各截 500 字）→ 写入 conversation.title → 重存会话 → 广播 session_list；失败静默（标题是装饰）；
- **/rename <名称>**：新斜杠命令 → `rename_session { title }` → conversation.setTitle + 保存 +
  广播；手动命名优先级最高（自动生成跳过已有 title 的会话）；
- `permissions`/`session_list` 契约同步（session_list 项增 title）。

## 4. @path 输入补全（限 cwd 内）

- **WebUI**：输入框检测光标前 `@<路径片段>` → 调 `/api/fs`（限 cwd 子树）列目录 → 浮层候选
  （Enter/点击插入相对路径，Esc 关闭）；`@` 后片段过滤；
- **TUI**：输入含以 `@` 结尾/`@片段` 时，联想补全列表（与 slash 联想同款机制），数据源为
  `fs.readdir(cwd)`（TUI 进程内直读，限 cwd 顶层 + 目录优先）；选中插入相对路径；
- **边界立法**：补全候选**只列 cwd 内**（与权限作用域一致，cwd 外不提供补全）；@token 仅作
  路径文本插入，不自动展开文件内容（内容展开列为后续可选）。

## 5. 配置说明文档 + 报错指引 + TUI 运行时工具清单

- `docs/config.md`：配置参考——文件位置、全部字段、permission v2 分组形态与锚点作用域表、
  示例（与 0.2.x 对应）；
- 组合根（bin / main-web）加载失败的人话报错追加指引：「配置说明见 docs/config.md（仓库）或
  npm 包页 / 仓库主页」；
- TUI `/config` 工具选择器改运行时清单：app 持有 `tools_list` 状态（tools_list 消息驱动），
  buildEntries 的 selectTool 用它渲染（与 WebUI 对齐，MCP 运行期注册的工具自动出现）。

## 6. 测试策略

| 范围 | 方式 |
|---|---|
| realpath | junction 构造（Windows 免管理员）：逃逸 → ask；正常文件 → 原判定不变；新建文件父目录回退 |
| .gitignore | 纯函数单测：注释/空行/尾斜杠/前导锚定/无斜杠任意层/`!` 取反顺序；walker 集成 |
| 标题 | 生成触发时机（首轮成功/已有 title 跳过/in-flight 去重）、/rename 落库与广播、列表 title ?? preview |
| @path | TUI 联想插入；WebUI 候选过滤（cwd 限制由 fs 端点保证） |
| 回归 | 全量 326+ 测试不回退 |

## 7. 批次

| 批次 | 内容 |
|---|---|
| T1 | realpath + .gitignore（安全与搜索正确性，纯 agent/traverse 域） |
| T2 | 会话标题（契约 + 生成 + /rename + 两端列表） |
| T3 | @path 两端补全 + TUI 运行时工具清单 |
| T4 | 配置说明文档 + 报错指引 + 文档同步（learning/README） |

## 8. 评审轮修订（2026-09-15，实施后 dogfood 与评审驱动）

原设计在评审轮被打磨为最终形态，以下为与上文（尤其 §4 @path「限 cwd 顶层」）的差异，**以本节为准**：

- **@path 逐层下钻**（取代「限 cwd 顶层」）：片段按最后一个 `/` 拆为目录部分 + 名字部分，
  目录部分逐层解析进子目录；候选**全量返回不截断**（目录在前文件在后），滚动由展示层承载
  （TUI 滑动窗口跟随光标 / WebUI 容器 max-height 滚动 + 高亮项 scrollIntoView）；
- **越界双重校验**：目录部分经「词法包含 + realpath 包含」两道检查——`..`/盘符/绝对路径/
  符号链接逃逸一律不提供候选（与权限判定的 realpath 语义对齐）；
- **补全替换语义**：只替换名字部分（`replaceStart`），保留已输入的目录前缀
  （`@src/ut` + `util.ts` → `@src/util.ts`，而非从 `@` 起整段替换）；
- **补全终结规则**：@token 恰好指向已存在的**文件** → 弹框自动关闭（文件没有下一层可下钻）；
  目录（含尾 `/`）继续列出子层；
- **弹框治理**：Esc 关闭弹框（显式 dismissed 状态，输入一变即恢复）；TUI 补全后光标跟到新值
  末尾（multiline-input 区分内部编辑与外部替换）；联想光标输入一变即复位（斜杠联想与 @path
  共用 cursor，残留选中会让回车误补全而非提交）；
- **弹层语义立法（响应 vs 推送）**：`session_list` / `permissions_list` / `tools_list` 的**推送只更新
  数据不弹层**；弹层只由显式命令的响应打开（/session 先开空壳选择器、响应填充；删除会话后同法
  重建）；`tools_list` 的面板打开用**独立 intent 标志**——后台播种（挂载 + config_updated）不与
  /context 等共享 explicitInfoRef（防播种响应误消费显式标志）；
- **标题回执与竞态**：/rename 与自动标题完成都发 notice（两端对话流可见）；空标题守卫；
  自动标题**写回前再查标题**——生成期间 /rename 手动命名已落则丢弃自动结果（手动任何时刻优先）；
  标题调用 maxOutput 512——ChatRequest 无 reasoning 开关，推理模型的思考 token 计入该预算，
  给 64 会被思考烧光致 content 为空（静默失败、notice 永不出现）；notice 的迟到即 LLM 往返延迟；
  标题长度上限 32 字（提示词与清洗截断一致）；WebUI 下行链路有 SSE 端到端测试实证 notice 无过滤
  （server/test/channel/sse-e2e.test.ts）——若现象与测试结论矛盾，优先排查运行中的后端进程是否为旧代码；
  **TUI 底部状态栏显示会话名**（🔖 槽位：标题优先、超长截 24、无标题回退短 sessionId）——标题经
  session_list 同步（启动播种 + /session 响应 + 重命名 + 自动标题 + session_ready 后重拉，零契约改动）；
  静态 TopBar 只在挂载/重挂载打印一次，故不承载实时会话名；
- **删除当前会话 → 立即切换新会话（不落盘）**：内存旧工作集必须被替换，否则下一轮落盘会把刚删
  的会话原样写回（「复活」bug，评审轮发现）；替换出的新会话**首次对话才持久化**（newSession
  persist=false）——立即落盘的空会话会把刚删空的项目又撑成非空，WebUI 的删除项目会被它挡住；
- **/cd 成功即落盘 + 重推 session_list**：侧栏项目树按会话文件的 cwd 分组，切换目录不即时保存的
  话新项目要等下一轮对话落盘才出现；
- **WebUI 会话命名闭环**：信息面板 Status 卡显示当前会话名（无标题回退截短 sessionId）+ 铅笔按钮；
  输入框无参 `/rename` 与命令面板执行 `/rename` → 同一个 prompt 编辑弹框，预填侧栏显示的原名
  （标题优先、无标题回退预览文本；空值确认即取消，带参 `/rename <名称>` 保持直改语义）；命令面板 `/cd` → 与输入框一致弹出路径选择器；
- **配套测试**：标题竞态（可挂起伪 client）、删除当前会话不复活、handlePathSuggestKeys 按键层、
  title 快照往返与旧格式兼容、@path 逐层/越界/文件终结/全量候选。
