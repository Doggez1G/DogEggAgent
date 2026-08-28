# 04 · 工具系统

## 工具契约

每个工具是一个 `Tool` 对象，有**双 schema**——zod schema 运行时校验 LLM 返回的参数，OpenAI JSON schema 暴露给 LLM：

```ts
// agent/src/tools/types.ts
interface Tool {
  name: string
  description: string
  schema: z.ZodTypeAny              // 运行时 zod 校验
  parameters: Record<string, unknown>  // 暴露给 LLM 的 OpenAI function schema
  execute(args, ctx): Promise<ToolResult>
}

type ToolResult = { content: string } | { error: string }
```

**为什么双 schema**：zod schema 和 OpenAI JSON schema 是不同形状。维护两者确保运行时校验和 LLM 看到的一致。

**ToolResult 是 union 而非 throw**——工具失败返回 `{error}`，成为 tool 消息回填模型，不中断 loop。

## 工具注册表

```ts
// agent/src/tools/registry.ts
const tools: Tool[] = [readFileTool, writeFileTool, editFileTool, shellTool]

function toolSchemas(): object[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}
```

`toolSchemas()` 组装为 OpenAI `tools` 参数格式，发给模型。模型返回 `tool_calls` 时用 `name` 匹配工具。

## 每工具的结构

每个工具是一个文件夹：`schema.ts`（定义）+ `execute.ts`（实现）+ `index.ts`（组装）。

以 `edit_file` 为例：

```ts
// schema.ts
export const editFileSchema = z.object({ path: z.string(), old_string: z.string(), new_string: z.string() })

// execute.ts
export async function editFileExecute(args, ctx): Promise<ToolResult> {
  const { path, old_string, new_string } = args as z.infer<typeof editFileSchema>
  const text = await readFile(join(ctx.cwd, path), 'utf8')
  if (!text.includes(old_string)) return { error: 'old_string 未找到' }
  await writeFile(join(ctx.cwd, path), text.replace(old_string, new_string), 'utf8')
  return { content: '已替换 1 处' }
}

// index.ts
export const editFileTool: Tool = {
  name: 'edit_file',
  description: '将文件中首次出现的 old_string 精准替换为 new_string',
  schema: editFileSchema,
  parameters: { type: 'object', properties: { ... }, required: ['path', 'old_string', 'new_string'] },
  execute: editFileExecute,
}
```

## 工具执行：executeOneTool

loop 串行调用 `executeOneTool`，它处理参数解析、权限分支、执行/拒绝：

```ts
// agent/src/loop/tool-calls.ts
async function executeOneTool(call, deps, isLast, reasoning): Promise<ToolStep> {
  // 1. 未知工具：发 tool_end（R3：拒绝/失败也可见）
  const tool = deps.tools.find((t) => t.name === call.function.name)
  if (!tool) {
    deps.emit({ type: 'tool_end', id: call.id, ... error: `未知工具 ${call.function.name}` })
    return { toolMessage: { role: 'tool', tool_call_id: call.id, content: `未知工具` }, transitionInput: rejectOrDone() }
  }

  // 2. 参数解析校验：JSON.parse + zod
  let args
  try { args = tool.schema.parse(JSON.parse(call.function.arguments || '{}')) }
  catch { /* 发 tool_end error '参数校验失败' */ }

  // 3. 权限分支
  const verdict = deps.permission.classify(tool.name)

  if (verdict === 'reject') {
    // 配置层拒绝：发 tool_end，回填明确提示让模型停止重试
    deps.emit({ type: 'tool_end', ... })
    return { toolMessage: { ... content: '用户拒绝了此工具调用，请勿再次尝试同一工具' }, ... }
  }

  if (verdict === 'ask') {
    deps.trans({ kind: 'tool_needs_permission' })  // → waiting_permission
    const decision = await deps.requestPermission(tool.name, args)
    if (decision === 'reject') { /* 同上 */ }
    deps.trans({ kind: 'allow' })  // → executing
  }

  if (verdict === 'allow') {
    deps.trans({ kind: 'tool_auto' })  // → executing
  }

  // 4. 执行工具
  const message = await runAndEmit(call, tool, args, toolCtx, deps.emit)
  return { toolMessage: message, transitionInput: backOrDone() }
}
```

### isLast 决定迁移

```ts
const rejectOrDone = () => isLast ? { kind: 'reject', reasoning } : { kind: 'tool_done' }
const backOrDone = () => isLast ? { kind: 'result_back', reasoning } : { kind: 'tool_done' }
```

- 非最后一个工具：`tool_done` → 回到 `tool_calling`，继续执行下一个。
- 最后一个工具：`result_back`/`reject` → 重新请求模型。

### 拒绝回填防循环

拒绝时回填的不是简单的 `'denied'`，而是明确提示：

> "用户拒绝了此工具调用，请勿再次尝试同一工具，改用其它方式或询问用户。"

否则模型可能在下轮重新尝试同一工具 → 再次触发权限请求 → 循环。

## runAndEmit：执行 + emit + try/catch

```ts
async function runAndEmit(call, tool, args, ctx, emit): Promise<Message> {
  emit({ type: 'tool_start', id: call.id, name: tool.name, input: args })
  let result
  try {
    result = await tool.execute(args, ctx)     // 工具可能 throw！
  } catch (e) {
    const errMsg = String(e)
    emit({ type: 'tool_end', id: call.id, ..., error: errMsg })
    return { role: 'tool', tool_call_id: call.id, content: errMsg }
  }
  const content = 'content' in result ? truncate(result.content) : `ERROR: ${result.error}`
  emit({ type: 'tool_end', id: call.id, ..., error: 'error' in result ? result.error : undefined })
  return { role: 'tool', tool_call_id: call.id, content }
}
```

**try/catch 兜底**：工具 `execute` 可能抛异常（如 spawn ENOENT），必须保证 `tool_start` 总有配对的 `tool_end`。

## Shell 工具的取消三件套

```ts
// agent/src/tools/shell/execute.ts
export function shellExecute(args, ctx): Promise<ToolResult> {
  const child = spawn(program, [flag, command], { cwd: ctx.cwd, detached: !isWin })
  // 取消三件套之一：把 killTree 挂在 abort 上
  const onAbort = () => killTree(child)
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  child.on('close', (code) => {
    ctx.signal.removeEventListener('abort', onAbort)
    resolve({ content: `exit=${code}\n${out}` })
  })
}
```

**取消三件套**：
1. `AbortController` 中断 LLM fetch 请求
2. `signal.addEventListener('abort', ...)` 杀 shell 进程树
3. loop 每次迭代/工具间 `checkCancelled()` 检查取消标志

### killTree 进程树终止

```ts
// agent/src/tools/shell/kill-tree.ts
// Windows: taskkill /PID /T /F（杀整棵树）
// POSIX: process.kill(-pid, 'SIGKILL')（杀进程组，需 detached: true）
```

Windows 不设 `detached`（taskkill /T 不需要进程组）；POSIX 设 `detached: true` 让子进程在独立进程组，`kill(-pid)` 能杀整组。

### interpreter 解释器解析

```ts
// agent/src/tools/shell/interpreter.ts
// cmd → {cmd, /c}，powershell → {powershell, -Command}，bash → {bash, -c}
// 非 ASCII 值（如误存的占位文本）回退到平台默认
```
