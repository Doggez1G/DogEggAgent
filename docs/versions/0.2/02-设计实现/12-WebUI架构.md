# 12-WebUI架构

浏览器界面（`ui/src/webui/`）：React + Vite + CSS Modules，SSE 通道对接 agent。

## 分层

- **app/app.tsx**：装配层——数据域 hooks + 布局（会话侧栏 / 聊天区 / 信息面板 / 设置弹框 / 输入栏 / 目录浏览器）。
- **features/**（数据域 hooks，按域拆分）：`chat`（消息块流）、`info-panel/use-panel-data`（面板八卡数据）、`sessions`（会话列表）、`skills/use-skills`（技能联想池，过滤停用/缺失）、`turn-tracking/use-turn-tracking`（工具调用生命周期 + 权限决策关联 + 身份镜像）。
- **components/**：chat-view（消息渲染与工具块）、input-bar（输入 + 斜杠联想 + @path）、info-panel（八卡）、settings（五区 + 弹框）、sidebar、command-palette、primitives、confirm/fs-browser/prompt 弹框。
- **shared/**（`ui/src/shared/`）：TUI/WebUI 共享的平台无关逻辑——reducer（消息 → 块状态）、命令解析、权限展示、状态标签、工具展示。

## 数据流

- SSE 下行（EventSource `/api/events`）→ 消息经 zod 校验 → 分发到数据域 hooks → setState → 渲染。
- 上行 `port.post(...)`（fetch POST /api/message）。
- 数据域各自订阅 port（多订阅合法），卸载退订；会话切换时各域清理/重播种。

## 与 TUI 的对称

- 管理操作（配置/MCP/Skills/权限）发同一套消息（config_set/skills_manage/mcp_manage/permission_*），agent 侧无端感知。
- 展示层共享 `ui/src/shared/`（权限徽章判定、命令解析、状态标签）；界面形态各自实现。
