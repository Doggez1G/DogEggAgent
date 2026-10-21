# 0.2 版本文档

本目录是 DogEggAgent **0.2 版本**的完整文档集。每个模块一个文件夹，文件夹内是多份独立文档。

| 模块 | 内容 | 读者 |
|---|---|---|
| [01-需求分析](./01-需求分析/README.md) | 功能点全景 + 每个功能域的需求拆解与验收行为 | 所有人（理解"有什么"） |
| [02-设计实现](./02-设计实现/README.md) | 架构总览、各子系统设计要点、ADR 索引、交互图 | 贡献者（理解"怎么做的"） |
| [03-用户手册](./03-用户手册/README.md) | 配置指南、命令参考、TUI/WebUI 使用说明 | 用户（理解"怎么用"） |
| [04-学习指南](./04-学习指南/README.md) | 逐模块详解，按学习路径组织的源码导读 | 想深入源码的学习者 |

## 阅读建议

- 只想用起来：读 03-用户手册。
- 想知道"它应该做什么"：读 01-需求分析。
- 想改代码 / 排查问题：01 → 02 → 04。
- 跨版本语义决策（为什么这样设计）见 [`docs/adr/`](../../adr/)；历史设计文档见 [`docs/superpowers/specs/`](../../superpowers/specs/)（部分已被 ADR 修订，见各自头部标注）。

## 版本约定

- 配置格式演进**不兼容**：旧格式加载报错并指引本文档（见 03-用户手册/01-配置指南 的「格式演进」）。
- 本目录内容与 0.2 代码同步（含 2026-10 稳定性批次）；0.1 无归档文档。

## 发布与安装

- npm 包：`npm install -g dogegg-agent`（包内容 = dist/dogegg.js 统一 CLI + dist/web 静态前端，`prepublishOnly` 自动构建）；
- 源码运行：clone 后 `npm install`，`npm run dev`（TUI）/ `npm run dev:web`（WebUI）；
- 环境要求 Node ≥ 20.11；CI 门禁（windows-latest）跑 typecheck + 全量测试。

## 0.2.0 更新摘要（稳定性批次）

- **持久化原子写统一**：config.json / 会话 / .skills.json / .mcp.json / write_file / edit_file 全部 tmp+rename，中断不再损坏文件；config 写坏给出人话恢复指引而非启动死锁。
- **检查点配对修补**：轮中检查点落盘前与会话加载后都会补齐未配对 tool_calls（`bridge/contract/message-pairing` 纯函数）——长任务中途崩溃，恢复后下一轮立即可用，不再必吃一轮 API 400。
- **Windows 平台正确性**：cmd 改 verbatim 引号形态（含引号命令不再被错拆）、检测并剔除 WSL 冒名 bash、read_file 二进制探测与 BOM 剥离、权限路径大小写归一（win32）。
- **引擎防卡死收口**：emit 链路异常不再造成 gate 永久 busy；maxOutput=-1 正确省略 max_tokens；轮中标题/重命名不再回退检查点。
- **恢复链补全**：运行中断线重连/新标签接入可恢复流式现场（partial + 进行中工具块）。
- **MCP 健壮性**：connect/listTools 30s 启动超时（坏配置不再阻塞整条 rebuild 链）、rebuild 与轮次互斥、同名服务加载期拒绝。
- **优雅退出**：SIGINT/SIGTERM 触发 dispose——取消运行轮 → 停全部 MCP 子进程 → 会话落盘。
- **双端交互修复**：WebUI 命令面板不再误杀后端、主题 token 补齐、保存失败可见反馈、权限横幅键盘/读屏可达；TUI 工具块不再固化、运行中提交防丢、键位修复。
