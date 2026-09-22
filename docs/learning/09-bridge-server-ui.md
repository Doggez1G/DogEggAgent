# 09 · bridge、server 与前端：契约与传输

> ⚠️ **存档**：本章为 v0.1 时代内容，部分已过时。当前版本学习指南见 [docs/versions/0.2/04-学习指南](../versions/0.2/04-学习指南/README.md)。

> agent 怎么和两个前端「说话」？答案是 bridge 里的一套消息契约 + 两种传输实现。
> 本章讲契约怎么设计、通道怎么实现、server 怎么把它们接到 HTTP 上。

## bridge：契约包（全项目最重要的包）

```
bridge/src/
├─ contract/                     # 数据形状 + zod 校验
│  ├─ shared.ts                  # State / Message / COMPACTION_THRESHOLD
│  ├─ config.ts                  # Config schema + isConfigured
│  ├─ permission.ts              # classifyPermission（三桶纯派生）
│  ├─ agent-to-ui.ts             # 下行消息 union（24 变体）
│  ├─ ui-to-agent.ts             # 上行消息 union（约 20 种命令）
│  ├─ agent-to-ui-schema.ts      # 下行 zod 校验（SSE 下行用）
│  └─ ui-to-agent-schema.ts      # 上行 zod 校验（POST body 用）
└─ channel/
   ├─ port.ts                    # AgentPort / UiPort 接口
   └─ in-memory.ts               # InMemoryChannel（进程内同步通道）
```

### Port：传输无关的约定

```ts
export interface AgentPort {
  onMessage(cb: (msg: UiToAgentMessage) => void): () => void  // 订阅，返回退订函数
  post(msg: AgentToUiMessage): void | Promise<void>           // 发后即忘
}
```

agent 只持有 `AgentPort`，永远不知道对面是进程内的函数调用还是一条 SSE 连接。**post 是单向、无返回值的**——模仿真实消息边界，UI 不能 await agent 的内部方法（想问状态就发 `status_request`，这是协议不是函数调用）。

### 两种通道实现

| | InMemoryChannel（TUI） | SseChannel（WebUI） |
|---|---|---|
| 下行（agent→UI） | 同步函数调用 | 写入所有活跃 SSE 连接（`data: {...}\n\n`） |
| 上行（UI→agent） | 同步函数调用 | POST /api/message → zod 校验 → 触发回调 |
| 多前端 | 单 pair | 多标签页共享同一事件流 |

两者都实现了 `AgentPort`——**agent 一行不改就能换传输**，这是 01 章「传输可替换」承诺的实体。

### 消息即 API

46 种消息就是 agent 的完整 API 面。上行按语义分三类，这决定了路由的守卫规则：

- **动工作集**（submit/compact/会话/配置编辑）：运行中阻塞，发 notice 不静默丢弃（R2）；
- **loop 控制**（cancel/permission_decision）：仅运行时有意义；
- **纯查询**（status/tools/context/system/log/permissions）：任意时刻放行。

下行每条消息 reducer 都认识——TUI 和 WebUI 用**同一份 reducer** 把消息流转成消息块，两端渲染必然一致。

## server：把通道接到 HTTP

```
server/src/
├─ channel/sse.ts      # SseChannel implements AgentPort
├─ http/http-server.ts # HttpServer：node:http server + CORS（仅 localhost）+ 分发
├─ http/router.ts      # Router：/api/events（SSE）、/api/message（POST）、/api/fs、/api/shells
├─ http/static-files.ts# 静态文件 + SPA fallback + 路径穿越防护
├─ fs/browse.ts        # FsBrowser：目录浏览（WebUI 文件选择器）
└─ shells/detect.ts    # ShellDetector：系统 shell 检测（结果缓存）
```

组合根（`main-web.ts`）的装配就是本章的总结：

```ts
const channel = new SseChannel()      // SseChannel 本身就是 AgentPort
new Agent(channel, config, process.cwd(), { logger })   // agent 直接收通道
new HttpServer({ router: new Router({ channel }), staticDir, port }).start()
```

安全四件套（WebUI 暴露在 HTTP 上，必须防）：仅绑定 127.0.0.1（可 HOST 覆盖）、CORS 仅 localhost 来源、POST body zod 校验 + 1MB 上限、静态文件路径穿越防护（resolve + relative 而非脆弱的 startsWith）。

## 前端怎么消费

- **TUI**（`ui/src/tui/`）：Ink 渲染 + `useReducer(reducer)` 消费消息流。Static 架构（ADR-0008）：完成的块打印进终端滚动缓冲区，动态区只渲染进行中的块——原生滚动、不劫持屏幕。
- **WebUI**（`ui/src/webui/`）：React + CSS Modules，`createSseUiPort()` 实现 UiPort（EventSource 收下行 + fetch POST 上行 + zod safeParse 校验），同一份 reducer。

两个前端共用的平台无关逻辑在 `ui/src/shared/`：Block 模型、reducer、commands 表、状态与提示文案（status）、权限展示规则（permission）、工具展示格式化（tool-display——折叠头行/展开正文/diff 行号，TUI 与 WebUI 的唯一出处）。前端的深化解读（Static 架构细节、组件设计）见 UI 批次的文档，本章只需记住：**前端是契约的消费者，不是 agent 的协作者**。
