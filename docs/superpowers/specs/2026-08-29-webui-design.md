# DogEggAgent WebUI 设计与实现 Spec

> 日期：2026-08-29（最后更新：2026-08-31）
> 状态：已实施
> 关联 ADR：0001 (SSE+POST)、0002 (SSE channel 归 server)、0003 (Block 语义化重构)、0004 (set_cwd 运行时)、0005 (单会话模式)、0006 (会话 cwd 持久化)、0007 (思考内容持久化)
> 关联文档：`docs/superpowers/specs/2026-08-26-dog-egg-agent-design.md`（原始设计）、`docs/superpowers/specs/2026-08-27-modular-refactor-design.md`（模块化重构设计）

## 1. 背景与目标

DogEggAgent 当前有 TUI（Ink v7）+ WebUI（React DOM + Vite）双前端。WebUI 通过 SSE+POST 与后端 Agent 通信，为后续套 Electron 成为桌面产品铺路。

**核心约束**：bridge 契约向后兼容扩展（新增字段可选，旧 TUI 不受影响），WebUI 改动集中在 ui/src/webui/ + server 包。

**设计原则**：
- 代码设计方便后续维护、美观、正确
- 高级感、减少 AI 味道、Lucide SVG 图标（零 emoji）
- 单一布局（侧栏 + 聊天 + 右侧信息面板），侧栏可收起
- 功能与 TUI 完全对等（除 /quit）

## 1.1 实施后变更记录

- **单一布局**（非三布局）：删除 focus/workspace/zen 三布局系统，改为单一 grid（260px + 1fr + 280px）。侧栏可收起为 48px 图标条。右侧信息面板可收起为 32px。
- **项目/会话树侧栏**：按 cwd 分组会话为项目，每个项目可折叠/展开，有添加会话和删除按钮。底部 Add Project 打开目录选择器。
- **设置改为 modal**：不再切换 panel，/config 等命令打开 scrim + 大弹窗。General 标签页用 Select 下拉框 + EditableInput，Models 标签页用 Toggle 开关。
- **右侧信息面板**：状态指示器 + 模型信息 + Token 进度条 + 工具调用列表（带 spinner）。
- **思考内容持久化**（ADR-0007）：reasoning 内容存入 session JSON 的 thinking 字段，resume 后恢复思考块。parser 累积 reasoning → loop 返回 thinking → agent 持久化 → session_ready 携带 → reducer 重建思考块。
- **会话删除**（ADR-0006）：deleteSession + delete_session 消息 + session_deleted 回传。侧栏会话项和项目级删除按钮（确认弹窗）。
- **会话 cwd 持久化**（ADR-0006）：session 存 cwd，resume 恢复 this.cwd。new_session 可选传 cwd。session_list 带 cwd?。
- **创建会话即时刷新**：new_session 立即保存空会话到磁盘，list_sessions 返回新会话，侧栏即时显示。

## 2. 架构总览

```
main-web.ts (组合根，唯一 import agent + server + bridge)
  ├─ loadConfig → createSseChannel() → new Agent(agentPort, config, cwd)
  └─ startServer({ uiPort, staticDir, cwd })
       ├─ SSE 端点 GET /api/events    → uiPort.onMessage 注册的回调推到 SSE 流
       ├─ POST 端点 POST /api/message → uiPort.post(UiToAgentMessage)
       ├─ FS 端点 GET /api/fs?path=   → listDirs(path) 安全目录浏览
       └─ 静态文件 /                  → serve dist/web/
```

**与 TUI 组合根对比**：

| | main.ts (TUI) | main-web.ts (WebUI) |
|---|---|---|
| import | agent + ui + bridge | agent + server + bridge（不 import ui） |
| 通道 | createChannelPair() (in-memory) | createSseChannel() (SSE+POST) |
| 前端 | renderTui(uiPort) — 代码 import | serve dist/web/ — 静态文件 |
| 前端运行环境 | 同进程 Ink | 浏览器 |

## 3. bridge 契约扩展

### 3.1 新增消息类型

`bridge/src/contract/ui-to-agent.ts` 新增：

```ts
| { type: 'set_cwd'; path: string }
```

`UiToAgentMessage` 从 18 变 19 种。`/quit` 消息类型保留（TUI 用），WebUI 不发送。

### 3.2 不改动的部分

`AgentToUiMessage`（22 种）、`State`、`Message`、`ToolCall`、`PermissionDecision`、`Config`、Port 接口——全部不变。

## 4. Agent 侧改动（set_cwd）

### 4.1 Agent 类

`agent/src/core/agent.ts`：

- `private cwd: string` — 保持字段，从构造参数只读改为可变
- 新增 `private async setCwd(path: string): Promise<void>`：
  1. `fs.stat(path)` 验证路径存在且是目录
  2. 验证通过：`this.cwd = path`，emit `status_state`（含新 cwd 确认）
  3. 验证失败：emit `notice`（路径不存在 / 不是目录）
- `send()` dispatch 新增 `case 'set_cwd':` → 调 `setCwd(cmd.path)`

### 4.2 工具无需改动

ToolContext 每次从 `this.cwd` 构建（`agent/src/loop/tool-calls.ts:63`），已验证的 per-call 机制。`this.cwd` 变更后下一次工具调用自动用新值。四个工具（shell/edit_file/read_file/write_file）都通过 `ctx.cwd` 读取，无硬编码。

### 4.3 命令扩展

`ui/src/shared/commands.ts` 新增：
- `COMMANDS` 数组加 `{ cmd: '/cd', desc: '切换工作目录' }`
- `parseCommand` 加 `case '/cd':` — 需要参数解析（`/cd /path/to/dir`）

## 5. shared 重构（ui/src/shared/）

### 5.1 Move 清单

| 原位置 | 新位置 | 改动 |
|---|---|---|
| `ui/src/tui/chat/block.ts` | `ui/src/shared/block.ts` | 重构（见 5.2） |
| `ui/src/tui/chat/reducer.ts` | `ui/src/shared/reducer.ts` | 重构（见 5.3） |
| `ui/src/tui/input/commands.ts` | `ui/src/shared/commands.ts` | 加 /cd 命令，其余原样 |
| `ui/src/tui/overlays/config/build.ts` | `ui/src/shared/config/build.ts` | 原样（纯函数） |
| `ui/src/tui/overlays/config/navigation.ts` | `ui/src/shared/config/navigation.ts` | 原样（纯函数） |
| `ui/src/tui/overlays/config/label.ts` | `ui/src/shared/config/label.ts` | 原样（纯函数） |

### 5.2 Block 语义化

```ts
// ui/src/shared/block.ts

export type BlockKind =
  | 'user' | 'assistant' | 'thinking' | 'tool'
  | 'error' | 'notice' | 'auto_compact'

export type ColorToken =
  | 'accent' | 'text' | 'cyan' | 'yellow'
  | 'red' | 'subtext'

export interface Block {
  kind: BlockKind          // 语义角色（替代 icon + role）
  color: ColorToken         // 语义色（替代 hex BlockColor）
  text: string              // 折叠时摘要
  full?: string             // 展开时完整内容
  toolId?: string           // tool_start/tool_end 精确匹配
  toolInput?: unknown       // tool_start input，供 tool_end 格式化 diff
}
```

删除：`ICON`（emoji 常量）、`COLOR`（hex 映射）、`import { palette }`。

### 5.3 Reducer 重构

所有 `palette.red` → `color: 'red'`，`palette.yellow` → `color: 'yellow'`，`palette.subtext` → `color: 'subtext'`。所有 `ICON.thinking` → `kind: 'thinking'`，`ICON.tool` → `kind: 'tool'` 等。reducer 逻辑完全不变，只改视觉值的表达方式。

### 5.4 shared/index.ts

纯 re-export（遵循 module=folder 约定）：
```ts
export * from './block'
export * from './reducer'
export * from './commands'
export * from './config'
```

### 5.5 TUI 侧适配

新建 `ui/src/tui/theme/token-map.ts`：
```ts
import type { BlockKind, ColorToken } from '../../shared/block'
import { palette } from './palette'

export const KIND_ICON: Record<BlockKind, string> = {
  user: '🥚', assistant: '🐶', tool: '🐾', thinking: '🐣',
  error: '🐶', notice: '🥚', auto_compact: '🐾',
}
export const TOKEN_COLOR: Record<ColorToken, string> = {
  accent: palette.accent, text: palette.text, cyan: palette.cyan,
  yellow: palette.yellow, red: palette.red, subtext: palette.subtext,
}
export const KIND_ROLE: Record<BlockKind, string> = {
  user: '你', assistant: '助手', tool: '工具', thinking: '思考',
  error: '错误', notice: '提示', auto_compact: '自动压缩',
}
```

TUI 渲染层查表：`KIND_ICON[block.kind]`、`TOKEN_COLOR[block.color]`、`KIND_ROLE[block.kind]`。

TUI 的 `viewport.ts` 和 `markdown/render.ts` 不移（终端专属）。

## 6. server 包（@dogegg/server）

### 6.1 包结构

```
server/
├─ package.json              # name: @dogegg/server, type: module
├─ tsconfig.json             # extends ../tsconfig.base.json
├─ src/
│  ├─ index.ts               # 纯 re-export
│  ├─ http/
│  │  ├─ index.ts            # re-export
│  │  ├─ server.ts           # startServer()：http.createServer + 路由分发 + 静态文件
│  │  └─ routes.ts           # SSE / POST / fs / static 路由匹配
│  ├─ channel/
│  │  ├─ index.ts            # re-export
│  │  └─ sse.ts              # createSseChannel()：SSE Port 实现
│  └─ fs/
│     ├─ index.ts            # re-export
│     └─ browse.ts           # listDirs(path)：安全目录浏览
└─ vite.config.ts            # Vite 构建配置（webui 前端入口）
```

### 6.2 SSE Channel 实现

`server/src/channel/sse.ts`:

```ts
export function createSseChannel(): {
  agentPort: AgentPort
  uiPort: UiPort
  sseHandler: (req: IncomingMessage, res: ServerResponse) => void  // GET /api/events
  postHandler: (req: IncomingMessage, res: ServerResponse) => void  // POST /api/message
}
```

- **下行**（agent → UI）：`uiPort.post(msg)` → 序列化为 JSON → 写入所有活跃 SSE 连接的 `res.write('data: ' + json + '\n\n')`。用 `Set<ServerResponse>` 管理多连接。
- **上行**（UI → agent）：`postHandler` 读取 POST body → 解析 JSON → `agentPort.onMessage` 回调触发。
- **SSE 头**：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`。
- **重连**：SSE 断开后浏览器 EventSource 自动重连。重连时 server 推 `session_ready`（agent 当前 history），恢复完整状态。

### 6.3 FS 浏览端点

`server/src/fs/browse.ts`:
```ts
export function listDirs(path: string): { current: string; dirs: string[]; parent: string | null }
```
- 用 `fs.readdir(path, { withFileTypes: true })` 只返回目录（`dirent.isDirectory()`），不返回文件（安全）。
- 返回 `parent`（上级目录路径）供 UI 向上导航。

路由：`GET /api/fs?path=/some/dir` → JSON 响应。

### 6.4 静态文件服务

`startServer` 启动时检查 `dist/web/` 是否存在，存在则 serve。开发模式下由 Vite dev server 代理，不依赖 `dist/web/`。

## 7. 组合根（main-web.ts）

```ts
// 根目录，与 main.ts 并列。唯一 import agent + server（不 import ui）。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Agent, loadConfig, initLogger } from '@dogegg/agent'
import { createSseChannel, startServer } from '@dogegg/server'

const config = loadConfig()
const { agentPort, uiPort, sseHandler, postHandler } = createSseChannel()
initLogger(join(homedir(), '.dogegg', 'logs'))

new Agent(agentPort, config, process.cwd())

startServer({
  uiPort,
  sseHandler,
  postHandler,
  staticDir: join(import.meta.dirname, 'web'),
  port: Number(process.env.PORT) || 3000,
})
```

## 8. WebUI 前端（ui/src/webui/）

### 8.1 目录结构

```
ui/src/webui/
├─ index.html                    # Vite 入口 HTML
├─ main.tsx                      # React DOM render 入口
├─ app/
│  ├─ index.ts                   # re-export
│  ├─ app.tsx                    # App 根组件：port + state + panel/modal 路由
│  └─ view-state.ts             # WebViewState：panel + modal 双维度
├─ components/
│  ├─ index.ts                   # re-export
│  ├─ sidebar/                   # 侧栏（聊天/文件/会话/设置 + 布局切换 + 品牌标识）
│  ├─ top-bar/                   # 顶栏（provider/model + cwd + 状态指示）
│  ├─ chat-view/                 # 聊天视口（消息列表 + 流式块）
│  ├─ message-block/            # 单条消息块（色条 + 标签 + Lucide 图标 + 动画）
│  ├─ input-bar/                 # 输入栏（TextInput + 斜杠命令联想 + 发送/停止）
│  ├─ status-bar/                # 状态栏（状态点脉冲 + token 计量）
│  ├─ overlay/                   # 模态层容器
│  │  ├─ permission/             # 权限弹窗 + diff 预览
│  │  ├─ confirm/                # 危险操作确认弹窗
│  │  └─ fs-browser/            # 目录选择器
│  ├─ settings/                  # 设置面板（二级导航 + 各子面板）
│  │  ├─ general/                # 通用设置
│  │  ├─ models/                 # 模型配置（provider/model 列表 + 编辑）
│  │  ├─ permissions/            # 权限管理（allow_always 列表 + 撤销）
│  │  ├─ tools/                  # 工具列表
│  │  ├─ context/                # 上下文占用
│  │  ├─ system-prompt/          # 系统提示词查看
│  │  └─ logs/                   # 调试日志
│  └── sessions/                 # 会话列表 + resume
├─ theme/
│  ├─ index.ts                   # re-export
│  ├─ token-map.ts               # kind→Lucide icon, colorToken→CSS var 映射
│  ├─ themes/
│  │  ├─ catppuccin.css          # [data-theme="catppuccin"] 变量
│  │  ├─ ios-light.css           # [data-theme="ios-light"] 变量
│  │  └─ ios-dark.css            # [data-theme="ios-dark"] 变量
│  ├─ layouts/
│  │  ├─ focus.css               # [data-layout="focus"] grid 模板
│  │  ├─ workspace.css           # [data-layout="workspace"] grid 模板
│  │  └─ zen.css                 # [data-layout="zen"] grid 模板
│  └─ animations.css             # @keyframes + transition 定义
├─ styles/
│  ├─ global.css                 # reset + body + font imports
│  └─ *.module.css               # 各组件的 CSS Modules
├─ channel/
│  ├─ index.ts                   # re-export
│  └─ sse-client.ts              # createSseUiPort()：EventSource + fetch POST 封装为 UiPort
└─ brand/
   ├─ index.ts                   # re-export
   └─ mark.tsx                   # Egg + PawPrint 组合 + DoggEgg wordmark
```

每个组件遵循 module=folder 约定（`index.tsx` 导出 + `view.tsx` 实现 + `*.module.css` 样式）。

### 8.2 SSE 客户端

`ui/src/webui/channel/sse-client.ts`:
```ts
export function createSseUiPort(): UiPort {
  const es = new EventSource('/api/events')
  const listeners = new Set<(msg: AgentToUiMessage) => void>()
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data) as AgentToUiMessage
    listeners.forEach((l) => l(msg))
  }
  return {
    onMessage(cb) { listeners.add(cb); return () => listeners.delete(cb) },
    async post(msg) { await fetch('/api/message', { method: 'POST', body: JSON.stringify(msg) }) },
  }
}
```

### 8.3 View 状态模型

```ts
// ui/src/webui/app/view-state.ts
interface WebViewState {
  panel: 'chat' | 'sessions' | 'settings'  // 侧栏选择
  settingsTab: 'general' | 'models' | 'permissions' | 'tools'
             | 'context' | 'system-prompt' | 'logs'  // 设置面板内二级导航
  modal: { kind: 'none' }
       | { kind: 'permission'; id: string; tool: string; input: unknown }
       | { kind: 'confirm'; title: string; onConfirm: () => void }
       | { kind: 'fs-browser' }
       | { kind: 'help' }
  theme: 'catppuccin' | 'ios-light' | 'ios-dark'
  layout: 'focus' | 'workspace' | 'zen'
}
```

**关键区别于 TUI**：TUI 的 View 是单选一（聊天 XOR overlay）。WebUI 的 `panel` 持久（侧栏选择保留），`modal` 独立叠加（权限弹窗出现在任何面板之上）。`view-state.ts` 不共享——各 UI 管自己的视图状态。

### 8.4 斜杠命令 → 面板导航映射

| 命令 | 行为 |
|---|---|
| `/config` | panel='settings', settingsTab='general' |
| `/model` | panel='settings', settingsTab='models' |
| `/permissions` | panel='settings', settingsTab='permissions' |
| `/tools` | panel='settings', settingsTab='tools' |
| `/context` | panel='settings', settingsTab='context' |
| `/system` | panel='settings', settingsTab='system-prompt' |
| `/log` | panel='settings', settingsTab='logs' |
| `/status` | modal='help'（或顶栏点击弹出状态卡片） |
| `/help` | modal='help' |
| `/session` | panel='sessions' |
| `/new` | 发 new_session（动作） |
| `/clear` | modal='confirm' |
| `/compact` | 发 compact_request（动作） |
| `/cd` | modal='fs-browser' |
| `/quit` | WebUI 不联想（关闭标签页即退出） |

侧栏点击同样发对应的 `UiToAgentMessage`——与斜杠命令完全一致。`commands.ts`（shared）的 `matchCommands` 用于输入框联想（去掉 `/quit`）。

## 9. 设计系统

### 9.1 三主题色彩

| Token | Catppuccin Dark | iOS Light | iOS Dark |
|---|---|---|---|
| `--color-bg` | `#1E1E2E` | `#F2F2F7` | `#000000` |
| `--color-surface` | `#313244` | `#FFFFFF` | `#1C1C1E` |
| `--color-surface-elevated` | `#45475A` | `#FFFFFF` + shadow | `#2C2C2E` |
| `--color-text` | `#CDD6F4` | `#1C1C1E` | `#FFFFFF` |
| `--color-subtext` | `#A6ADC8` | `#8E8E93` | `#8E8E93` |
| `--color-accent` | `#89B4FA` | `#007AFF` | `#0A84FF` |
| `--color-success` | `#A6E3A1` | `#34C759` | `#30D158` |
| `--color-warning` | `#F9E2AF` | `#FFCC00` | `#FFD60A` |
| `--color-danger` | `#F38BA8` | `#FF3B30` | `#FF453A` |
| `--color-border` | `#45475A` | `#E5E5EA` | `#38383A` |

Catppuccin 偏方正（radius-sm 6px），iOS 偏圆润（radius-sm 8px）。

### 9.2 字体

- **UI sans**：Inter（界面文字，中性高可读）
- **Mono**：JetBrains Mono（代码块、工具输出、diff、shell 命令）
- **Wordmark**：Space Grotesk（仅品牌标识，display face used with restraint）

### 9.3 图标

Lucide React（SVG，1.5px 描边）。零 emoji。

| 位置 | 图标 |
|---|---|
| 侧栏·聊天 | `MessageSquare` |
| 侧栏·文件 | `FolderOpen` |
| 侧栏·会话 | `History` |
| 侧栏·设置 | `Settings` |
| 设置·通用 | `SlidersHorizontal` |
| 设置·模型 | `Cpu` |
| 设置·权限 | `ShieldCheck` |
| 设置·工具 | `Wrench` |
| 设置·上下文 | `Gauge` |
| 设置·系统提示 | `Terminal` |
| 设置·日志 | `ScrollText` |
| 新建会话 | `Plus` |
| 压缩 | `Minimize2` |
| 清空 | `Trash2` |
| 发送 | `ArrowUp` |
| 停止 | `Square` |
| 消息角色·user | `User` |
| 消息角色·assistant | `Bot` |
| 消息角色·thinking | `Brain` |
| 消息角色·tool | `Wrench` |
| 消息角色·error | `AlertCircle` |
| 布局·focus | `Square` |
| 布局·workspace | `Columns3` |
| 布局·zen | `Maximize` |

### 9.4 品牌标识

**Mark**：Lucide `Egg` 图标为主体，Lucide `PawPrint` 缩小叠在蛋右上区域。两个图标单色描边，跟随 `--color-accent`。

**Wordmark**："DoggEgg" 用 Space Grotesk 600。两个 "gg"（Dogg 的尾 gg + Egg 的首 gg）用 `--color-accent`，其余字母用 `--color-text`。

侧栏顶部：mark（24px）+ wordmark（14px）。favicon 用 mark 单独。

### 9.5 三布局

**Focus（默认）**：窄侧栏（240px）+ 全宽聊天。
**Workspace**：侧栏 + 聊天 + 右侧详情面板（点击工具块在右侧展开完整输出）。
**Zen**：无侧栏，全宽聊天，侧栏通过按钮呼出为浮动抽屉。

切换：侧栏底部按钮组 + 快捷键。`data-layout` 属性控制容器 CSS grid 模板。

### 9.6 动画

| 场景 | 动画 | 时长 | 缓动 |
|---|---|---|---|
| 流式文本 | 新 token fade-in | 80ms | linear |
| 消息块入场 | slide-up + fade | 200ms | ease-out |
| 工具运行中 | 色条脉冲循环 | 1.5s loop | ease-in-out |
| 思考/响应中 | 状态点脉冲（三点错峰） | 1s loop | ease-in-out |
| 面板切换 | crossfade | 150ms | ease |
| 权限弹窗 | scale + fade + backdrop blur | 200ms | ease-out |
| 侧栏选中 | background-color transition | 120ms | ease |
| 布局切换 | grid 过渡 / crossfade | 200ms | ease |
| 工具块展开 | 图标 scale 0.9→1 微弹 | 80ms | ease-out |
| 思考块折叠 | 图标 rotate 0→90° | 80ms | ease-out |

全部 CSS `@keyframes` + `transition`，零运行时依赖。`prefers-reduced-motion: reduce` 禁用循环和入场动画，保留即时状态变化。

### 9.7 消息块视觉

每条消息用色条 + 标签 + Lucide 图标标识角色：
- 左侧 3px 竖条（颜色 = `--color-{token}`）+ 角色标签 + Lucide 图标
- 思考块/工具块可折叠（默认折叠，点击展开）
- 工具运行中：色条脉冲动画替代 spinner
- markdown 用 DOM 渲染（`marked` 已在依赖中，输出 HTML 即可）

## 10. 构建与开发

### 10.1 脚本（根 package.json 新增）

```json
{
  "scripts": {
    "dev": "npm run build && npm run start",
    "dev:web": "concurrently \"vite\" \"tsx main-web.ts\"",
    "build": "node build.mjs",
    "build:web": "vite build && node build-web.mjs",
    "start": "node dist/index.js",
    "start:web": "node dist/server.js",
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p agent && tsc --noEmit -p ui && tsc --noEmit -p bridge && tsc --noEmit -p server",
    "test": "vitest",
    "test:run": "vitest run"
  }
}
```

- `dev:web`：Vite dev server（HMR）+ tsx 跑 main-web.ts。Vite proxy `/api/*` 到 server。
- `build:web`：Vite build → `dist/web/`（静态文件）+ esbuild → `dist/server.js`（server bundle）。
- `start:web`：node 跑 dist/server.js，serve dist/web/ 静态文件 + 跑 agent。
- TUI 脚本不变。
- 新增 devDependencies：`vite`、`@vitejs/plugin-react`、`concurrently`、`lucide-react`。

### 10.2 Vite 配置

根目录 `vite.config.ts`：
- 入口：`ui/src/webui/index.html`
- 产物目录：`dist/web/`
- dev proxy：`/api` → `http://localhost:3001`（server dev 端口）
- resolve alias：`@dogegg/bridge` → `bridge/src/index.ts`、`@dogegg/ui` → `ui/src/index.ts`
- plugin：`@vitejs/plugin-react`

### 10.3 build-web.mjs

esbuild 打包 main-web.ts → `dist/server.js`，与现有 `build.mjs` 同模式（`@dogegg/*` 解析到包源码，npm 依赖 external）。

### 10.4 tsconfig

- 根 `tsconfig.json`：references 数组加 server
- `server/tsconfig.json`：extends base，include src/
- `ui/tsconfig.json`：include 加 `src/webui/**/*`

### 10.5 .gitignore

`dist/` 已在 .gitignore，`dist/web/` 被覆盖。无需额外加。

## 11. 架构测试扩展

`bridge/test/architecture.test.ts` 新增：
- `server/src` 不得 import `@dogegg/ui`（前端是静态文件被 serve）
- `server/src` 可 import `@dogegg/agent`、`@dogegg/bridge`（server 需要创建 agent + 使用 Port 接口）
- `ui/src/webui` 不得 import `@dogegg/agent`、`@dogegg/server`（前端只依赖 bridge + shared）
- `ui/src/shared` 不得 import `@dogegg/agent`、`@dogegg/ui` 的 tui/webui 子路径

## 12. 实施阶段

| 阶段 | 内容 | 验证 |
|---|---|---|
| **P0** | bridge 契约加 set_cwd；agent setCwd 实现；/cd 命令 | typecheck + TUI 测 /cd |
| **P1** | shared 重构：block/reducer/commands/config 移到 shared + 语义化；TUI token-map 适配 | typecheck + TUI 全功能回归 |
| **P2** | server 包：SSE channel + HTTP server + fs 端点 + 组合根 main-web.ts | typecheck + 手测 SSE 连通 |
| **P3** | WebUI 骨架：App + SSE client + 侧栏 + 聊天视口 + 消息块 + 输入栏 + 状态栏 | 浏览器打开能看到消息流 |
| **P4** | WebUI 完整面板：设置面板（7 子项）+ 会话面板 + 权限弹窗 + 确认弹窗 + fs-browser | 全功能对等验证 |
| **P5** | 设计系统：三主题 + 三布局 + 动画 + 品牌标识 + Lucide 图标 | 视觉 gate（judge） |
| **P6** | 构建流水线：vite.config + build-web.mjs + dev:web/start:web 脚本 + 架构测试扩展 | typecheck + test + build:web + start:web |

## 13. 不做（v1 范围外）

- 多会话并行执行（多 Agent 实例 + 消息带 sessionId）—— ADR-0005
- Electron 集成 —— 路线 A 后续阶段
- WebSocket 传输 —— SSE 足够
- 用户认证 / 多用户 —— 单用户学习项目
- /quit 在 WebUI 的支持 —— 关标签页即退出
