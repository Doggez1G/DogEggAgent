# R-WEB WebUI交互

浏览器界面（React + Vite，SSE 通道）：与 TUI 共享同一 agent 与消息契约，是同一能力的双端呈现。

## 需求点

- **R-WEB-01 聊天区**：markdown 渲染、工具调用块（折叠/展开、状态与权限徽章、diff/输出精修）、流式双通道、审批横幅（四档决策 + 范围提升）。
- **R-WEB-02 设置弹框**：五区——General（systemPrompt/迭代/解释器/主题）、Models（provider/model 增删改）、Permissions（三桶卡片：整选开关、模式 chips、服务键勾选细化）、MCP Servers（全局/项目分组、状态卡片、CRUD/启停）、Skills（两组列表、创建表单、启停/清理/编辑/删除）。
- **R-WEB-03 信息面板**：右侧可折叠面板——Status & Model、Context（分段/用量/压缩）、Tool Calls、Files Touched、**Available Tools（按来源分组：系统工具 + MCP 服务可展开组，内部短名 + 权限徽章）**、Session Permissions（可撤销）、System Prompt（全文滚动）、Log Tail。
- **R-WEB-04 斜杠联想**：输入 `/` 弹命令与 skill 动态命令联想（停用/缺失的 skill 不出现），上下选择高亮项自动滚入可视区。
- **R-WEB-05 Cmd+K 命令面板**：快速跳转设置各分区与常用操作。
- **R-WEB-06 会话侧栏**：按项目分组的会话树（标题/时间/预览），新建/切换/删除，项目遗忘。
- **R-WEB-07 通道**：SSE 下行（多标签页共享同一 agent 事件流）+ POST 上行；消息经 zod schema 校验，非法丢弃。
- **R-WEB-08 目录浏览器**：/cd 与工作目录选择联动（文件系统浏览器弹框）。
- **R-WEB-09 双端对称**：TUI 与 WebUI 的管理操作（配置/MCP/Skills/权限）走同一套 agent 消息，能力对等、无各自后端。

## 边界与立法

- WebUI 是静态资源被 server 托管——server 包只做通道与静态服务，不 import UI 包。
- 主题系统与 TUI 同源 token（dawn/forest/midnight），Light/Dark 独立切换。
