# DogEggAgent 用户手册

本模块是日常使用的操作说明。

| 文档 | 内容 |
|---|---|
| [README.md](./README.md) | 快速开始：安装、启动、首次配置 |
| [01-配置指南](./01-配置指南.md) | config.json 全字段说明、项目级配置、格式演进 |
| [02-命令参考](./02-命令参考.md) | 斜杠命令全表、权限四档决策 |
| [03-TUI使用](./03-TUI使用.md) | 终端界面操作详解 |
| [04-WebUI使用](./04-WebUI使用.md) | 浏览器界面操作详解 |

## 快速开始

### 1. 启动

两种形态，共享同一套配置与会话：

```bash
dogegg        # TUI（终端界面）
dogegg -web   # WebUI（浏览器界面，默认 http://localhost:3001）
```

开发态（仓库内）：

```bash
npm install
npm run dev       # 构建 + TUI
npm run dev:web   # 前后端热更 + WebUI
```

### 2. 首次配置

启动后输入 `/config`（TUI）或点击右上角设置（WebUI）：

1. **Models** → 添加 provider：填 `name`、`baseURL`（如 GLM 的 `https://open.bigmodel.cn/api/paas/v4`）、`apiKey`，并在其下添加模型（填 `name` 与 `contextWindow`）；
2. 把 `defaultProvider` / `defaultModel` 指向刚配的项；
3. 回到主界面直接对话。

不配置 provider 也能启动——对话入口会提示先配置。

### 3. 常用入口

- `/mcp` 管理 MCP 服务器（配好后它的工具自动进入模型可用清单）；
- `/skills` 管理技能包（`/技能名` 即可调用）；
- `/permissions` 查看与撤销本会话内的「始终允许」授权；
- 工具执行前的审批弹层选「始终允许」可免去同类操作反复确认（详见 02-命令参考 的权限决策）。

### 4. 升级注意

配置格式演进**不做旧版兼容**：升级后若启动报「配置加载失败」，按报错指明的字段对照 [01-配置指南](./01-配置指南.md) 修改，或整段删除 `permission` 字段回退出厂默认后经 /config 重配。
