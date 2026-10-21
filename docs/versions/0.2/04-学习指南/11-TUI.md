# 11-TUI

TUI 是渲染到终端的 React 应用（Ink 7），入口 `ui/src/tui/app/entry.tsx` 的 `renderTui(uiPort)`（由 `bin/dogegg.ts` 调用；entry 还负责清屏 `clearScreen()` 与 SIGINT 计时的 `resetSigintTimer`）。四个 app 级 hook 各管一域：`use-chat.ts`（聊天数据，消费 `ui/src/shared/reducer.ts`）、`use-agent-events.ts`（消息 → 视图效应）、`use-key-routing.ts`（键盘分派）、`app.tsx`（装配 + 布局）。

## 组件一览（ui/src/tui/components/）

`components/index.tsx` 统一出口：`TopBar`（品牌头：provider/model + cwd + 会话 id）、`MessageBlock`（已完成块：按 `block.kind` 折叠/展开渲染，思考块黄色摘要）、`MultilineInput`（Enter 发送 / Ctrl+J 或 Alt+Enter 换行，`multiline-input/view.tsx` 是 Ink useInput 的受控封装；Ctrl 组合键一律吞掉——Ink 会把 Ctrl+A/U/W 等解析成普通字母误插入文本，Delete 键独立为前向删除、与 Backspace 回删语义拆分）、`StreamingBlock`（动态区的流式 partial：正文走 `renderMarkdown`）、`PendingTool`（`tool_pending` → `tool_start` 空窗期的「正在生成工具调用…」提示）、`StatusBar`（底部常驻：状态/provider/model/tokens/usage/cwd）。`components/list-picker/` 是通用列表选择器（menu 的底层）。

## 浏览模式（Ctrl+Up/Down）

`app.tsx` 维护 `browseIdx`（块焦点索引，ref 镜像 + state 双份）。进入后输入框失焦（`focus={browseIdx === null}`），`ui/src/tui/features/browse/keys.ts` 处理块间移动，Enter 切换该块的折叠/展开（`expandedRef` 的 Set），底部出现 `ui/src/tui/features/browse/view.tsx` 的 `BrowseStatusBar` 显示「第 N/总 块 + 摘要」。这是纯前端能力——不向后端发任何消息。

## App 装配与 Static/动态分层

`ui/src/tui/app/app.tsx` 头注释立法：**已完成的消息块经 `<Static>` 打印进终端滚动缓冲区**（永不重绘，用户用终端原生滚动看历史）；Ink 只重绘底部动态区（未完成块 + 流式 partial + 输入框 + overlay + 状态栏）。分界线是 `stableCount`：按**块状态**冻结——找到第一个 `toolStatus === 'running'` 的工具块，它及其后到达的块（运行中插入的 notice 等）留在动态区，之前的全部打印（`chat.toolActive` 仍保留为「是否有工具在跑」的整体语义与终止分支的防御复位对象）。`staticKey` 控制重挂载——会话切换/清空/折叠展开/主题切换时 `clearScreenRemount()`（清屏 + key 自增）。品牌头延迟打印（`headerReady`）：Static 只渲染一次，启动瞬间 config/status 未回，先打印会定格在「加载配置中…」。

`ui/src/shared/reducer.ts` 是两端共用的聊天状态机：`ChatState { blocks, status, partial, toolActive, pendingTool, nextId? }`——`nextId` 是块 id 分配器（所有新建块统一经 `allocId`/`appendBlock` 取单调递增 id，WebUI 拿它作 React key）；`text_delta` 累积进 partial，`message` 事件 flush 落块；思考块折叠存摘要（超 3 行追加「…（浏览模式 Enter 展开）」）、全文进 `full` 供展开；`session_ready` 重建块从 `state.nextId` 续起，busy 时携带的 `live` 现场恢复流式 partial 与进行中工具块（运行中重连不被打回 idle）。

## view-state 联合类型与 use-key-routing 分派

`ui/src/tui/view-state.ts` 的 `View` 是 UI 自己的视图态（**与后端 10 态状态机正交**）：`none / permission / menu / sessionPicker / prompt / skills / mcp / config / info / form` 十种 kind，各自携带数据与光标。

`ui/src/tui/app/use-key-routing.ts` 的 `useKeyRouting()` 只做分派不做判断：Ctrl+C 全局拦截（运行中发 cancel、空闲弹退出确认）→ `switch (view.kind)` 分派给 `features/*/keys.ts` 的 `handleXxxKeys(v, key, inputChar, api)`。**features/*/keys 是纯逻辑模式**：每个 handler 是接收「视图 + 按键 + 注入 api（post/setView/openEditor…spy 可换）」的纯函数，不 hook 不渲染——可单测（`ui/test/tui/keys.test.ts`）。`none` 态按优先级依次尝试：联想 → @path 联想 → 浏览（Ctrl+Up/Down 块间移动焦点）→ 输入历史。

## ref 镜像教训

`app.tsx` 里大量 `xxxRef = useRef(x)` + effect 同步的模式（viewRef/configRef/statusRef/blocksRef/configEntriesRef…），头注释写明原因：**Ink 的 `useInput` 回调闭包会过期，读 state 拿到的是旧值，必须走 ref**。这是本包最重要的实战教训——`use-key-routing.ts` 的 `KeyRoutingDeps` 接口干脆全部声明为 `{ current: T }` 的 ref 形状。WebUI 侧同款问题见 `ui/src/webui/features/turn-tracking/use-turn-tracking.ts` 的 `pendingRef` 注释。

## intent 标志：区分「响应」与「播种」

`use-agent-events.ts` 是消息 → 视图副作用的订阅域（`permission_request` 开权限 overlay、`session_ready` 清屏重挂 + 重拉列表、`error` 回填上次提交文本…）。难点：同一 `tools_list`/`config_state` 消息既可能是命令响应也可能是后台广播。解法是 **intent 标志**：`explicitInfoRef`（/context /status 等显式请求才开 info overlay，轮询静默）、`toolsIntentRef`（工具面板只由显式 /tools 打开——tools_list 有挂载/config_updated 播种，共享标志会误消费）、`configIntent`（区分 /model 与 /config 该开哪个选择器）。

订阅本身只建立一次（`const ref = useRef(deps)` + effect 同步，头注释警告「重复建立会反复重发 config_request/status_request」）。`session_list` 的消费规则也在此：选择器已开才刷新（保留搜索词与光标）；重命名/自动标题等后端主动推送不带弹层语义——「响应只刷新已开面板」。

## 提交流程的拦截层（app.tsx 的 handleSubmit）

1. **@path 联想拦截**：输入末尾有 @token 且选中候选时，回车 = 补全路径而非提交（Esc 关闭后不拦截，`pathDismissed`）；
2. **斜杠联想拦截**：`matchCommands` 有匹配且选中项时，回车 = 补全命令；
3. **命令确认与分支**：`parseCommand` 返回 `unknown`（斜杠开头但非内置也非 skill 命令，如 `/etc/hosts` 这类提问）时显式插 notice「未知命令」并**保留输入**——不静默吞掉；/clear 与 /quit 先弹确认 menu（不可逆操作）；/model /config 置 `configIntent`；/session /skills /mcp 先开空壳面板等响应填充。所有会开 overlay 的命令统一 `suppressEnter()` 吞掉提交回车——port 是同步通道，agent 回响应可能立即设新 view，不吞的话同一个回车会在新 view 里被再处理一次（误选中第一项）。
4. **运行中提交禁止**：普通文本在 `isRunningState(chat.status)` 时拒绝发送——插一条 notice 块提示并保留输入框原文（agent 侧 busy 会丢弃 submit，乐观插入只会变成一条永远得不到回应的消息）。

## config 树 buildEntries

`ui/src/tui/features/config/` 是配置编辑器：`navigation.ts` 的 `ConfigPath` 描述树位置，`entries.ts` 定义 `Entry` 五形态（scalar/prompt/bool/goto/action）与 `TreeCtx`（set/add/remove 三入口 + openSkills/openMcp），`build.ts` 的 `buildEntries(config, path, ctx, tools?)` 按 path 生成当前层条目——root 层 11 项、permission 三桶层、`permissionTool` 细化层（whole 开关 / MCP 服务键勾选式细化，勾选数据来自 tools_list 镜像的运行时身份枚举）。渲染层算好的 entries 存 `configEntriesRef` 给按键层复用（杜绝两处 buildEntries 漂移）。所有变更翻译成 `config_set/add/remove` 消息——见 05-配置系统。表单视图（`ui/src/tui/features/form/`）服务 /mcp、/skills 的新建编辑：一行一字段，`options` 字段 Enter 循环切换，文本字段 Enter 弹 prompt；`returnView` 支持面板间的 esc 层级回退（2026-09 提交 5b5f4ea）。

## 覆盖面板与 features 目录

`features/` 下每个文件夹一个面板/能力，普遍是 `view.tsx`（渲染）+ `keys.ts`（纯逻辑）+ `index.ts`（出口）三件：`permission/`（四档决议 overlay，`decisions.ts` 统一组装决策项与文案——scoped 档带 desc 说明「shell 类范围含该前缀的一切命令（含 && 命令链）」）、`sessions/`（会话选择器，`filter.ts` 做查询过滤，退格键兼容 Ink 7 的 `key.backspace`）、`menu/`（通用菜单）、`prompt/`（标量输入弹层——复用组件层的 `MultilineInput` 而非 ink-text-input，两端按键语义一致）、`info/`（/help /context 等只读面板）、`skills/` 与 `mcp/`（管理面板）、`input/`（联想与历史）、`browse/`、`form/`、`config/`。`markdown/render.ts` 用 highlight.js 做代码高亮转换（ADR-0009 决定不用 chalk 覆盖高亮级别）。

## 主题

`ui/src/tui/theme/registry.ts` 的 `ThemeRegistry` 是当前主题的唯一可变持有者（显式实例 `themeRegistry`，替代旧模块级 let 单例；`onChange` 订阅驱动清屏重挂与 React 重渲染）。调色板定义在 `palette.ts`（THEMES 表），`token-map.ts` 提供块类型 → 图标/色的语义映射（`KIND_ICON`/`TOKEN_COLOR`/`KIND_ROLE`——块的颜色按语义角色而非消息类型）。兼容层 `palette` 是个 Proxy——读取时透传 `themeRegistry.palette`，组件零改动。主题切换走 /config 树的 `selectTheme`（`build.ts` 里 `themeRegistry.list()` 枚举），ADR-0009 记录了「不用 chalk 级别覆盖」的决策。

```ts
// ui/src/tui/theme/registry.ts（兼容读取层）
export const palette: Palette = new Proxy({} as Palette, {
  get(_target, prop: string) { return themeRegistry.palette[prop as keyof Palette] },
})
```

## 与 WebUI 的分工边界

TUI 独有的部分：Static 分层（终端缓冲区特性）、raw mode 与 `$EDITOR` 阻塞编辑、@path 联想、浏览模式。与 WebUI 共享的部分：reducer/commands/tool-display/status/permission（`ui/src/shared/`）。读完本章建议把 `ui/test/tui/keys.test.ts` 与 `ui/test/shared/reducer.test.ts` 对着 features/*/keys.ts 跑一遍——纯逻辑模式的可测性是这套结构最大的收益。

## 其他值得读的文件

`ui/src/tui/markdown/render.ts`（markdown → 终端纯文本，Static 渲染一次无性能压力）、`ui/src/tui/components/multiline-input/view.tsx`（Enter 发送 / Ctrl+J 换行的多行输入）、`ui/src/tui/features/input/path-suggest.ts`（@path 联想：`matchPathToken`/`applyPathCompletion`，仅 cwd 内提供候选）。

> 与 WebUI 的对称性：同一契约、同一 reducer（`ui/src/shared/`），见 12-WebUI 末节对照表。
