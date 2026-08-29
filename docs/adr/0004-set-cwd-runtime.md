# 运行时 Cwd 切换：set_cwd 消息

扩展 bridge 契约新增 `set_cwd` 消息类型，支持运行时变更 Agent 工作目录。Agent 的 `private cwd` 改为可变，新增 `setCwd()` 方法验证路径后更新；ToolContext 每次从 `this.cwd` 构建（已验证的 per-call 机制），工具代码无需改动。TUI 的 `/cd` 命令与 WebUI 的目录选择 UI 共用同一消息。同时给 TUI 增加此前缺失的目录切换能力。
