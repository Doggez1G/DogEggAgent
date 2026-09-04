# 07 · 会话持久化与权限模型

## 会话持久化

### Session 文件结构

```json
{
  "id": "3f2a",
  "updatedAt": "2026-08-28T12:00:00.000Z",
  "history": [...],       // 完整原文（永不压缩）
  "context": [...],        // 发给模型的（可能压缩过）
  "allowedTools": ["read_file"],  // 会话级 allow_always 授权
  "cwd": "/home/user/project",     // 创建会话时的工作目录
  "thinking": [{ "text": "..." }]  // 每轮推理内容（resume 时恢复思考块）
}
```

存路径：`~/.dogegg/sessions/<id>.json`。

### 原子写

```ts
// agent/src/session/store.ts
export function saveSession(id, history, context, allowedTools = [], baseDir = defaultSessionsDir(), cwd = '', thinking = []): void {
  mkdirSync(baseDir, { recursive: true })
  const target = file(baseDir, id)
  const tmp = target + '.tmp'
  writeFileSync(tmp, JSON.stringify({ id, updatedAt: new Date().toISOString(), history, context, allowedTools, cwd, thinking }))
  renameSync(tmp, target)  // 原子：先写 .tmp 再 rename，崩溃时不会损坏原文件
}
```

`renameSync` 在大多数文件系统上是原子的——要么成功（新文件完全替换旧文件），要么失败（旧文件不受影响）。

### 旧格式迁移

```ts
export function loadSession(id, baseDir = defaultSessionsDir()): { id, history, context, allowedTools, cwd, thinking } {
  const raw = JSON.parse(readFileSync(file(baseDir, id), 'utf8'))
  const history = raw.history ?? raw.messages ?? []
  const context = raw.context ?? [...history]  // 必须拷贝！否则旧格式时 context 和 history 引用同一数组
  const allowedTools = raw.allowedTools ?? []
  const cwd = raw.cwd ?? ''
  const thinking = raw.thinking ?? []
  return { id: raw.id ?? id, history, context, allowedTools, cwd, thinking }
}
```

**`[...history]` 拷贝是关键**——旧格式（只有 `messages`）时 `context = history` 会让两者指向同一数组，push 时双写变三写。

`raw.id ?? id`——损坏文件可能缺 id 字段，回退到请求的 id。

### 删除会话

```ts
// agent/src/session/store.ts
export function deleteSession(id, baseDir = defaultSessionsDir()): void {
  const target = file(baseDir, id)
  if (existsSync(target)) unlinkSync(target)
}
```

文件不存在时静默成功（幂等）。`/session` 面板选中删除时 agent 调用它，删后 emit `session_deleted { id }` 让前端刷新列表。

### 思考持久化与对齐（thinking）

`thinking` 是每轮 LLM 调用收集的推理内容数组，存进 session JSON：

- **收集**：loop 每次 `adapter.chat` 后 push 一个条目（见 03 章）。只在 `deps.reasoning` 为真时记录实际 reasoning；关闭思考时存空字符串。
- **累积**：`agent.ts` 维护 `this.thinking`，loop 返回后 `this.thinking.push(...result.thinking)` 累积本轮条目，再通过 `saveSession(..., this.cwd, this.thinking)` 持久化。
- **resume**：`loadSession` 读回 `thinking`，`agent.ts` 赋值 `this.thinking = s.thinking`；`session_ready` 事件携带 `thinking` 数组（`this.thinking.length ? { thinking } : {}`）给前端。
- **对齐**：UI 端 `rebuildBlocksFromHistory` 按序把 thinking 条目与 assistant 消息 1:1 对齐——每条 assistant 消息消费一个 thinking 条目（含 `content=null` 的纯 tool_calls 消息）。空字符串条目被跳过，不显示思考气泡。

### cwd 持久化

session 存 `cwd`（创建会话时的工作目录）。`saveSession` 写入 `this.cwd`；resume 时 `loadSession` 读回，`agent.ts` 用 `s.cwd` 恢复 `this.cwd`——从项目 A 切到会话 B 再切回来，工作目录随之恢复，工具执行在原目录上下文中进行。

### 会话列表

```ts
// agent/src/session/list.ts
export function listSessions(baseDir = defaultSessionsDir()): { id, updatedAt, preview, cwd }[] {
  return readdirSync(baseDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const raw = JSON.parse(readFileSync(join(baseDir, f), 'utf8'))
        const history = raw.history ?? raw.messages ?? []
        const last = history[history.length - 1]
        const preview = last && last.role !== 'tool' && typeof last.content === 'string'
          ? last.content.slice(0, 40) : ''
        return { id: raw.id ?? f.replace('.json', ''), updatedAt: raw.updatedAt ?? '', preview }
      } catch {
        return { id: f.replace('.json', ''), updatedAt: '', preview: '（文件损坏）' }
      }
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))  // 降序：最新在前
}
```

**损坏文件不阻断列表**——每个文件 try/catch，损坏的返回占位项。按 `updatedAt` 降序排序方便查找。preview 取 history（不是 context）的末条非 tool 消息。

## 权限模型（两层）

### 配置层（静态三桶）

```json
{
  "permission": {
    "allow": ["read_file"],
    "reject": [],
    "ask": ["write_file", "edit_file", "shell"]
  }
}
```

| 桶 | 含义 |
|---|---|
| `allow` | 自动放行，不询问 |
| `reject` | 永远拒绝 |
| `ask` | 每次询问 |

### 运行时层（仅 ask 命中时）

用户决策三值：
- `allow_once`：仅放行本次
- `allow_always`：将工具在本会话内挪入允许
- `reject`：拒绝本次（回填明确提示，继续）

### classify 纯函数

```ts
// agent/src/permission/classify.ts
function classify(cfg, sessionAllowed, tool): 'allow' | 'reject' | 'ask' {
  if (cfg.reject.includes(tool)) return 'reject'      // reject 优先（最安全）
  if (cfg.allow.includes(tool) || sessionAllowed.has(tool)) return 'allow'
  return 'ask'                                         // 未列出默认 ask（倾向安全）
}
```

**reject 优先于 allow**——安全第一设计。未显式列出的工具默认 `ask`。

### PermissionManager

```ts
// agent/src/permission/runtime.ts
class PermissionManager {
  private sessionAllowed = new Set<string>()  // 运行时 allow_always 提升

  classify(tool) { return classify(this.cfg, this.sessionAllowed, tool) }
  apply(tool, decision) { if (decision === 'allow_always') this.sessionAllowed.add(tool) }
  reset() { this.sessionAllowed.clear() }      // 新建/切换会话时调
  revoke(tool) { this.sessionAllowed.delete(tool) }  // /permissions 撤销
  snapshot() { return new Set(this.sessionAllowed) }  // 配置编辑时保留授权
  listAllowed() { return [...this.sessionAllowed] }    // /permissions 查看
}
```

### 会话隔离

- **`/new` 新建会话**：调 `reset()` 清空 allow_always——新会话不继承旧授权。
- **`/session` 切换会话**：`reset()` 后从 session 文件的 `allowedTools` 恢复——切回来授权还在。
- **配置编辑**：重建 PermissionManager 时用 `snapshot()` 保留运行时授权——改配置不该丢会话授权。

### 拒绝回填防循环

拒绝时回填给模型的消息不是简单的 `'denied'`，而是明确提示：

> "用户拒绝了此工具调用，请勿再次尝试同一工具，改用其它方式或询问用户。"

否则模型可能在下轮重新尝试同一工具 → 再次触发权限请求 → 陷入循环。

### /permissions 命令

查看/撤销当前会话的 allow_always 授权：
- `permissions_request` → agent 返回 `permissions_list { tools: string[] }`
- 选中某项 → `permission_revoke { tool }` → agent 调 `revoke()` 后刷新列表
- 无授权时显示提示

### TUI 会话管理增强

- **CWD 过滤**：session picker 只显示 `s.cwd` 匹配当前工作目录的会话（路径归一化：反斜杠→正斜杠、小写、去尾斜杠）——Claude 式"每个目录独立的会话"。`currentCwdRef` 从 `status_state` 消息填充（启动时主动请求一次）。
- **搜索**：选择器内直接输入按预览/ID 实时过滤。
- **删除**：`d` 键删除当前选中会话（确认菜单 → `delete_session`），`session_deleted` 回包后刷新列表。
- **`/cd` 运行时切换**：`set_cwd` 消息切换 agent 工作目录（校验目录存在），影响后续工具执行与新会话落盘的 cwd。
