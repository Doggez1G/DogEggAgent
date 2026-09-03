# 05 · LLM 接入层

## 设计目标

不依赖 OpenAI SDK，用原生 `fetch` + 手写 SSE 解析。好处：零额外依赖、完全控制流、便于学习流式原理。

## 层级结构

```
LLM 接入层
├─ types.ts              # LlmStreamEvent / ChatRequest / ChatResult / ProviderAdapter
├─ adapter-for.ts         # protocol → adapter 分派
├─ provider/openai/
│  ├─ adapter.ts          # openAiAdapter：streamOnce + withRetry 组装
│  ├─ request.ts           # ChatRequest → HTTP body
│  ├─ stream.ts            # fetch + SSE 流读取循环 + 超时 + 错误分类
│  ├─ retry.ts             # 状态感知重试 + 指数退避 + Retry-After
│  └─ errors.ts            # HttpError / NetworkError / StreamTimeoutError / isRetryable
└─ streaming/openai/
   ├─ types.ts             # SSE chunk 类型形状
   └─ parser.ts            # 行驱动 SSE 解析器
```

## LlmStreamEvent

provider → agent loop 的底层流事件（不进 bridge，是 agent 内部层）：

```ts
type LlmStreamEvent =
  | { type: 'text_delta'; text: string }          // 答案文本
  | { type: 'thought_delta'; text: string }       // 推理内容
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argsJsonDelta: string }
  | { type: 'tool_call_end'; index: number; id: string; name: string; arguments: string }
  | { type: 'done'; message: Message; reasoning?: string }  // 最终消息 + 可选推理内容
  | { type: 'error'; error: Error }
```

> `done` 事件携带 `reasoning?` —— 推理模型的思考内容由 parser 累积，在 `[DONE]` 时随最终消息一起返回。这是 thinking 持久化的数据来源（见 03 章）。

## ProviderAdapter 与 ChatResult

```ts
interface ProviderAdapter {
  chat(req: ChatRequest, signal: AbortSignal, emit: (e: LlmStreamEvent) => void): Promise<ChatResult>
}

interface ChatResult {
  message: Message        // 组装好的 assistant 消息
  reasoning?: string      // 推理模型的思考内容（供持久化用——不进 history/context）
}
```

> `chat` 返回 `ChatResult`（含 `reasoning`），不是直接返回 `Message`。这样 loop 能把 reasoning 单独收集到 `thinking` 数组，与 history/context 分离。

## 错误分类

`errors.ts` 定义三种错误类型，每种带 `retryable` getter，供重试层判断可重试性：

```ts
// HTTP 错误——保留状态码，429/5xx 可重试，4xx fail-fast
class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly retryAfterMs?: number) { ... }
  get retryable(): boolean { return this.status === 429 || this.status >= 500 }
}

// 网络错误——fetch reject（DNS 失败、连接拒绝、ECONNRESET），可重试
class NetworkError extends Error { ... get retryable(): boolean { return true } }

// 流式超时——provider 接受连接但长时间不返回数据，可重试
class StreamTimeoutError extends Error {
  constructor(public readonly kind: 'idle' | 'absolute') { ... }
  get retryable(): boolean { return true }
}

// 统一判断函数——AbortError/CancelledError 不重试，未知错误默认不重试
function isRetryable(e: Error): boolean { ... }
```

**关键设计**：
- `HttpError` 保留 HTTP 状态码（之前直接 `throw new Error(`HTTP ${status}`)` 丢弃了状态码，重试层无法区分 400 和 429）。
- 429（Rate Limit）携带 `retryAfterMs`——从 `Retry-After` header 解析，优先于指数退避。
- 4xx（除 429）不可重试——请求本身有问题，重试也不会成功，fail-fast 节省时间。

## streamOnce：fetch + SSE 读取 + 超时

```ts
async function streamOnce(req, signal, emit): Promise<{ message: Message; reasoning?: string }> {
  const { url, init } = buildRequest(req)

  let res: Response
  try {
    res = await fetch(url, { ...init, signal })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new NetworkError(e)  // fetch reject → 网络错误
  }

  if (!res.ok || !res.body) {
    const retryAfter = res.headers.get('retry-after')
    throw new HttpError(res.status, `HTTP ${res.status}`, retryAfter ? parseRetryAfter(retryAfter) : undefined)
  }

  const parser = createOpenAiStreamParser()
  const reader = res.body.getReader()
  // ... buf 累积 + 逐行喂 parser（与之前相同）...

  // 绝对超时 120s + 空闲超时 15s
  const absoluteTimer = setTimeout(() => reader.cancel(new StreamTimeoutError('absolute')).catch(() => {}), 120_000)
  try {
    for (;;) {
      const idleTimer = setTimeout(() => reader.cancel(new StreamTimeoutError('idle')).catch(() => {}), 15_000)
      try {
        const { done, value } = await reader.read()
        if (done) break
        // ... buf + 逐行处理 ...
      } catch (e) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        if (e instanceof StreamTimeoutError) throw e
        throw new NetworkError(e)
      } finally {
        clearTimeout(idleTimer)
      }
    }
    // 处理残余行 ...
  } finally {
    clearTimeout(absoluteTimer)
  }

  if (!finalMessage) throw new Error('流未产生最终消息')
  return { message: finalMessage, reasoning: finalReasoning }
}
```

**双重超时机制**：
- **绝对超时（120s）**：整个请求从开始算，超过 120s 则中止。兜底极端情况（如 provider 无限发心跳但不返回数据）。
- **空闲超时（15s）**：每次 `reader.read()` 最多等 15s，无新数据则中止。提供更快的反馈。
- 两个超时都通过 `reader.cancel(new StreamTimeoutError(...))` 实现——中止读取循环，`read()` 会 reject。
- 超时后 `StreamTimeoutError` 是可重试的（`retryable = true`），重试层会自动重试。

**`parseRetryAfter`**：支持两种 `Retry-After` 格式——秒数（`"120"`）和 HTTP-date（`Wed, 21 Oct 2026 07:28:00 GMT`）。

## SSE 流式解析器

OpenAI 的流式响应是 SSE 格式——每行 `data: {JSON}`，最后 `data: [DONE]`。解析器是闭包式有状态函数：

```ts
// agent/src/llm/streaming/openai/parser.ts
export function createOpenAiStreamParser() {
  let content = ''
  let reasoning = ''                       // 累积推理内容
  const calls = new Map<number, PendingToolCall>()

  function buildMessage(): Message { ... } // 组装 assistant 消息

  return {
    feed(line: string): LlmStreamEvent[] {
      // ...
      if (data === '[DONE]') {
        // 逐 tool call 发 tool_call_end，再发 done（携带 reasoning）
        events.push({ type: 'done', message: buildMessage(), ...(reasoning ? { reasoning } : {}) })
        return events
      }
      // delta.content → text_delta
      // delta.reasoning_content ?? delta.reasoning → thought_delta + 累积 reasoning
      // delta.tool_calls → 按 index 累积 + tool_call_start/delta
    },
  }
}
```

**关键点**：
- `reasoning` 累积在 parser 内部，`[DONE]` 时随 `done` 事件返回——不进 `buildMessage()`（不写入 `message.content`）。
- `tool_calls` 按 `index` 累积（不是 `id`）——因为 id 可能比 start 晚到。
- `arguments` 分片拼接——LLM 返回的 tool_call 参数可能跨多个 SSE chunk 分片送达。
- 行驱动设计——`feed(line)` 一次处理一行，便于无网络单测（直接喂 mock SSE 行）。

## withRetry：状态感知重试

```ts
async function withRetry<T>(attempts: number, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let lastError: Error | null = null
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try { return await run() }
    catch (e) {
      lastError = e as Error
      if (!isRetryable(lastError)) throw lastError  // 不可重试 → fail-fast
      if (i < attempts - 1) await sleep(getBackoffDelay(lastError, i), signal)
    }
  }
  throw lastError!
}

function getBackoffDelay(error: Error, attempt: number): number {
  if ('retryAfterMs' in error && typeof (error as { retryAfterMs?: number }).retryAfterMs === 'number') {
    return (error as { retryAfterMs: number }).retryAfterMs  // 429: 优先用 Retry-After
  }
  return 500 * 2 ** attempt  // 其他: 指数退避（500ms, 1s, 2s...）
}
```

**与旧版的区别**：
- 旧版：`if (lastError.name === 'AbortError') throw`——除取消外一律重试，包括 400/401。
- 新版：`if (!isRetryable(lastError)) throw`——4xx fail-fast，只有 429/5xx/网络错误/超时才重试。
- 旧版：固定 `500 * 2 ** i` 退避。
- 新版：429 时优先用 `Retry-After` header 的值（尊重 API 的限流指导），其他用指数退避。

## adapterFor：protocol 分派

```ts
export function adapterFor(protocol: Config['providers'][number]['protocol']): ProviderAdapter {
  switch (protocol) {
    case 'openai': return openAiAdapter()
  }
}
```

agent 只调 `adapterFor(provider.protocol)`，不直接引用 `openAiAdapter`。v1 只支持 openai 协议，新增协议在此加分支即可。

## adapter 组装

```ts
export function openAiAdapter(): ProviderAdapter {
  return {
    async chat(req, signal, emit): Promise<ChatResult> {
      return withRetry(req.maxRetries + 1, () => streamOnce(req, signal, emit), signal)
    },
  }
}
```

`maxRetries + 1`——maxRetries=3 意味着 4 次总尝试（1 次原始 + 3 次重试）。
