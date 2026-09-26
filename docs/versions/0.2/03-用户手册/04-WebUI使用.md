# 04-WebUI使用

浏览器界面（`dogegg -web` 启动，默认 http://localhost:3000，可用 `PORT` 环境变量覆盖）。布局：左侧会话侧栏、中间聊天区、右侧信息面板、顶部工具条（设置齿轮、Cmd+K）。

## 聊天区

- 底部输入框提交消息；回复流式渲染（思考内容折叠）。
- 工具调用块：状态图标 + 权限徽章（ALLOW/ASK/ALWAYS/REJECTED）；点击展开看输出/diff（edit_file 带真实行号）。
- ask 工具弹出**审批横幅**（聊天区内）：四档决策——本次允许 / 始终允许 / 对此范围不再询问 / 拒绝。
- 出错自动回填输入重试。

## 设置弹框（右上角齿轮或 /config）

顶部侧栏切换五区：

- **General**：systemPrompt、maxIterations（-1 无限）、maxRetries、shellProgram（下拉带本机扫描）。
- **Models**：provider 列表 → 展开编辑（name/protocol/baseURL/apiKey）+ models 子列表（name/contextWindow/maxOutput/reasoning）；添加后把 default 指向它。
- **Permissions**：三桶折叠卡片。每条规则：整选开关 chip（✓ Whole tool / · 按模式）、模式 chips（点击改名/×删除）、添加输入框。MCP 服务键规则展开为**勾选 chips**（该服务运行时工具清单）+ 通配 chips。添加下拉分两组：MCP 服务（整组生效）+ 内建工具。
- **MCP Servers**：全局/项目两组状态卡片（状态点 + 名称 + 传输/状态徽章 + 工具数）；启停/编辑（表单）/删除（确认）；「+ 新建 MCP server」表单（类型/名称/command/args/env 或 url/headers）。
- **Skills**：两组列表（/名 + 描述 + 启停按钮 + 编辑/删除）；缺失条目灰显带「清理」；「+ 新建 skill」表单。

所有编辑即时生效（配置写盘 + 广播刷新）；校验失败红色提示且不落盘。

## 信息面板（右侧）

八张可折叠卡片：

- **Status & Model**：状态 pill、会话名（铅笔重命名）、provider/model。
- **Context**：用量进度条 + 分段统计（System/User/Assistant/Tool output/Tool schemas）+ 上轮实际 + 会话累计 + 压缩次数。
- **Tool Calls**：本轮全部工具调用（序号/状态/权限徽章）。
- **Files Touched**：本次会话改动过的文件（edit/write 标注）。
- **Available Tools**：**按来源分组可展开**——系统工具（默认展开）+ 各 MCP 服务组（默认收起，标注工具数）；行内显示内部短名 + 权限徽章，悬停看完整注册名。
- **Session Permissions**：本会话提升列表，× 撤销（整工具或单条模式）。
- **System Prompt / Log Tail**：全文内部滚动。

## 会话侧栏（左侧）

- 按项目分组会话树：标题（铅笔重命名）、更新时间、预览。
- 顶部新建会话；条目悬停删除（当前会话删除后自动开新会话接管）。
- 项目头部可「遗忘」（删除该项目下全部会话）。

## 其它

- **Cmd+K**：命令面板——快速打开设置各分区与常用操作。
- **目录浏览器**：/cd 与工作目录选择器联动，可视化选择工作目录。
- **斜杠联想**：输入 `/` 弹命令与技能命令（↑↓ 选择自动滚入可视区）。
- **多标签页**：可同时开多个标签共享同一 agent——任一标签的操作（配置/会话）全局可见。
- **主题**：三主题（Midnight / Forest / Dawn）——在**左侧栏底部**的色板切换（非设置弹框），Cmd+K 命令面板亦可切换。
