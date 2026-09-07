# 07 · llm：模型接入层

> agent 只认识一个接口（LlmClient），不认识任何具体厂商。本章讲这个抽象怎么设计、
> 流式怎么手写、重试怎么分类。

## 层级结构

```
llm/
├─ types.ts          # LlmClient / ChatRequest / ChatResult / LlmStreamEvent / LlmClientConn
├─ client-for.ts     # protocol + conn → client 实例（唯一分派点）
└─ provider/openai/  # 一协议一文件夹（加 anthropic/ 时照抄本模板）
   ├─ openai-client.ts  # OpenAiClient 类：连接参数归实例
   ├─ request.ts        # ChatRequest + conn → HTTP 请求
   ├─ stream.ts         # fetch + SSE 读取循环 + 超时
   ├─ parser.ts         # 行驱动 SSE 解析器（增量 → 事件）
   ├─ sse-types.ts      # SSE chunk 的最小类型形状
   ├─ retry.ts          # 状态感知重试 + 指数退避
   └─ errors.ts         # HttpError / NetworkError / StreamTimeoutError
```

## LlmClient：连接参数归实例所有

```ts
export interface LlmClient {
  chat(req: ChatRequest, signal: AbortSignal, emit: (e: LlmStreamEvent) => void): Promise<ChatResult>
}
export interface LlmClientConn { baseURL: string; apiKey: string }
```

重构前 `ChatRequest` 每次都要带 baseURL/apiKey——连接参数沿着调用链一层层传。现在它们归 `OpenAiClient` 实例所有：

```ts
export class OpenAiClient implements LlmClient {
  constructor(private readonly conn: LlmClientConn) {}
  async chat(req: ChatRequest, signal, emit) {
    return withRetry(req.maxRetries + 1, () => streamOnce(this.conn, req, signal, emit), signal)
  }
}
```

同一个 provider 的多个模型复用同一实例；`ChatRequest` 瘦身为纯业务参数（model/messages/tools/maxOutput）。`client-for.ts` 的 `clientFor(protocol, conn)` 是唯一分派点——加新协议在这里加一个 case，调用方一行不改。

## 流式：手写 SSE 的三个部件

不依赖 SDK，原生 fetch 手写流式（学习价值 + 零依赖 + 完全可控）：

1. **stream.ts——读取循环**：`res.body.getReader()` 逐块读，按换行切分喂给 parser。带两级超时：绝对 120s（兜底）+ 空闲 15s（单次 read 无数据则中止）。
2. **parser.ts——行驱动解析**：`feed(line)` 逐行处理，`tool_calls` 按 index 累积、arguments 分片拼接（流式下同一 tool call 的参数可能分多次到达），`[DONE]` 时发 `done` 事件并组装完整的 assistant 消息。行驱动的好处：**无网络单测**——直接喂 mock SSE 行就能测全部逻辑（`test/llm/streaming.test.ts`）。
3. **事件类型**：`LlmStreamEvent` 是 provider → loop 的底层流（text_delta / thought_delta / tool_call_* / done / error），`done` 携带 `reasoning?`——推理模型的思考内容由此单独收集，不进 history/context。

## 重试：按错误类型分级

```ts
// errors.ts——每种错误带 retryable 语义
class HttpError extends Error      // 429/5xx 可重试（Retry-After 优先），4xx fail-fast
class NetworkError extends Error   // DNS/连接失败，可重试
class StreamTimeoutError extends Error  // 流超时，可重试

// retry.ts——withRetry(attempts, run, signal)
// 指数退避 500ms * 2^n；sleep 可被外部 signal abort（退避期间取消立即生效）
```

**AbortError 永不重试**——取消是用户意图，必须立即上抛。这条和 loop 的「AbortError → CancelledError」转换（03 章）配合，构成完整的取消链路。

## ChatRequest 与 ChatResult

```ts
export interface ChatRequest {
  model: string
  systemPrompt: string
  messages: Message[]     // 仅 user/assistant/tool 历史；system 由 client 自行拼接
  tools: object[]
  maxOutput: number
  maxRetries: number
}
export interface ChatResult {
  message: Message        // 组装好的 assistant 消息
  reasoning?: string      // 推理内容（供持久化，不进 history/context）
}
```

`chat()` 返回 `ChatResult` 而非裸 Message——loop 要把 reasoning 单独收进 thinking 数组（与 history/context 分离，resume 后恢复思考块显示）。

## 加一个新协议的动作

新建 `llm/provider/anthropic/{index, anthropic-client, request, stream, retry?, errors?, parser}` 照抄 openai 模板，`client-for.ts` 加一个 case。loop、compactor、UI 全部零改动——它们只认识 `LlmClient` 接口。
