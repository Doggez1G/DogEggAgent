# DogEggAgent WebUI 设计与实现 Spec

> 日期：2026-08-29（最后更新：2026-09-03）
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

**v1 初版**：
- **单一布局**（非三布局）：删除 focus/workspace/zen 三布局系统，改为单一 grid（`var(--sidebar-w)` + 1fr + `var(--info-w)`）。侧栏可收起为 `var(--sidebar-collapsed-w)` = 48px 图标条。右侧信息面板可收起为 `var(--info-collapsed-w)` = 32px。
- **项目/会话树侧栏**：按 cwd 分组会话为项目，每个项目可折叠/展开，有添加会话和删除按钮。底部 Add Project 打开目录选择器。项目在所有会话删除后仍保留显示（knownProjects 状态），直到用户显式删除项目。
- **设置改为 modal**：不再切换 panel，/config 等命令打开 scrim + 大弹窗。IDE 风格左导航 + 右内容区（General / Models / Permissions 三区）。
- **右侧信息面板**：8 个可折叠 InfoCard section（Status+Model / Context / Tool Calls / Files Touched / Available Tools / Session Permissions / System Prompt / Log Tail）。
- **思考内容持久化**（ADR-0007）：reasoning 内容存入 session JSON 的 thinking 字段，resume 后恢复思考块。parser 累积 reasoning → loop 返回 thinking → agent 持久化 → session_ready 携带 → reducer 重建思考块。
- **会话删除**（ADR-0006）：deleteSession + delete_session 消息 + session_deleted 回传。侧栏会话项和项目级删除按钮（确认弹窗）。删除项目仅删除会话记录和侧栏显示，不触碰项目目录本身。
- **会话 cwd 持久化**（ADR-0006）：session 存 cwd，resume 恢复 this.cwd。new_session 可选传 cwd。session_list 带 cwd?。
- **创建会话即时刷新**：new_session 立即保存空会话到磁盘，list_sessions 返回新会话，侧栏即时显示。

**v2 重新设计（2026-09-01）**：
- **三主题重命名**：catppuccin → Midnight（Zinc + Indigo），ios-dark → Forest（Slate + Green），ios-light → Dawn（亮色中性 + Indigo）。每个主题定义完整的 token 体系：颜色 / soft 色（8 个低透明度变量）/ 圆角 / 间距 / 字号 / 字体 / 阴影 / z-index / 动画时长 / 毛玻璃 / 布局尺寸 / token 间接层映射。
- **Primitives 组件层**：新增 `components/primitives/`（Button / IconButton / Toggle / Badge），统一基础组件样式。
- **Cmd+K 命令面板**：新增 `components/command-palette/`，glassmorphism 浮层 + 模糊搜索（命令 / 会话 / 主题 / 动作）+ 键盘导航。
- **权限确认改为内联 banner**：不再弹窗，改为输入框上方内联 PermissionBanner（tool 名 + diff 预览 + 3 按钮）。
- **纯呈现命令高亮**：/tools /system /log /permissions /context /status 通过 `highlightInfoSection` 高亮右侧面板对应 InfoCard（accent 边框 + soft 色光晕），不弹 toast。/session 高亮侧栏 nav 区域。
- **tool_calls 权限快照**：执行时记录 configPerm + decision 快照，不随后续设置变化。tool_end 保留 tool_start 时的 decision。
- **实时刷新**：allow_always 决策后自动 permissions_request 刷新 Session Permissions；finished/error 后自动 log_request 刷新日志。

**v3 架构清理（2026-09-03）**：
- **app.tsx 拆分**：5 个内联 modal（SettingsModal/ConfirmModal/HelpModal/FsBrowserModal/PermissionBanner）拆为独立组件文件夹，app.tsx 从 581→424 行。
- **死代码清理**：移除 webui status-bar（从未渲染）、SSE uiPort（返回但无人使用）、5 个未用 primitives（Card/Section/Input/Textarea/EditableField/Tooltip，共 ~525 行）、saveConfig 公开导出。
- **跨模块重复消除**：STATUS_LABELS 三合一 + getToolPermission 二合一 + isStateRunning 二合一 + onCommandFeedback 三合一 → 统一到 `ui/src/shared/`（status.ts / permission.ts / command-feedback.ts）。COMPACTION_THRESHOLD 0.8 四处硬编码 → 统一到 `bridge/contract/shared.ts`。
- **barrel import 强制**：修正 33 处违规 import（agent 18 + ui 15），架构测试加规则检测。`shared/config/` 移到 `tui/config/`（仅 TUI 使用）。
- **消息 zod 校验**：新增 `agent-to-ui-schema.ts`（23 变体），SSE 下行消息 safeParse 校验；与已有的 `ui-to-agent-schema.ts`（22 变体）对称。
- **Server 安全加固**：CORS 改为 Origin allowlist（localhost only）+ Vary: Origin；detectShells 独立为 `server/src/shells/` 模块，execFileSync 无 shell + 缓存；路径穿越改用 path.resolve + path.relative。
- **测试覆盖**：reducer/commands/block 从 0→66 测试，总测试数 100→167。

## 2. 架构总览

```
main-web.ts (组合根，唯一 import agent + server + bridge)
  ├─ loadConfig → createSseChannel() → new Agent(agentPort, config, cwd)
  └─ startServer({ sseHandler, postHandler, staticDir, port })
       ├─ SSE 端点 GET /api/events    → sseHandler 建立连接，agentPort.post 推到所有 SSE 客户端
       ├─ POST 端点 POST /api/message → postHandler 读 body + zod 校验 → agentPort.onMessage 回调
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

`UiToAgentMessage` 共 22 种（含 set_cwd、permissions_request、permission_revoke、delete_session 等）。`/quit` 消息类型保留（TUI 用），WebUI 不发送。

### 3.2 不改动的部分

`AgentToUiMessage`（23 种）、`State`、`Message`、`ToolCall`、`PermissionDecision`、`Config`、Port 接口——全部不变。

### 3.3 消息 zod 校验 schema

`bridge/src/contract/` 新增两个 zod schema 文件，用于运行时校验消息：
- `ui-to-agent-schema.ts`：`uiToAgentMessageSchema`（discriminatedUnion，22 变体），在 server `postHandler` 中 `safeParse` 校验 POST body。
- `agent-to-ui-schema.ts`：`agentToUiMessageSchema`（discriminatedUnion，23 变体），在 SSE client `onmessage` 中 `safeParse` 校验下行消息。

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
| `ui/src/tui/overlays/config/build.ts` | `ui/src/tui/config/build.ts` | 原样（纯函数）；后续从 shared 移回 tui（仅 TUI 使用） |
| `ui/src/tui/overlays/config/navigation.ts` | `ui/src/tui/config/navigation.ts` | 原样（纯函数） |
| `ui/src/tui/overlays/config/label.ts` | `ui/src/tui/config/label.ts` | 原样（纯函数） |
| `ui/src/tui/overlays/config/entries.ts` | `ui/src/tui/config/entries.ts` | 原样（纯函数） |

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
│  │  └─ routes.ts           # SSE / POST / fs / shells / static 路由匹配 + CORS + 路径穿越防护
│  ├─ channel/
│  │  ├─ index.ts            # re-export
│  │  └─ sse.ts              # createSseChannel()：SSE Port 实现（POST zod 校验）
│  ├─ fs/
│  │  ├─ index.ts            # re-export
│  │  └─ browse.ts           # listDirs(path)：安全目录浏览
│  └─ shells/
│     ├─ index.ts            # re-export
│     └─ detect.ts           # detectShells()：execFileSync 无 shell + 缓存
└─ vite.config.ts            # Vite 构建配置（webui 前端入口）
```

### 6.2 SSE Channel 实现

`server/src/channel/sse.ts`:

```ts
export function createSseChannel(): {
  agentPort: AgentPort
  sseHandler: (req: IncomingMessage, res: ServerResponse) => void  // GET /api/events
  postHandler: (req: IncomingMessage, res: ServerResponse) => void  // POST /api/message
}
```

- **下行**（agent → UI）：`agentPort.post(msg)` → 序列化为 JSON → 写入所有活跃 SSE 连接的 `res.write('data: ' + json + '\n\n')`。用 `Set<ServerResponse>` 管理多连接。
- **上行**（UI → agent）：`postHandler` 读取 POST body（1MB 上限）→ `uiToAgentMessageSchema.safeParse` zod 校验 → `agentPort.onMessage` 回调触发。校验失败返回 400。
- **SSE 头**：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`。
- **重连**：SSE 断开后浏览器 EventSource 自动重连。重连时 server 推 `session_ready`（agent 当前 history），恢复完整状态。
- **无 uiPort**：SSE 传输天生不对称（下行 SSE / 上行 POST），不存在对称的 uiPort。UI 侧的 Port 由浏览器 `sse-client.ts` 独立创建。

### 6.3 FS 浏览端点

`server/src/fs/browse.ts`:
```ts
export async function listDirs(path: string, includeFiles = false): Promise<{ current: string; dirs: string[]; files: string[]; parent: string | null }>
```
- 用 `fs.readdir(path, { withFileTypes: true })` 返回目录列表；`includeFiles=true` 时也返回文件名（供 system prompt 文件选择器用）。
- 返回 `parent`（上级目录路径或 null）供 UI 向上导航。

路由：
- `GET /api/fs?path=/some/dir` → JSON（仅目录）
- `GET /api/fs?path=/some/dir&files=true` → JSON（目录 + 文件）

### 6.4 Shell 检测端点

`server/src/shells/detect.ts`（独立模块，非 routes.ts）提供 `detectShells()`：
- 用 `execFileSync`（无 shell）检测系统可用的 shell 程序（powershell / pwsh / cmd / bash / zsh / sh）。
- 结果缓存——首次调用后不再重复检测。
- 返回 `{ value, label }[]` 供设置面板的 Shell Program 下拉框使用。

路由：`GET /api/shells` → `server/src/http/routes.ts` 中的 `shellsHandler` 调用 `detectShells()`。

### 6.5 静态文件服务

`startServer` 启动时检查 `dist/web/` 是否存在，存在则 serve。开发模式下由 Vite dev server 代理，不依赖 `dist/web/`。
路径穿越防护用 `path.resolve` + `path.relative` 检查（非 `fileURLToPath`）。

## 7. 组合根（main-web.ts）

```ts
// 根目录，与 main.ts 并列。唯一 import agent + server（不 import ui）。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Agent, loadConfig, initLogger } from '@dogegg/agent'
import { createSseChannel, startServer } from '@dogegg/server'

const config = loadConfig()
const { agentPort, sseHandler, postHandler } = createSseChannel()
initLogger(join(homedir(), '.dogegg', 'logs'))

new Agent(agentPort, config, process.cwd())

startServer({
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
├─ index.html                    # Vite 入口 HTML，<html data-theme="midnight">
├─ main.tsx                      # React DOM render 入口（import global.css + 三主题 + animations）
├─ app/
│  ├─ index.ts                   # re-export
│  ├─ app.tsx                    # App 根组件：grid 布局 + state + onMessage + 模态层
│  └─ view-state.ts             # ThemeName + Modal 类型 + COMMAND_TO_MODAL + SessionItem + FileTouched
├─ components/
│  ├─ index.ts                   # barrel export（16 个组件）
│  ├─ sidebar/                   # 侧栏（品牌 + 搜索 + 项目/会话树 + 设置 + 主题切换）
│  ├─ top-bar/                   # 顶栏（运行状态 + 模型 chip + cwd chip + 连接状态 + Cmd+K 入口）
│  ├─ chat-view/                 # 聊天视口（消息列表 + MarkdownRenderer + 空状态 + 自动滚动）
│  ├─ message-block/            # 单条消息块（kind 分化渲染：user/assistant/thinking/tool/error/notice）
│  ├─ markdown/                  # Markdown 渲染器（react-markdown + rehype-highlight + 代码块复制按钮）
│  ├─ input-bar/                 # 输入栏（textarea auto-grow + 斜杠命令联想 + 输入历史 + 快捷操作菜单 + 发送/停止）
│  ├─ settings/                  # 设置面板（IDE 风格左导航 + 右内容区：General / Models / Permissions）
│  ├─ info-panel/                # 右侧信息面板（8 个可折叠 InfoCard + 数据请求 + 高亮）
│  ├─ command-palette/           # Cmd+K 命令面板（glassmorphism + 模糊搜索 + 键盘导航）
│  ├─ error-boundary/            # 错误边界（分区包裹 + 全局兜底，渲染异常不白屏）
│  ├─ modal-portal/              # 通用 Modal 容器（role=dialog + focus trap + Escape 关闭）
│  ├─ settings-modal/            # 设置弹窗（ModalPortal + Settings 组件）
│  ├─ confirm-modal/             # 确认弹窗（ModalPortal + 标题/消息/确认/取消）
│  ├─ help-modal/                 # 帮助弹窗（ModalPortal + 命令列表 grid）
│  ├─ fs-browser-modal/          # 目录浏览器弹窗（ModalPortal + /api/fs 浏览 + 手动输入）
│  ├─ permission-banner/         # 权限确认条（内联，输入框上方：tool 名 + diff 预览 + 3 按钮）
│  └─ primitives/                # 基础组件层（Button / IconButton / Toggle / Badge）
├─ theme/
│  ├─ index.ts                   # re-export KIND_ICON / TOKEN_CSS_VAR / KIND_LABEL
│  ├─ token-map.ts               # kind→Lucide icon, colorToken→CSS var 映射
│  ├─ themes/
│  │  ├─ midnight.css           # [data-theme="midnight"] + :root fallback
│  │  ├─ forest.css             # [data-theme="forest"]
│  │  └─ dawn.css                # [data-theme="dawn"]
│  └─ animations.css             # @keyframes + transition + reduced-motion
├─ styles/
│  └─ global.css                 # reset + Google Fonts import + body + scrollbar + focus-visible
├─ channel/
│  ├─ index.ts                   # re-export
│  └─ sse-client.ts              # createSseUiPort()：EventSource + fetch POST 封装为 UiPort
└─ brand/
   ├─ index.ts                   # re-export BrandMark / Wordmark / Brand
   └─ mark.tsx                   # Egg + PawPrint 组合 mark + DogEgg wordmark
```

每个组件遵循 module=folder 约定（`view.tsx` 实现 + `*.module.css` 样式 + `index.ts` re-export）。

### 8.2 SSE 客户端

`ui/src/webui/channel/sse-client.ts`:
```ts
import { agentToUiMessageSchema } from '@dogegg/bridge'

export function createSseUiPort(): UiPort {
  const es = new EventSource('/api/events')
  const listeners = new Set<(msg: AgentToUiMessage) => void>()
  es.onmessage = (e) => {
    const raw = JSON.parse(e.data)
    const parsed = agentToUiMessageSchema.safeParse(raw)
    if (!parsed.success) return   // 校验失败丢弃，不传给 listener（见 §3.3）
    listeners.forEach((l) => l(parsed.data))
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
export type ThemeName = 'midnight' | 'forest' | 'dawn'

export type Modal =
  | { kind: 'none' }
  | { kind: 'settings' }
  | { kind: 'command-palette' }
  | { kind: 'confirm'; title: string; message: string; onConfirm: () => void }
  | { kind: 'fs-browser'; onConfirm: (path: string) => void }
  | { kind: 'help' }

export const COMMAND_TO_MODAL: Record<string, { modal: ... }> = {
  '/config': { modal: { kind: 'settings' } },
  '/model': { modal: { kind: 'settings' } },
  '/help': { modal: { kind: 'help' } },
}
```

**与 TUI 的区别**：TUI 的 View 是单选一（聊天 XOR overlay）。WebUI 是单一布局（侧栏 + 顶栏 + 聊天 + 信息面板 + 输入栏，始终全显示），模态层（settings / command-palette / confirm / fs-browser / help）叠加在上。无 panel 切换维度。权限确认是内联 banner（非 modal），出现在输入框上方。

### 8.4 斜杠命令行为映射

| 命令 | 行为 |
|---|---|
| `/config` `/model` | modal='settings'（IDE 风格设置弹窗） |
| `/help` | modal='help'（命令列表 grid） |
| `/new` | 发 new_session（动作） |
| `/clear` | modal='confirm'（确认后 clear_history） |
| `/compact` | 发 compact_request（动作） |
| `/cd` | 有参数→发 set_cwd；无参数→modal='fs-browser' |
| `/session` | 发 list_sessions + 展开侧栏 + 高亮侧栏 nav |
| `/status` | 发 status_request + 高亮 InfoPanel "Status & Model" |
| `/context` | 发 context_request + 高亮 InfoPanel "Context" |
| `/tools` | 发 tools_request + 高亮 InfoPanel "Available Tools" |
| `/system` | 发 system_request + 高亮 InfoPanel "System Prompt" |
| `/log` | 发 log_request + 高亮 InfoPanel "Log Tail" |
| `/permissions` | 发 permissions_request + 高亮 InfoPanel "Session Permissions" |
| `/quit` | WebUI 不联想（关闭标签页即退出） |

纯呈现命令（/tools /system /log /permissions /context /status）通过 `onCommandFeedback` 高亮右侧面板对应 InfoCard（accent 边框 + soft 色光晕 + 自动展开），不弹 toast。命令面板（Cmd+K）点击命令时同样触发 `onCommandFeedback`。

### 8.5 布局

```css
.app {
  display: grid;
  height: 100vh;
  grid-template-columns: var(--sidebar-w) 1fr var(--info-w);
  grid-template-rows: var(--topbar-h) 1fr auto;
  grid-template-areas:
    'sidebar topbar info'
    'sidebar main  info'
    'sidebar input info';
}
```

侧栏收起（`data-sidebar-collapsed="true"`）：grid-template-columns 改为 `var(--sidebar-collapsed-w) 1fr var(--info-w)`。
信息面板收起（`data-info-collapsed="true"`）：改为 `var(--sidebar-w) 1fr var(--info-collapsed-w)`。

## 9. 设计系统

### 9.1 三主题色彩

| Token | Midnight (暗) | Forest (暗) | Dawn (亮) |
|---|---|---|---|
| `--color-bg` | `#09090B` | `#0F172A` | `#FAFAFA` |
| `--color-surface` | `#18181B` | `#1E293B` | `#FFFFFF` |
| `--color-surface-elevated` | `#27272A` | `#272F42` | `#F4F4F5` |
| `--color-card` | `#1C1C1F` | `#1B2336` | `#FFFFFF` |
| `--color-text` | `#F4F4F5` | `#F8FAFC` | `#18181B` |
| `--color-subtext` | `#A1A1AA` | `#94A3B8` | `#71717A` |
| `--color-accent` | `#6366F1` (Indigo) | `#22C55E` (Green) | `#6366F1` (Indigo) |
| `--color-success` | `#22C55E` | `#22C55E` | `#16A34A` |
| `--color-warning` | `#FBBF24` | `#FBBF24` | `#D97706` |
| `--color-danger` | `#EF4444` | `#EF4444` | `#DC2626` |
| `--color-border` | `#27272A` | `#2D3A4F` | `#E5E5E5` |

每个主题还定义 8 个 soft 色变量（低透明度版本，用于 badge/pill/highlight 背景）：

| Soft Token | Midnight | Forest | Dawn |
|---|---|---|---|
| `--color-accent-soft` | `rgba(99,102,241,0.15)` | `rgba(34,197,94,0.15)` | `rgba(99,102,241,0.10)` |
| `--color-success-soft` | `rgba(34,197,94,0.15)` | `rgba(34,197,94,0.15)` | `rgba(22,163,74,0.10)` |
| `--color-warning-soft` | `rgba(251,191,36,0.15)` | `rgba(251,191,36,0.15)` | `rgba(217,119,6,0.12)` |
| `--color-danger-soft` | `rgba(239,68,68,0.15)` | `rgba(239,68,68,0.15)` | `rgba(220,38,38,0.10)` |
| `--color-subtext-soft` | `rgba(161,161,170,0.12)` | `rgba(148,163,184,0.12)` | `rgba(113,113,122,0.10)` |

Midnight.css 包含 `:root` fallback 块（CSS 级安全网，JS 未执行时仍可用）。

### 9.2 Token 体系

每个主题 CSS 定义完整的 token 体系（非仅颜色）：

- **圆角**：`--radius-sm` 4px / `--radius-md` 6px / `--radius-lg` 8px / `--radius-full` 9999px
- **间距**：`--sp-1` 4px → `--sp-8` 32px（8px 基数）
- **字号**：`--fs-xs` 12px → `--fs-2xl` 32px
- **字体**：`--font-sans` (Inter) / `--font-mono` (JetBrains Mono) / `--font-display` (Space Grotesk)
- **阴影**：`--shadow-sm` / `--shadow-md` / `--shadow-lg`
- **z-index**：`--z-base` 0 / `--z-sticky` 10 / `--z-overlay` 50 / `--z-modal` 100
- **动画时长**：`--t-fast` 120ms / `--t-normal` 200ms / `--t-slow` 300ms
- **毛玻璃**：`--glass-bg` (rgba 0.85) + `--glass-blur` 8px
- **布局尺寸**：`--sidebar-w` 240px / `--sidebar-collapsed-w` 48px / `--info-w` 280px / `--info-collapsed-w` 32px / `--topbar-h` 40px
- **token 间接层**：`--color-token-accent` / `--color-token-text` / `--color-token-cyan` / `--color-token-yellow` / `--color-token-red` / `--color-token-subtext`（保留给 `token-map.ts`）

### 9.3 字体

- **UI sans**：Inter（界面文字，中性高可读）
- **Mono**：JetBrains Mono（代码块、工具输出、diff、shell 命令）
- **Wordmark**：Space Grotesk（仅品牌标识，`--font-display` 变量）

通过 `global.css` 的 Google Fonts `@import` 加载。

### 9.4 图标

Lucide React（SVG，1.5px 描边）。零 emoji。

| 位置 | 图标 |
|---|---|
| 侧栏·项目 | `FolderOpen` |
| 侧栏·设置 | `Settings` |
| 侧栏·添加项目 | `FolderPlus` |
| 顶栏·模型 | `Cpu` |
| 顶栏·目录 | `FolderClosed` |
| 信息面板·状态 | `Activity` |
| 信息面板·上下文 | `Gauge` |
| 信息面板·工具调用 | `Wrench` |
| 信息面板·文件 | `FileEdit` / `FilePlus` |
| 信息面板·权限 | `ShieldCheck` |
| 信息面板·系统提示 | `Terminal` |
| 信息面板·日志 | `ScrollText` |
| 设置·通用 | `SlidersHorizontal` |
| 设置·模型 | `Cpu` |
| 设置·权限 | `ShieldCheck` |
| 新建会话 | `Plus` |
| 压缩 | `Archive` |
| 清空 | `Eraser` |
| 发送 | `ArrowUp` |
| 停止 | `Square` |
| 命令面板 | `Search` |
| 消息角色·user | `User` |
| 消息角色·assistant | `Bot` |
| 消息角色·thinking | `Brain` |
| 消息角色·tool | `Wrench` |
| 消息角色·error | `AlertCircle` |

### 9.5 品牌标识

**Mark**：Lucide `Egg` 图标为主体，Lucide `PawPrint` 缩小至 0.35 比例叠在蛋右上区域。两个图标单色描边，跟随 `--color-accent`。Hover 微动效：paw 轻微弹跳（`translateY(-1px)` + transition），尊重 reduced-motion。

**Wordmark**："DogEgg" 用 Space Grotesk（`--font-display` 变量），统一字体颜色，不再拆分字母高亮。

侧栏顶部：mark + wordmark。收起态仅显示 mark。

### 9.6 Primitives 组件层

`components/primitives/` 提供统一基础组件，消除各处手写样式不一致：

| 组件 | 说明 |
|---|---|
| `Button` | variant: primary/secondary/danger/ghost，size: sm/md |
| `IconButton` | 统一 32×32 方形按钮，hover surface-elevated |
| `Toggle` | 统一开关组件 |
| `Badge` | variant: accent/warning/success/danger/neutral |

> 注：`Input`/`Textarea`/`SelectField`/`EditableField`/`Tooltip`/`Card`/`Section` 曾在初始设计中规划但未实际使用（settings 组件自己定义了表单组件，info-panel 自己定义了 InfoCard），已在架构清理中移除。如需重新引入，在 `field.tsx`/`button.tsx` 中实现并从 `index.ts` 导出。

### 9.7 动画

| 场景 | 动画 | 时长 | 缓动 |
|---|---|---|---|
| 消息块入场 | slide-up + fade (`block-in`) | 200ms | ease-out |
| Modal 入场 | scale + fade (`modal-enter`) | 200ms | ease-out |
| 工具运行中 | spinner 旋转 (`spin`) | — | linear loop |
| 思考/响应中 | 状态点脉冲 (`pulse-dot`) | 1s loop | ease-in-out |
| 命令面板高亮 | accent 边框 + soft 色光晕 | 300ms | ease |

全部 CSS `@keyframes` + `transition`，零运行时依赖。`prefers-reduced-motion: reduce` 用通配 `*` 选择器覆盖所有 animation/transition，禁用循环和入场动画。

### 9.8 信息面板 8 section

右侧信息面板包含 8 个可折叠 `InfoCard`（默认折叠的标注）：

| Section | 默认 | 内容 | 高亮 key |
|---|---|---|---|
| Status & Model | 展开 | STATUS_CONFIG 图标+色+文字 + provider/model | `status` |
| Context | 展开 | 进度条 + token 数字 | `context` |
| Tool Calls | 展开 | 工具调用列表（seq + 状态图标 + 权限标签） | `toolcalls` |
| Files Touched | 折叠 | 从 tool_start input.path 提取的文件列表 | `files` |
| Available Tools | 折叠 | 工具列表 + config 权限标签 | `tools` |
| Session Permissions | 折叠 | allow_always 授权列表 + 撤销按钮 | `permissions` |
| System Prompt | 折叠 | 路径 + 内容预览 | `system` |
| Log Tail | 折叠 | 日志尾部 | `log` |

`InfoCard` 的 `highlight` prop 触发 accent 边框 + soft 色光晕 + 自动展开。

### 9.9 消息块视觉

按 kind 分化渲染（不再统一色条）：
- **UserBlock**：右对齐气泡（accent-soft 背景）
- **AssistantBlock**：头像 + markdown body
- **ThinkingBlock**：warning 卡片（warning-soft 背景 + 左 3px 边框 + mono body）
- **ToolBlock**：状态卡片（20px 图标框 + 工具名 + 状态图标 done/running/error）
- **ErrorBlock**：danger 卡片
- **NoticeBlock**：subtext 提示

markdown 用 `react-markdown` + `rehype-highlight` 组件式渲染（不走 `dangerouslySetInnerHTML`，消除 XSS 风险），样式统一在 `markdown.module.css`（含 table/th/td + highlight.js 语法高亮主题 + 代码块 hover 复制按钮）。

## 10. 构建与开发

### 10.1 脚本（根 package.json 新增）

```json
{
  "scripts": {
    "dev": "npm run build && npm run start",
    "dev:web": "concurrently -n server,web -c yellow,cyan \"cross-env VITE_DEV=1 PORT=3001 tsx main-web.ts\" \"wait-on tcp:3001 && vite\"",
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

- `dev:web`：server（cross-env VITE_DEV=1 PORT=3001 tsx main-web.ts）+ Vite dev server（wait-on tcp:3001 && vite）。Vite proxy `/api/*` 到 3001。
- `build:web`：Vite build → `dist/web/`（静态文件）+ esbuild → `dist/server.js`（server bundle）。
- `start:web`：node 跑 dist/server.js，serve dist/web/ 静态文件 + 跑 agent。
- TUI 脚本不变。
- 运行时依赖：`react-markdown`、`rehype-highlight`、`highlight.js`（WebUI markdown 渲染）。
- 开发依赖：`vite`、`@vitejs/plugin-react`、`concurrently`、`cross-env`、`wait-on`、`lucide-react`。

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
| **P3** | WebUI 骨架：App + SSE client + 侧栏 + 聊天视口 + 消息块 + 输入栏 + 顶栏 | 浏览器打开能看到消息流 |
| **P4** | WebUI 完整面板：信息面板（8 section）+ 设置面板（IDE 风格）+ 命令面板（Cmd+K）+ 权限 banner + 确认弹窗 + fs-browser | 全功能对等验证 |
| **P5** | 设计系统：三主题 + Primitives 组件层 + 动画 + 品牌标识 + Lucide 图标 | 视觉 gate（judge） |
| **P6** | 构建流水线：vite.config + build-web.mjs + dev:web/start:web 脚本 + 架构测试扩展 | typecheck + test + build:web + start:web |

## 13. 不做（v1 范围外）

- 多会话并行执行（多 Agent 实例 + 消息带 sessionId）—— ADR-0005
- Electron 集成 —— 路线 A 后续阶段
- WebSocket 传输 —— SSE 足够
- 用户认证 / 多用户 —— 单用户学习项目
- /quit 在 WebUI 的支持 —— 关标签页即退出
