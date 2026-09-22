# 11-TUI架构

终端界面（`ui/src/tui/`）：Ink 渲染 + 「视图态联合类型 + 按键分派」为核心的弹层体系。

## 渲染分层（立法）

- **Static 区**：品牌头 + 已完成的消息块——`<Static>` 打印一次即进终端原生滚动缓冲（历史用终端滚动看，Ink 不重绘）。
- **动态区**：未完成块、流式输出、输入框、状态栏、全部弹层——Ink 每帧重绘。
- 会话切换/清空/折叠切换 → 换 Static key 触发清屏重绘。

## 视图态与按键路由

- `view-state.ts` 的 `View` 联合类型是弹层体系的唯一状态：none / permission / menu / sessionPicker / prompt / skills / mcp / config / info / form。
- `app/use-key-routing.ts` 按 `view.kind` 分派到 `features/*/keys.ts` 的纯逻辑处理器（api 注入 spy 可单测）；全局拦截（Ctrl+C）最优先。
- **ref 镜像立法**：useInput 回调读 state 拿旧值——凡按键层需要的状态（view/config/entries/游标）都走 ref 镜像。
- **returnView 立法**：menu/info/form/prompt 弹层携带 returnView——面板内钻入的弹层 esc 回来源视图，不存在「一次 esc 丢整个面板层级」。

## 配置树（features/config）

- `buildEntries(config, path, treeCtx, tools)` 纯函数：给定配置与路径产出当层条目（Entry 联合：scalar/prompt/bool/goto/action）——**渲染与按键共用同一份 entries**（按键层复用渲染层结果，杜绝两处 build 漂移）。
- ConfigPath 联合类型描述钻取层级；esc 沿 parentPath 逐级回退。

## 表单（features/form）

- 通用多字段表单视图：字段（文本/选项/只读）+ 保存行；Enter 编辑文本（prompt 弹层，returnView 回表单）/ 循环选项；s 或保存行提交；校验失败留在表单。/mcp 与 /skills 共用。

## 数据装配

- `use-agent-events`：订阅 port 消息 → 更新镜像（config/tools/skills/mcp/status）+ 驱动弹层开合（intent 标志区分显式请求与后台播种）。
- 消息处理读 state 走 ref；发消息走 `port.post`。
