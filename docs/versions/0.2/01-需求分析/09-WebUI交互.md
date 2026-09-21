# R-WEB WebUI交互

浏览器界面（React + Vite，SSE 通道）：与 TUI 共享同一 agent 与消息契约——同一能力的双端呈现，管理操作走同一套 agent 消息，无各自后端。

## 需求点

### R-WEB-01 聊天区

- 用户/助手消息 markdown 渲染；工具调用块：状态图标（执行中旋转/完成/失败/拒绝）、**权限徽章**（配置放行 ALLOW / 会话提升 ALWAYS / 待审批 ASK / 被拒 REJECTED，判定注入工具身份镜像——MCP 服务键规则在徽章上正确生效）、折叠/展开。
- 展开按工具精修：命令与输出分层、edit_file 渲染 diff 带真实行号。
- 流式双通道：正文实时渲染，思考内容折叠呈现。
- ask 调用弹出审批横幅：四档决策（本次/始终/范围/拒绝），范围模式自动推导。

### R-WEB-02 设置弹框（五区）

- **General**：systemPrompt、maxIterations、maxRetries、shellProgram（下拉带本机扫描校验与版本标注）、主题。
- **Models**：provider/model 增删改（name/protocol/baseURL/apiKey/models 逐字段），默认模型选择。
- **Permissions**：三桶折叠卡片——每条规则含整选开关（whole）、模式 chips 就地改名/删除、MCP 服务键**勾选细化**（该服务运行时工具清单勾选 + 通配 chips + 添加）、添加下拉（MCP 服务整组 + 内建工具，排除已有）。
- **MCP Servers**：全局/项目分组，状态卡片（状态点 + 名称 + 传输/状态徽章 + 工具数 + 错误行），启停/编辑（表单：类型/名称/command/args/env 或 url/headers）/删除确认。
- **Skills**：项目级/用户级两组列表，创建表单（落点/名称/描述），启停按钮，**缺失态清理**，编辑（全文编辑框），删除确认。

### R-WEB-03 信息面板（右侧可折叠）

- 八个可折叠卡片：Status & Model（状态 pill/会话名/模型）、Context（进度条 + 分段统计 + 三口径用量 + 压缩计数）、Tool Calls（序号/状态/名称/权限徽章，校验失败提示带回退）、Files Touched、**Available Tools（按来源分组可展开：系统工具默认展开 + MCP 服务组默认收起，行内内部短名 + 权限徽章）**、Session Permissions（可撤销）、System Prompt（全文内部滚动）、Log Tail。
- 面板展开时自动播种数据请求；对话进行中 context 每 3s 刷新。

### R-WEB-04 斜杠联想

- 输入 `/` 弹联想：内建命令 + skill 动态命令（停用/缺失不出现）；↑↓ 选择高亮项自动滚入可视区；回车路由执行。

### R-WEB-05 Cmd+K 命令面板

- 快速打开设置各分区、常用操作（新会话/清空等）。

### R-WEB-06 会话侧栏

- 按项目分组会话树（标题/更新时间/预览），新建/切换/删除（确认）；项目遗忘（删光其下会话即消失）；标题同步。

### R-WEB-07 通道

- SSE 下行（`/api/events`，多标签页共享同一 agent 事件流）+ POST 上行（`/api/message`，zod 校验非法丢弃）。
- server 只做通道与静态托管，不含业务逻辑（架构立法）。

### R-WEB-08 目录浏览器

- /cd 与工作目录选择器联动：文件系统浏览弹框，选择即切换（技能/MCP 扫描根、权限锚点、工具 cwd 全部随动）。

### R-WEB-09 双端对称

- TUI 与 WebUI 的配置/MCP/Skills/权限管理能力对等（同一套消息契约）；任一端的功能差异视为缺陷。
- 主题三套（dawn/forest/midnight）× 明暗两态，与 TUI token 同源。

## 边界与立法

- WebUI 是静态资源被 server 托管——前端构建产物进 dist/web，不 import server 包。
- 多标签页同时连接属预期（观察者模式）：任一标签的会话操作对所有标签可见。
