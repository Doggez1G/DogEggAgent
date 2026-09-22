# 03 - LLM 接入层

> 职责：把「context + 工具集 + 参数」翻译为对 provider 端点的流式 HTTP 请求，把响应 SSE 翻译回统一的增量事件流。agent 的其余部分（AgentLoop 等）只认识 `LlmClient` 接口与 `LlmStreamEvent`，对"OpenAI 兼容"这一实现细节无感知。全部代码住 `agent/src/llm/`。

## 1. 职责与边界

| 文件 | 职责 |
|---|---|
| `agent/src/llm/types.ts` | LlmStreamEvent / ChatRequest / ChatResult / LlmClient / LlmUsage 契约 |
| `agent/src/llm/client-for.ts` | protocol → client 分派（新增协议的唯一改动点） |
| `agent/src/llm/provider/openai/openai-client.ts` | OpenAiClient：重试编排（唯一对外类） |
| `agent/src/llm/provider/openai/stream.ts` | 单次流式请求：fetch → SSE 逐行读 → parser，两级超时 |
| `agent/src/llm/provider/openai/parser.ts` | 行驱动 SSE 解析器（可无网络单测） |
| `agent/src/llm/provider/openai/request.ts` | ChatRequest + 连接参数 → HTTP 请求体组装 |
| `agent/src/llm/provider/openai/retry.ts` | withRetry：指数退避 + Retry-After 尊重 |
| `agent/src/llm/provider/openai/errors.ts` | 三类可分类错误 + isRetryable 判定 |
| `agent/src/llm/provider/openai/sse-types.ts` | SSE chunk 最小类型形状（全字段可选、逐字段窄化） |

依赖矩阵中 `llm` 域依赖为空（architecture.test.ts:132-136）——它只依赖 bridge 的 Message 类型与自身，是最底层的无状态能力模块。

## 2. 核心数据结构

### 2.1 LlmStreamEvent——provider 到 loop 的七种流事件（types.ts:4-11）

```ts
export type LlmStreamEvent =
  | { type: 'text_delta'; text: string }            // 正文增量
  | { type: 'thought_delta'; text: string }         // reasoning 增量
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argsJsonDelta: string }  // 参数 JSON 分片
  | { type: 'tool_call_end'; index: number; id: string; name: string; arguments: string }
  | { type: 'done'; message: Message; reasoning?: string; usage?: LlmUsage }
  | { type: 'error'; error: Error }
```

设计原理：**流式通道（前五类增量）与终结通道（done 携带完整组装产物）分离**。AgentLoop 的 onEvent 回调只转发前三种（loop.ts:131-142），`tool_call_delta/tool_call_end` 仅供需要逐分片可见的消费者使用，done 的 `message` 是最终 assistant 消息（进 context/history），`reasoning` 单独携带供持久化——不进 history/context（types.ts:34-35），`usage` 是 API 精确用量。

### 2.2 ChatRequest 与连接参数分离（types.ts:15-22, 40-49）

```ts
export interface ChatRequest {
  model: string
  systemPrompt: string   // messages 只含 user/assistant/tool，system 由 client 自行拼接
  messages: Message[]
  tools: object[]
  maxOutput: number
  maxRetries: number     // 请求级而非连接级——压缩摘要等离线调用用更激进(小)的重试策略
}
export interface LlmClientConn { baseURL: string; apiKey: string }
```

`LlmClient.chat(req, signal, emit): Promise<ChatResult>`（types.ts:48）——signal 是取消传播的入口（见《02》§3.6），emit 是流事件出口。

### 2.3 ChatResult 与 LlmUsage（types.ts:26-38）

`LlmUsage { promptTokens, completionTokens, totalTokens }`——OpenAI snake_case 在 parser 转 camelCase（types.ts:24 注释）。精确值与本地粗估（context/token/estimate.ts）在 /context 面板并排展示，可见校准误差（types.ts:25 注释；载荷见 `context_state.lastTurn`）。

## 3. 关键流程走查

### 3.1 参数组装（request.ts:5-22）

1. URL：`baseURL.replace(/\/+$/, '') + '/chat/completions'`（request.ts:7）——容错尾斜杠；
2. Headers：`authorization: Bearer <apiKey>`（:10）；
3. Body 关键字段（:11-19）：`stream: true`；`stream_options: { include_usage: true }`——流式模式拿到真实用量（usage 随流末尾独立 chunk 返回，choices 为空数组）；`messages: [{ role:'system', content: systemPrompt }, ...req.messages]`——system 在此拼接（:4 注释）；`tools: req.tools`——**注册表 schemas() 现算值**，工具注册/摘除即时反映到下一次请求（《02》§3.2 第 5 步）；`max_tokens: req.maxOutput`。

**maxOutput 与 reasoning 的关系**：模型级 `maxOutput` 配置来自 config（bridge/src/contract/config.ts:7-12 的 modelSchema，默认 16384），经 `agent.current()`（agent.ts:159-171）→ `resolveTurnParams`（agent.ts:318-329）→ TurnParams → loop → 请求体。`model.reasoning`（config.ts:11）决定的是**状态机走向**（submit 后进 thinking 还是 responding，loop.ts:82）与 thought_delta 是否转发（loop.ts:136），而非请求体参数——ChatRequest 无 reasoning 开关，思考 token 自然计入 maxOutput 预算（title.ts:9-10 注释解释了这一预算竞争：离线调用给 512 而非 64 就是为此）。

### 3.2 SSE 解析（parser.ts:15-86，行驱动）

解析器是**行驱动**闭包 `feed(line) → LlmStreamEvent[]`（parser.ts:11 注释：便于无网络单测，直接喂 mock SSE 行）。内部累积状态：`content`（正文）、`reasoning`（思考全文）、`usage`、`calls: Map<index, PendingToolCall>`。

逐步：

1. 非 `data:` 开头的行（SSE 注释/心跳）静默跳过（parser.ts:32）；
2. `data: [DONE]`：按 index 排序逐 tool call 发 `tool_call_end`（组装完整 id/name/arguments），再发 `done`（buildMessage 组装 `content || null` + 按 index 排序的 tool_calls，:22-39）；
3. JSON.parse 失败返回空数组——坏行不炸流（:44-45）；
4. `json.usage` 存在（include_usage 的末尾 chunk）→ 归一化为 LlmUsage（:48-54）；
5. `delta.content` → 累积 + text_delta（:57-60）；
6. **reasoning 双字段兼容**：`delta.reasoning_content ?? delta.reasoning`（:63）——前者是 OpenAI 官方字段，后者是部分兼容端点的变体（sse-types.ts:10-12）；累积全文，done 携带供 resume 恢复思考块（:61-62 注释）；
7. **tool_calls 按 index 累积**（:68-82）：新 index → 记录条目并发 `tool_call_start`；`tc.id / tc.function.name` 非空则合并（OpenAI 协议里 name/id 往往随首个分片才到）；`tc.function.arguments` 追加到 `cur.args`（**参数可能分多次送达**，:13 注释）并发 tool_call_delta。关键时序立法：**tool_call_start 必须在字段合并之后发出**（:75-76 注释）——先合并再广播，下游 tool_pending 才能携带真实工具名而非空串。

### 3.3 单次流式请求（stream.ts:17-115）

1. **两级超时模型**（:7-12）：连接超时 `CONNECT_TIMEOUT_MS = 60s`（fetch 发起 → 响应头，含 DNS/TLS/首响）；空闲超时 `IDLE_TIMEOUT_MS = 60s`（相邻 chunk 最大间隔）。均**不含总时长上限**——持续出字节的流是健康的，生成长度由 maxOutput 决定（:7 注释）；
2. 连接超时用独立 AbortController 承载（:21-25）——超时 abort 与用户 abort 需区分归因（:20 注释）：`signal.aborted` → AbortError（用户取消，不重试）；`connectTimedOut` → StreamTimeoutError('connect')（可重试）；其余 → NetworkError（可重试）（:30-36）；
3. HTTP 非 2xx → `HttpError(status, msg, retryAfterMs)`（:40-47，Retry-After header 解析支持秒数与 HTTP-date 两种格式，:118-125）；
4. **读流循环**（:61-96）：每次 `reader.read()` 挂一个 60s 空闲定时器，超时 `reader.cancel(timeout)`；read reject 时区分 `signal.aborted`（AbortError）、StreamTimeoutError、NetworkError（:75-82）；数据按行切分喂 parser（`buf` 缓冲跨 chunk 的不完整尾行，:85-95）；
5. 残余行处理：连接关闭时最后一批字节可能无尾随换行（:99-104）；
6. **超时归因还原**（:109-113）：`reader.cancel` 会让后续 read 以 done"正常"结束——必须在循环外还原为 StreamTimeoutError（可重试），否则长生成被掐断时会误报成"流未产生最终消息"（:49-50 注释）——这是本文件最精巧的失败归因设计。

### 3.4 重试（retry.ts:7-45 + errors.ts）

1. `OpenAiClient.chat = withRetry(req.maxRetries + 1, () => streamOnce(...), signal)`（openai-client.ts:12）——maxRetries + 1 次尝试；
2. **可重试性判定**（errors.ts:39-47 的 `isRetryable`）：AbortError/CancelledError 永不重试（用户意图立即上抛）；HttpError 的 `retryable` getter = 429 或 ≥500（errors.ts:13-16）——4xx fail-fast，请求本身有问题重试也不会成功；NetworkError / StreamTimeoutError 恒可重试；未知错误默认不重试（:45-46，避免对未预期错误反复打）；
3. **退避策略**（retry.ts:27-33）：429 的 `retryAfterMs`（来自 Retry-After header）优先——尊重 API 限流指导；其余指数退避 500ms × 2^attempt；
4. **可中断 sleep**（retry.ts:36-44）：退避等待期间 signal abort 立即 reject，不等计时结束——取消的及时性在重试层同样成立；
5. 重试耗尽 → 最后一次错误上抛 → loop 的 catch 转 error 态（《02》§3.2 第 6 步）。

### 3.5 协议分派与实例生命周期（client-for.ts:7-12 + agent.ts）

1. `clientFor(protocol, conn)` 是 protocol → client 的唯一分派点（R6 立法）：agent 只调此函数不直接引用 OpenAiClient；`Config['providers'][number]['protocol']` 当前仅 `'openai'`（bridge/src/contract/config.ts:16）；将来新增协议 = 新增一个 LlmClient 实现加一个 case 分支，调用方一行不改（client-for.ts:5-6 注释）。
2. **连接参数归实例所有**：`OpenAiClient` 构造只收 `{baseURL, apiKey}`（openai-client.ts:9），同一 provider 的多个模型复用同一实例——模型名是请求级参数（ChatRequest.model），换模型不换连接（openai-client.ts:6 注释）。
3. **实例按需创建、无全局缓存**：两处调用点——轮次主循环（agent.ts:322 的 resolveTurnParams，每轮命令时刻解析）与压缩摘要（agent.ts:313 的 summarize 回调）。都现读 config（`resolveCurrent` + `current()`），配置热切换（换 provider/改 apiKey）后下一次调用自动用新连接，无失效问题。
4. **离线调用的参数预算**：同一 client 服务三种调用形态，各自立法 maxRetries/maxOutput——主循环用配置值（默认重试 3 次 + maxOutput 16384）；压缩摘要 `maxRetries: 1, maxOutput: 2000`（summarize.ts:36-37，摘要是唯一上下文不能截断）；标题生成 `maxRetries: 1, maxOutput: 512`（title.ts:30-31，给 64 会被推理模型思考烧光）。这正是 `maxRetries` 放在**请求级**而非连接级的原因（types.ts:14 注释）。

**一次完整的 done 组装示例**：模型流式返回 `{content: "我来", tool_calls: [{index:0, id:"a1", function:{name:"read_file"}}]} {tool_calls:[{index:0, function:{arguments:'{"pa'}}]} {tool_calls:[{index:0, function:{arguments:'th":"x"}}]} [DONE]`——parser 累积 content、按 index 0 合并 id/name/arguments 三分片，[DONE] 时发 `tool_call_end{arguments:'{"path":"x"}'}` + `done{message:{role:'assistant', content:'我来', tool_calls:[...]}}`。loop 收到 done 后把整条 assistant 消息 push 进 context（《02》§3.2 第 7 步），参数由 ToolExecutor 层 zod 校验——LLM 层不做参数语义校验。

## 4. 关键立法与不变量

- **INV-1**：agent 上层只依赖 `LlmClient` 接口 + `clientFor`，不感知具体 provider（R6）。
- **INV-2**：done 事件前必有完整增量序列；`tool_call_start` 在 name/id 合并后发出（parser.ts:75-76）。
- **INV-3**：取消（AbortError）在重试层零延迟上抛，永不重试（retry.ts:14-15）。
- **INV-4**：两级超时都归因到 StreamTimeoutError，与用户 AbortError 互不混淆（stream.ts:10 注释）。
- **INV-5**：ChatRequest.messages 不含 system——拼接是 client 的职责（request.ts:4），保证历史消息（OpenAI 线格式）可直接持久化回放。
- **INV-6**：`stream_options: { include_usage: true }` 恒开（request.ts:15）——真实用量是用量双口径（《09》§3.7）与压缩触发校准的数据前提。
- **INV-7**：tool_call 按 index 累积、done 时按 index 排序输出（parser.ts:23-25）——分片乱序到达不改变最终 tool_calls 顺序。
- **INV-8**：thought_delta 只在 `turn.reasoning` 为真时被 loop 转发（loop.ts:136）——配置关闭思考的模型即便端点返回 reasoning 也不进 UI，且 done.reasoning 被存空串占位（loop.ts:163）。

### 4.1 错误分类与用户感知的映射

错误从本层上抛后经过两站翻译，用户看到的形态由这两站决定：

1. **第一站（loop）**：AbortError → cancelled；其余 → trans error + LoopResult.error（《02》§3.2 第 6 步）；
2. **第二站（TurnRunner）**：emit `{type:'error', error:{message}}` → UI 聊天区错误块 + TUI 自动重填上次提交文本（use-agent-events onErrorRetry / use-turn-tracking retryText）。
3. 错误消息本身是人话（errors.ts 的构造文案）：`流式连接超时（服务器未及时响应）`、`流式空闲超时（长时间无数据）`、`网络错误: <cause>`、`HTTP <status>`——排查时无需看堆栈。

## 5. 失败模式与恢复

| 失败 | 分类 | 恢复 |
|---|---|---|
| HTTP 429 / 5xx | HttpError（retryable） | Retry-After 或指数退避后重试，耗尽上抛 |
| HTTP 4xx（除 429） | HttpError（不可重试） | fail-fast 上抛 → 轮次 error（如 apiKey 无效，重试无意义） |
| DNS/TLS/连接失败 | NetworkError（可重试） | 指数退避重试 |
| 连接超时（60s 无响应头） | StreamTimeoutError('connect') | 重试 |
| 空闲超时（60s 无 chunk） | StreamTimeoutError('idle') | 重试——归因还原设计防止误报"流未产生最终消息" |
| 用户取消 | AbortError | 不重试，直接上抛；loop 转 cancelled（《02》§3.6） |
| SSE 坏行/心跳 | parser 静默跳过 | 不中断流 |
| JSON.parse 失败（data 行内） | parser 返回空事件数组（parser.ts:44-45） | 该 chunk 丢弃，后续 chunk 正常 |
| 流结束无 done 消息 | throw '流未产生最终消息'（stream.ts:112） | 若由超时引起则还原为可重试超时；否则上抛 |
| tool_call 参数分片乱序/缺 index | index 缺省按 0（parser.ts:69）；done 时按 index 排序 | 最终消息形状不受分片时序影响 |
| usage 缺失 | usage undefined（部分兼容端点） | loop 的 turnUsage 累加跳过（loop.ts:154-157）——估算口径仍可用 |
| reasoning 字段缺失（普通模型） | reasoning undefined；loop 存空串 thinking 条目 | 思考块不显示，索引对齐不破坏 |

## 6. 与其它子系统的接缝

- **→ 02 轮次**：AgentLoop 消费 chat 的三事件转发（text_delta/thought_delta/tool_call_start → tool_pending）与 done 的 message/usage/reasoning。
- **← 10 配置**：baseURL/apiKey/model/maxOutput/reasoning/contextWindow 全部来自 config schema（config.ts:7-20）；`isConfigured`（config.ts:169-175）决定"能否发起请求"。
- **→ 07 MCP / 04 工具**：请求体 tools 参数来自注册表 schemas()——MCP 工具动态注册无需触碰本层。
- **→ 09 会话**：ChatResult.reasoning 持久化进会话文件 thinking 数组（conversation.ts:73-84），resume 后恢复思考块显示。
- **← 05 工具**：schemas() 的产物（OpenAI tools 参数）由本层原样进请求体——本层不理解工具语义，工具的执行回路完全在 turn/tools 域。
