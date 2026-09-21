# R-TUI TUI交互

终端界面（Ink）：已完成内容打印进终端滚动缓冲区（Static），底部动态区承载输入与弹层。键盘是第一交互方式。

## 需求点

- **R-TUI-01 命令集**：`/help /config /model /mcp /skills /permissions /new /rename /cd /compact /context /status /system /log /tools /quit`——斜杠联想（含 skill 动态命令）、Tab 补全、上下历史召回。
- **R-TUI-02 /config 配置树**：树形编辑器（root → permission/providers/... 逐层钻入）——标量输入、布尔切换、枚举选择、增删条目；**selectTool 选择即钻入**（选中工具/服务直接落到细化层）。
- **R-TUI-03 权限细化编辑**：桶内条目 → 整选开关（whole）+ 模式行就地编辑/删除 + 添加模式；服务键整选/按勾选两态，勾选清单来自运行时工具身份。
- **R-TUI-04 表单视图**：/mcp、/skills 的新建与编辑为一屏多字段表单——Enter 编辑文本/循环选项、s 或保存行提交、校验失败留在表单（已填内容不丢）、esc 回列表不保存。
- **R-TUI-05 弹层层级**：菜单/信息/审批弹层支持 returnView——面板内钻入的详情与确认菜单 esc **回到来源视图**而非退出设置；来源为主屏时 esc 关面板。
- **R-TUI-06 审批层**：ask 调用弹四档决策层；范围提升自动推导范围模式并随会话存档。
- **R-TUI-07 @path 联想**：输入 `@` 触发文件路径补全（cwd 内，目录优先，逐层下钻），Tab/回车补全。
- **R-TUI-08 浏览模式**：Ctrl+↑↓ 在历史块间移动焦点，Enter 折叠/展开工具块。
- **R-TUI-09 状态栏**：常驻底部——状态机、provider/model、会话名、token 用量、cwd、git 分支。
- **R-TUI-10 主题**：多主题注册表（dawn/forest/midnight…），/config 内切换即时生效。
- **R-TUI-11 工具块折叠**：工具调用块可折叠/展开，展开按工具精修（命令/输出分层、diff、行号）。

## 边界与立法

- 键盘路由按 view.kind 分派到各 feature 的 keys 处理器（纯逻辑可测）；视图态是 UI 私有状态，与后端状态机正交。
- 面板内弹层 esc 永远先回来源视图，不可能因一次 esc 丢失整个设置面板的层级。
