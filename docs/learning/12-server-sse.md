# 12 · Server 与 SSE 传输

Server 包（`@dogegg/server`）是 WebUI 的传输层——实现 bridge 的 Port 接口，用 HTTP SSE 下行 + POST 上行。agent 和 ui 都不改，server 在它们之间做传输适配。

## 目录结构

```
server/src/
├─ index.ts               # 纯 re-export
├─ http/
│  ├─ server.ts           # startServer()：http.createServer + 绑定 127.0.0.1 + 路由分发
│  └─ routes.ts           # 路由表 + 请求分发 + 静态文件 + CORS + 路径穿越防护
├─ channel/
│  └─ sse.ts              # createSseChannel()：SSE Port 实现 + POST zod 校验
├─ fs/
│  └─ browse.ts           # listDirs(path, includeFiles)：安全目录浏览
└─ shells/
   └─ detect.ts           # detectShells()：execFileSync 无 shell + 缓存
```

## SSE Channel

`channel/sse.ts` 的 `createSseChannel()` 返回 `{ agentPort, sseHandler, postHandler }`：

```
agentPort.onMessage(cb)  ← postHandler 调用
agentPort.post(msg)      → 写入所有 SSE 连接

postHandler(req, res)    ← POST /api/message
  → 读取 body（1MB 上限）
  → JSON.parse
  → uiToAgentMessageSchema.safeParse（zod 校验）
  → agentListeners.forEach(l => l(msg))
  → 返回 200 ok / 400 invalid

sseHandler(req, res)     ← GET /api/events
  → 写 SSE 头（text/event-stream + no-cache + keep-alive）
  → 加入 sseClients Set
  → 连接关闭时移除
```

**关键设计**：
- **多标签页支持**：`sseClients` 是 `Set<ServerResponse>`，agent 发的消息 fan-out 到所有活跃连接。
- **POST zod 校验**：`uiToAgentMessageSchema.safeParse` 校验 POST body 结构——畸形消息返回 400 + zod 错误详情，不进入 agent 的 switch 分发。
- **Body 大小限制**：1MB 上限防止恶意大 body 耗尽内存。
- **无 uiPort**：SSE 传输天生不对称（下行 SSE / 上行 POST），不存在对称的 uiPort。UI 侧的 Port 由浏览器 `sse-client.ts` 独立创建。

## HTTP 路由

`routes.ts` 的 `dispatchRequest` 按顺序处理：

1. **CORS 预检**（OPTIONS）：检查 `Origin` header 是否为 localhost（`localhost` / `127.0.0.1` / `[::1]`），匹配才返回 `Access-Control-Allow-Origin` + `Vary: Origin`。非 localhost 来源不设 CORS header——防止跨站驱动 shell 执行。
2. **非 OPTIONS 请求**也设 CORS header（仅 localhost 来源）。
3. **API 路由匹配**：`/api/events`（SSE）、`/api/message`（POST）、`/api/fs`（目录浏览）、`/api/shells`（shell 检测）。
4. **静态文件**（生产模式）：从 `dist/web/` serve，路径穿越防护用 `path.resolve` + `path.relative` 检查（非 `fileURLToPath`）。SPA fallback 到 `index.html`。
5. **404**（开发模式，非 API 路径）。

## 安全设计

| 措施 | 实现 |
|---|---|
| localhost 绑定 | `server.listen(port, '127.0.0.1')`（可通过 `HOST` 环境变量覆盖） |
| CORS Origin allowlist | 检查 `Origin` header 是否 localhost，非 localhost 不设 CORS header |
| POST zod 校验 | `uiToAgentMessageSchema.safeParse` 校验消息结构 |
| Body 大小限制 | 1MB，超限返回 413 |
| 路径穿越防护 | `path.resolve` + `path.relative` 检查（非脆弱的 `startsWith`） |

## 组合根

`main-web.ts` 是 WebUI 的组合根——唯一 import agent + server 的地方：

```ts
const config = new ConfigStore().load()
const channel = new SseChannel()      // SseChannel 本身就是 AgentPort
const logger = new Logger(join(homedir(), '.dogegg', 'logs'))
new Agent(channel, config, process.cwd(), { logger })
new HttpServer({ router: new Router({ channel }), staticDir, port: 3000 }).start()
```

- **不 import ui**——前端是静态文件被 serve，不是代码被 import。
- **开发模式**（`VITE_DEV=1`）：`staticDir=null`，非 API 路径返回 404（前端由 Vite dev server 代理）。
- **生产模式**：`staticDir` 指向 `dist/web/`，server serve 静态文件。

## REST 端点

### /api/fs — 目录浏览

`FsBrowser.listDirs(path, includeFiles)`：
- `fs.readdir(path, { withFileTypes: true })` 返回目录列表。
- `includeFiles=true` 时也返回文件名（供 system prompt 文件选择器用）。
- 返回 `{ current, dirs, files, parent }`。

### /api/shells — Shell 检测

`shells/detect.ts` 的 `detectShells()`：
- 用 `execFileSync`（无 shell）检测系统可用 shell（powershell / pwsh / cmd / bash / zsh / sh）。
- 结果缓存——首次调用后不再重复检测。
- 返回 `{ value, label }[]` 供设置面板的 Shell Program 下拉框使用。

### 启动入口与 shell 检测补记

- **生产启动走统一 CLI**：`dogegg -web`（`bin/dogegg.ts` → `dist/dogegg.js`），server 的 `startServer` 由它装配；`main-web.ts` 仅用于 `dev:web` 开发模式（tsx 直跑 + Vite dev server 代理）。`staticDir` 由 `import.meta.dirname` 解析——构建产物下即 `dist/web/`，启动前校验存在（缺失提示先跑 `npm run build:web`）。
- **`shells/detect.ts` 已改 ESM**：顶层 `import { execFileSync } from 'node:child_process'`（早期函数内 `require()` 在 ESM/tsx 下抛 ReferenceError，已修复）。
- **TUI 有独立副本**：`ui/src/tui/config/shells.ts` 复刻了同一检测逻辑（TUI 同进程直接调用，不经 HTTP）——已知重复点，两处需同步维护候选名单。
