# 05 · LLM 接入层

## 设计目标

不依赖 OpenAI SDK，用原生 `fetch` + 手写 SSE 解析。好处：零额外依赖、完全控制流、便于学习流式原理。

## 层级结构

```
LLM 接入层
├─ types.ts              # LlmStreamEvent / ChatRequest / ProviderAdapter
├─ adapter-for.ts         # protocol → adapter 分派
├─ provider/openai/
│  ├─ adapter.ts          # openAiAdapter：streamOnce + withRetry 组装
│  ├─ request.ts           # ChatRequest → HTTP body
│  ├─ stream.ts            # fetch + SSE 流读取循环
│  └─ retry.ts             # 重试 + 指数退避
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
  | { type: 'done'; message: Message }             // 最终组装的 assistant 消息
  | { type: 'error'; error: Error }
```

## SSE 流式解析器

OpenAI 的流式响应是 SSE 格式——每行 `data: {JSON}`，最后 `data: [DONE]`。解析器是闭包式有状态函数：

```ts
// agent/src/llm/streaming/openai/parser.ts
export function createOpenAiStreamParser() {
  let content = ''                    // 累积答案文本
  const calls = new Map<number, PendingToolCall>()  // 按 index 累积 tool_calls

  function buildMessage(): Message {
    const tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0])
      .map(([, c]) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } }))
    return { role: 'assistant', content: content || null, ...(tool_calls.length ? { tool_calls } : {}) }
  }

  return {
    feed(line: string): LlmStreamEvent[] {
      if (!line.startsWith('data:')) return []
      const data = line.slice(5).trim()
      if (data === '[DONE]') {
        // 逐 tool call 发 tool_call_end，再发 done
        ...
        events.push({ type: 'done', message: buildMessage() })
        return events
      }
      const json = JSON.parse(data) as SseChunk
      const delta = json.choices?.[0]?.delta ?? {}

      if (delta.content) { content += delta.content; events.push({ type: 'text_delta', text: delta.content }) }
      const r = delta.reasoning_content ?? delta.reasoning  // 两种字段名都支持
      if (r) { events.push({ type: 'thought_delta', text: r }) }
      for (const tc of delta.tool_calls ?? []) {
        // tool_call 参数分片到达——按 index 累积拼接
        const idx = tc.index ?? 0
        if (!calls.has(idx)) { calls.set(idx, { id: '', name: '', args: '' }); events.push(tool_call_start) }
        const cur = calls.get(idx)!
        if (tc.function?.arguments) { cur.args += tc.function.arguments; events.push(tool_call_delta) }
      }
      return events
    },
  }
}
```

**关键点**：
- `tool_calls` 按 `index` 累积（不是 `id`）——因为 id 可能比 start 晚到。
- `arguments` 分片拼接——LLM 返回的 tool_call 参数可能跨多个 SSE chunk 分片送达。
- `content || null`——纯 tool_calls 响应的 content 为 null（OpenAI 约定）。
- 行驱动设计——`feed(line)` 一次处理一行，便于无网络单测（直接喂 mock SSE 行）。

## streamOnce：fetch + SSE 读取

```ts
// agent/src/llm/provider/openai/stream.ts
async function streamOnce(req, signal, emit): Promise<Message> {
  const { url, init } = buildRequest(req)
  const res = await fetch(url, { ...init, signal })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

  const parser = createOpenAiStreamParser()
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let finalMessage: Message | null = null

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    // 逐行喂 parser（行可能跨 chunk，用 buf 缓冲）
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trimEnd()
      buf = buf.slice(nl + 1)
      for (const e of parser.feed(line)) {
        if (e.type === 'done') finalMessage = e.message
        else emit(e)
      }
    }
  }
  // 处理残余行（连接关闭时最后一批可能无尾随换行）
  if (buf.trim()) for (const e of parser.feed(buf.trim())) { ... }
  if (!finalMessage) throw new Error('流未产生最终消息')
  return finalMessage
}
```

**SSE 行缓冲**：TCP chunk 边界不一定对齐换行符——`buf` 缓冲未完整的尾行，下次 read 拼接。

## buildRequest：HTTP 请求构造

```ts
// agent/src/llm/provider/openai/request.ts
function buildRequest(req: ChatRequest): { url: string; init: RequestInit } {
  return {
    url: `${req.baseURL.replace(/\/+$/, '')}/chat/completions`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${req.apiKey}` },
      body: JSON.stringify({
        model: req.model,
        stream: true,
        messages: [{ role: 'system', content: req.systemPrompt }, ...req.messages],  // system 在此拼接
        tools: req.tools,
        max_tokens: req.maxOutput,
      }),
    },
  }
}
```

**system 消息在 adapter 拼接**——ChatRequest.messages 只含 user/assistant/tool 历史，不含 system。这把 system prompt 和对话历史分开管理。

## withRetry：重试 + 指数退避

```ts
// agent/src/llm/provider/openai/retry.ts
async function withRetry<T>(attempts: number, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let lastError: Error | null = null
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try { return await run() }
    catch (e) {
      lastError = e as Error
      if (lastError.name === 'AbortError') throw lastError  // 取消不重试
      if (i < attempts - 1) await sleep(500 * 2 ** i, signal)  // 指数退避
    }
  }
  throw lastError!
}

// 可被 abort 中断的 sleep
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
```

- **AbortError 不重试**——取消是用户意图。
- **指数退避**——500ms, 1s, 2s...，避免 rate-limit 时 hammer API。
- **sleep 可中断**——退避期间 cancel 能立即中断，不等计时结束。
- **signal 已 abort 时立即 reject**——不进入等待。

## adapterFor：protocol 分派

```ts
// agent/src/llm/adapter-for.ts
export function adapterFor(protocol: Config['providers'][number]['protocol']): ProviderAdapter {
  switch (protocol) {
    case 'openai': return openAiAdapter()
  }
}
```

agent 只调 `adapterFor(provider.protocol)`，不直接引用 `openAiAdapter`。v1 只支持 openai 协议，新增协议在此加分支即可。

## adapter 组装

```ts
// agent/src/llm/provider/openai/adapter.ts
export function openAiAdapter(): ProviderAdapter {
  return {
    async chat(req, signal, emit): Promise<Message> {
      return withRetry(req.maxRetries + 1, () => streamOnce(req, signal, emit), signal)
    },
  }
}
```

`maxRetries + 1`——maxRetries=3 意味着 4 次总尝试（1 次原始 + 3 次重试）。
