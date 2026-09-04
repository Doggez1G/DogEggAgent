# 11 · WebUI 前端

WebUI 是浏览器前端，基于 React DOM + Vite + CSS Modules。通过 SSE 下行 + POST 上行与后端 Agent 通信，静态文件由 server serve。为后续套 Electron 成为桌面产品铺路。

## 目录结构

```
ui/src/webui/
├─ index.html                    # Vite 入口，<html data-theme="midnight">
├─ main.tsx                      # React DOM render 入口
├─ app/
│  ├─ app.tsx                    # App 根组件：grid 布局 + state + onMessage + 模态层
│  └─ view-state.ts             # ThemeName + Modal 类型 + COMMAND_TO_MODAL + SessionItem
├─ components/                   # 17 个组件，每个 module=folder（view.tsx + index.ts + .module.css）
│  ├─ sidebar/                   # 品牌 + 搜索 + 项目/会话树 + 设置 + 主题切换
│  ├─ top-bar/                   # 运行状态 + 模型/cwd chip + 连接状态 + Cmd+K 入口
│  ├─ chat-view/                 # 消息列表 + MarkdownRenderer + 空状态 + 自动滚动
│  ├─ message-block/            # kind 分化渲染（user/assistant/thinking/tool/error/notice）
│  ├─ markdown/                  # react-markdown + rehype-highlight + 代码块复制按钮
│  ├─ input-bar/                 # textarea auto-grow + 斜杠命令联想 + 输入历史 + 快捷菜单
│  ├─ settings/                  # IDE 风格左导航 + 右内容区（General/Models/Permissions）
│  ├─ info-panel/                # 8 个可折叠 InfoCard + 数据请求 + 高亮
│  ├─ command-palette/           # Cmd+K 模糊搜索 + 键盘导航
│  ├─ error-boundary/            # 分区包裹 + 全局兜底，渲染异常不白屏
│  ├─ modal-portal/              # 通用 Modal 容器（role=dialog + focus trap + Escape）
│  ├─ settings-modal/            # 设置弹窗（closeOnScrim=false）
│  ├─ confirm-modal/             # 确认弹窗
│  ├─ help-modal/                 # 命令列表 grid
│  ├─ fs-browser-modal/          # 目录浏览器（/api/fs）
│  ├─ permission-banner/         # 内联权限确认条
│  └─ primitives/                # Button / IconButton / Toggle / Badge
├─ theme/
│  ├─ token-map.ts               # BlockKind→Lucide icon, ColorToken→CSS var
│  ├─ themes/                    # midnight.css / forest.css / dawn.css
│  └─ animations.css             # @keyframes + reduced-motion
├─ styles/global.css             # reset + Google Fonts + scrollbar
├─ channel/sse-client.ts         # EventSource + fetch POST → UiPort
└─ brand/mark.tsx                # Egg + PawPrint 组合 + DogEgg wordmark
```

## 与 TUI 的关系

TUI 和 WebUI 共享 `ui/src/shared/`（reducer / block / commands / status / permission / command-feedback）。差异在：
- **渲染层**：TUI 用 Ink（React for CLI + emoji/hex），WebUI 用 React DOM（CSS Modules + Lucide SVG + CSS 变量）
- **交互层**：TUI 用 useInput 键盘路由，WebUI 用鼠标 + 键盘事件
- **视图状态**：TUI 用 View 联合（overlay XOR chat），WebUI 用单一布局 + Modal 叠加
- **markdown**：TUI 用 `marked` Lexer 分词→纯文本，WebUI 用 `react-markdown` + `rehype-highlight` 组件式渲染

## 三栏布局

```css
.app {
  display: grid;
  grid-template-columns: var(--sidebar-w) 1fr var(--info-w);  /* 240px + 1fr + 280px */
  grid-template-rows: var(--topbar-h) 1fr auto;                /* 40px + 1fr + auto */
  grid-template-areas: 'sidebar topbar info' 'sidebar main info' 'sidebar input info';
}
```

侧栏和信息面板可收起（`data-sidebar-collapsed` / `data-info-collapsed` 改 grid-template-columns）。

## SSE 客户端

`ui/src/webui/channel/sse-client.ts` 封装 `EventSource` + `fetch POST` 为 `UiPort` 接口：

```ts
function createSseUiPort(onConnectionChange?): UiPort {
  const es = new EventSource('/api/events')
  es.onopen = () => onConnectionChange?.('connected')
  es.onerror = () => onConnectionChange?.(es.readyState === CLOSED ? 'disconnected' : 'reconnecting')
  es.onmessage = (e) => {
    const raw = JSON.parse(e.data)
    const result = agentToUiMessageSchema.safeParse(raw)  // zod 校验下行消息
    if (result.success) listeners.forEach((l) => l(result.data))  // 校验失败则丢弃
  }
  return {
    onMessage(cb) { listeners.add(cb); return () => listeners.delete(cb) },
    async post(msg) {
      const res = await fetch('/api/message', { method: 'POST', ... })
      if (!res.ok) throw new Error(`POST failed: ${res.status}`)
    },
  }
}
```

- **下行校验**：用 `agentToUiMessageSchema`（bridge zod schema）校验 SSE 消息，畸形消息丢弃。
- **上行错误**：`post()` 在非 2xx 时抛错，App 层用 `safePost()` 包装捕获并 toast 提示。
- **连接状态**：通过 `onConnectionChange` 回调通知 App（顶栏指示器 + 首次断连 toast）。
- **自动重连**：浏览器 EventSource 内置自动重连，重连后 server 推 `session_ready` 恢复完整状态。

## 三主题设计

三主题 CSS 文件定义完整的 token 体系（颜色 / soft 色 / 圆角 / 间距 / 字号 / 字体 / 阴影 / z-index / 动画时长 / 毛玻璃 / 布局尺寸 / token 间接层映射）：

| 主题 | 基调 | Accent |
|---|---|---|
| Midnight | 暗色 Zinc `#09090B` | Indigo `#6366F1` |
| Forest | 暗色 Slate `#0F172A` | Green `#22C55E` |
| Dawn | 亮色 `#FAFAFA` | Indigo `#6366F1` |

每个主题还定义 8 个 soft 色变量（低透明度，用于 badge/pill/highlight 背景）。Midnight.css 包含 `:root` fallback 块（JS 未执行时的 CSS 级安全网）。

## 信息面板（8 section）

右侧信息面板包含 8 个可折叠 `InfoCard`：

| Section | 内容 |
|---|---|
| Status & Model | 状态 pill + provider/model |
| Context | token 进度条 + 数字 |
| Tool Calls | 工具调用列表（seq + 状态 + 权限标签） |
| Files Touched | 从 tool_start 提取的文件路径 |
| Available Tools | 工具列表 + config 权限标签 |
| Session Permissions | allow_always 授权列表 + 撤销按钮 |
| System Prompt | 路径 + 内容预览 |
| Log Tail | 日志尾部 |

`InfoCard` 的 `highlight` prop 触发 accent 边框 + soft 色光晕 + 自动展开。纯呈现命令（/tools /system 等）通过 `onCommandFeedback` 高亮对应 section。

## Markdown 渲染

`components/markdown/` 使用 `react-markdown` + `rehype-highlight`，**不走 `dangerouslySetInnerHTML`**（消除 XSS 风险）：

- **语法高亮**：rehype-highlight 自动给代码块加 `hljs` class，CSS 变量适配三主题。
- **代码块复制**：hover 时右上角浮现 Copy 按钮，点击后变 "Copied!" 1.5s 恢复。
- **样式统一**：所有 markdown 样式在 `markdown.module.css`（含 p/code/pre/ul/h1-3/a/blockquote/table/hr/img + hljs 主题）。

## 错误边界

`components/error-boundary/` 提供分区包裹 + 全局兜底：
- `main.tsx` 最外层包裹全局 `ErrorBoundary`
- `app.tsx` 中 Sidebar / ChatView / InfoPanel 各包裹一层
- 某区域崩溃只影响该区域，显示错误信息 + "Try again" 重试按钮
