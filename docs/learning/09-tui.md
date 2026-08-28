# 09 · TUI 前端

## 架构

TUI 用 Ink（React for CLI）渲染。App 组件通过 `UiPort` 收发消息，**不 import Agent**——解耦落点。

```
UI 层
├─ app/
│  ├─ app.tsx          # App 组件：状态持有 + 渲染骨架 + 键盘路由
│  ├─ view-state.ts    # View 视图态联合
│  └─ entry.tsx        # renderTui(port)：Ink render + alt-screen 进出
├─ chat/
│  ├─ block.ts         # Block 模型 + ICON/COLOR 映射
│  ├─ reducer.ts       # AgentToUiMessage → ChatState（纯函数）★可单测
│  ├─ viewport.ts      # 行估算 + 滚动窗口裁切（纯）
│  └─ browse.ts        # 块浏览焦点 + 折叠展开集合管理（纯）
├─ input/
│  └─ commands.ts      # 斜杠命令表 + parseCommand + matchCommands 联想
├─ overlays/
│  └─ config/          # 配置树编辑器（build/navigation/label）
├─ components/          # 无状态展示组件（top-bar/message-block/status-bar/list-picker）
├─ theme/palette.ts     # Catppuccin Mocha 调色板
└─ markdown/render.ts   # markdown → 干净纯文本
```

## 双层状态

- **后端 10 态**（State）：idle/thinking/responding/...——来自 `state` 事件。
- **UI 视图态**（View）：none/permission/menu/prompt/config/info——UI 自己的弹层状态机。

两者正交——后端在 `executing` 时 UI 可以在 `none`（正常显示）或 `permission`（弹权限框）。

## reducer：消息 → 聊天状态

```ts
// ui/src/tui/chat/reducer.ts
interface ChatState {
  blocks: Block[]                          // 已落盘的消息块
  status: State                            // 后端状态
  partial: { kind: 'assistant'|'thinking'; text: string } | null  // 进行中的流式块
}

function reducer(state: ChatState, msg: Action): ChatState {
  switch (msg.type) {
    case 'text_delta':    // 累积到 partial；如果之前是 thinking partial 先 flush
    case 'thought_delta': // 累积到 partial
    case 'message':       // assistant 的 message → flush partial 落盘
    case 'tool_start':    // flush + 新建工具块（带 toolId）
    case 'tool_end':      // 按 toolId 找块，更新 text/full
    case 'state':         // 更新 status
    case 'finished':      // flush + status='finished'
    case 'error':         // flush（避免幽灵块）+ 错误块
    case 'session_ready': // rebuildBlocksFromHistory 重建所有块
    case 'compaction':    // 自动压缩插提示块；手动不处理（app 弹 overlay）
    ...
  }
}
```

### flush：partial → block

```ts
function flush(state): ChatState {
  if (!state.partial) return state
  const isThinking = state.partial.kind === 'thinking'
  const fullText = state.partial.text
  // 思考块：折叠显示前 3 行摘要，展开显示全文（full）
  const summary = isThinking ? fullText.split('\n').slice(0, 3).join('\n') + ... : fullText
  return {
    ...state, partial: null,
    blocks: [...state.blocks, { icon: isThinking ? ICON.thinking : ICON.assistant, ..., ...(isThinking ? { full: fullText } : {}) }],
  }
}
```

思考块的 `text` 是摘要（前 3 行），`full` 是全文——折叠显示摘要，展开显示全文。

### tool_end 用 id 匹配

```ts
case 'tool_end': {
  const idx = blocks.findIndex((b) => b.toolId === msg.id)  // 按 id 精确匹配
  if (idx >= 0) {
    blocks[idx] = { ...target, text: `${target.text}\n${summary}`, full: `${target.text}\n${fullText}` }
  }
}
```

不靠数组尾部——notice/compaction 块可能插在 tool_start 和 tool_end 之间。

### rebuildBlocksFromHistory

resume 时从持久化的 history 重建 UI 块——从 `assistant.tool_calls` 提取工具名+参数，与 `tool` 消息按 `tool_call_id` 配对：

```ts
function rebuildBlocksFromHistory(messages: Message[]): Block[] {
  const pendingCalls = new Map<string, ToolCall>()
  for (const m of messages) {
    if (m.role === 'assistant') {
      if (m.tool_calls) for (const tc of m.tool_calls) pendingCalls.set(tc.id, tc)
      if (m.content) blocks.push({ icon: ICON.assistant, ... })
    } else if (m.role === 'tool') {
      const call = pendingCalls.get(m.tool_call_id)
      const toolName = call?.function.name ?? '工具'
      blocks.push({ icon: ICON.tool, text: `${toolName} ...\n✓ ${summary}`, full: `${toolName} ...\n✓ 完成\n${m.content}` })
    }
  }
}
```

**固有限制**：思考块是流式 `thought_delta` 产生的，不持久化进 history，resume 后无法恢复。

## 视口滚动

```ts
// ui/src/tui/chat/viewport.ts
function buildDisplayBlocks(blocks, expanded, termWidth): DisplayBlock[] {
  return blocks.map((b, i) => {
    const expandable = (b.icon === ICON.thinking || b.icon === ICON.tool) && b.full !== undefined
    const shownText = !expandable ? b.text : isExpanded ? (b.full ?? b.text) : b.text
    return { ...b, index: i, lines: estimateBlockLines(shownText, termWidth), shownText, isCollapsed: expandable && !isExpanded }
  })
}

function sliceViewport(displayBlocks, viewportHeight, scroll): DisplayBlock[] {
  // 按行数裁切可见窗口
}
```

只有有 `full` 的块可折叠（tool_end 后的工具结果、thinking 的完整推理）。

## 键盘路由

useInput 里按 view 类型分发：

```
Ctrl+C（全局，优先级最高）
  → 运行中：发 cancel 打断
  → 空闲：弹退出确认

permission view
  → ↑↓ 选决策，Enter 确认，Esc 拒绝

menu view
  → ↑↓ 选项，Enter 选中，Esc 返回

config view
  → ↑↓ 移动，Enter 钻入/编辑，←→ 切布尔，d 删除，Esc 返回

none view
  → /开头：↑↓ 联想选择，Enter/Tab 补全
  → 有可折叠块：↑↓ 浏览块，Enter 展开/折叠
  → 无可折叠块：↑↓ 召回输入历史，PageUp/PageDown 滚动

info view
  → ↑↓ 翻页，Esc 关闭
```

### Ctrl+C 处理

```ts
// ui/src/tui/app/entry.tsx
render(<App port={port} />, { exitOnCtrlC: false })  // 关键：不让 Ink 直接退出

// app.tsx useInput:
if (key.ctrl && inputChar === 'c') {
  resetSigintTimer()  // 重置 SIGINT 兜底计时器
  const running = statusRef.current !== 'idle' && ...
  if (running) port.post({ type: 'cancel' })      // 打断，不退出
  else /* 弹退出确认 */
}
```

entry.tsx 的 SIGINT handler 走"两次 Ctrl+C 兜底退出"——防 Ink 外卡死时强制退出。useInput 处理了 Ctrl+C 后调 `resetSigintTimer()` 清除兜底窗口。

### 联想补全

```ts
// ui/src/tui/input/commands.ts
const COMMANDS = [
  { cmd: '/new', desc: '新建会话' },
  { cmd: '/session', desc: '切换会话' },
  ...
]

function matchCommands(input: string): { cmd, desc }[] {
  if (!input.startsWith('/')) return []
  if (COMMANDS.find((c) => c.cmd === input)) return []  // 精确匹配不联想
  return COMMANDS.filter((c) => c.cmd.startsWith(input))
}
```

handleSubmit 里拦截——有联想匹配且选中时补全而非提交。Tab/Enter 都补全到输入框（不直接运行），需再按 Enter 提交。

## 状态栏

```tsx
// ui/src/tui/components/status-bar/view.tsx
function StatusBar({ state, provider, model, sessionId, tokens, windowTokens }) {
  const color = stateColor[state] ?? palette.subtext
  return (
    <Box gap={1}>
      <Text backgroundColor={palette.subtext} color={color}> ● </Text>
      <Text bold color={color}>{state}</Text>
      {provider && model && <Text dimColor>· {provider}/{model}</Text>}
      {sessionId && <Text dimColor>· #{sessionId}</Text>}
      {tokens && windowTokens && <Text dimColor>· {tokens}/{windowTokens}</Text>}
    </Box>
  )
}
```

`● state · provider/model · #sessionId · tokens/window`——落地 spec §13/§14 要求。
