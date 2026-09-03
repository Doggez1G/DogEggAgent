# 09 · TUI 前端

## 架构

TUI 用 Ink（React for CLI）渲染。App 组件通过 `UiPort` 收发消息，**不 import Agent**——解耦落点。

```
UI 层
├─ app/
│  ├─ app.tsx          # App 组件：状态持有 + 渲染骨架 + 键盘路由
│  ├─ view-state.ts    # View 视图态联合
│  └─ entry.tsx        # renderTui(port)：Ink render + alt-screen 进出
├─ config/              # 配置树编辑器纯函数（build/navigation/label/entries）
├─ components/          # 无状态展示组件（top-bar/message-block/status-bar/list-picker）
├─ theme/
│  ├─ palette.ts       # Catppuccin Mocha 调色板
│  └─ token-map.ts     # BlockKind→emoji, ColorToken→hex, BlockKind→角色标签
└─ markdown/render.ts   # markdown → 干净纯文本（用 marked Lexer 分词）
```

> **共享模块**：reducer、block、commands 已从 TUI 移到 `ui/src/shared/`（见下文），TUI 和 WebUI 共用。viewport.ts 和 browse.ts 仍是 TUI 专属（终端滚动/折叠逻辑），不进 shared。

## 共享层：Block 语义模型

`ui/src/shared/block.ts` 定义平台无关的消息块语义模型——不含任何终端/DOM 依赖：

```ts
type BlockKind = 'user' | 'assistant' | 'thinking' | 'tool' | 'error' | 'notice' | 'auto_compact'
type ColorToken = 'accent' | 'text' | 'cyan' | 'yellow' | 'red' | 'subtext'

interface Block {
  kind: BlockKind          // 语义角色
  color: ColorToken        // 语义色
  text: string             // 折叠时摘要
  full?: string            // 展开时完整内容（仅 thinking/tool）
  toolId?: string          // tool_start/tool_end 精确匹配
  toolInput?: unknown      // tool_start input，供 tool_end 格式化 diff
}
```

Block 只携带语义信息（kind + colorToken），**不含具体视觉值**（emoji / hex）。视觉映射归各 UI 的 theme 层：
- **TUI**：`token-map.ts` 把 `BlockKind → emoji`（🥚🐶🐾）、`ColorToken → hex`（palette 色）
- **WebUI**：`token-map.ts` 把 `BlockKind → Lucide SVG 图标`、`ColorToken → CSS variable`

## 共享层：reducer

`ui/src/shared/reducer.ts` 是纯函数，把 `AgentToUiMessage` 转换为 `ChatState`。TUI 和 WebUI 共用。

```ts
interface ChatState {
  blocks: Block[]
  status: State
  partial: { kind: 'assistant'|'thinking'; text: string } | null
}

function reducer(state: ChatState, msg: Action): ChatState {
  switch (msg.type) {
    case 'text_delta':    // 累积到 assistant partial；如果之前是 thinking partial 先 flush
    case 'thought_delta': // 累积到 thinking partial；如果之前是 assistant partial 先 flush
    case 'local_user':    // UI 本地动作——立即追加 user block（不等后端确认）
    case 'message':       // assistant 的 message → flush partial 落盘
    case 'tool_start':    // flush + 新建工具块（带 toolId）
    case 'tool_end':      // 按 toolId 找块，更新 text/full + diff 预览
    case 'state':         // cancelled/idle 时 flush partial（防止残留流式文本被下一轮拼接）
    case 'finished':      // flush + status='finished'
    case 'error':         // flush（保留半句文本）+ 错误块
    case 'session_ready': // rebuildBlocksFromHistory 重建所有块
    case 'compaction':    // 插入 auto_compact 提示块（before/after token 数）
    case 'history_cleared': // flush + 替换为单条 notice 块
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
  const kind: BlockKind = isThinking ? 'thinking' : 'assistant'
  const color: ColorToken = isThinking ? 'yellow' : 'text'
  return {
    ...state, partial: null,
    blocks: [...state.blocks, { kind, color, text: isThinking ? summary : fullText, ...(isThinking ? { full: fullText } : {}) }],
  }
}
```

思考块的 `text` 是摘要（前 3 行），`full` 是全文——折叠显示摘要，展开显示全文。

### tool_end 用 id 匹配 + diff 预览

```ts
case 'tool_end': {
  const idx = blocks.findIndex((b) => b.toolId === msg.id)  // 按 id 精确匹配
  if (idx >= 0) {
    const diffPreview = formatToolDiff(msg.name, target.toolInput)
    blocks[idx] = { ...target, text: `${target.text}\n${summary}`, full: [target.text, fullText, diffPreview].join('\n') }
  }
}
```

`formatToolDiff` 根据 toolName 格式化 diff 预览：edit_file 显示 old/new 对比、write_file 显示写入内容、shell 显示命令。

### rebuildBlocksFromHistory + thinking 对齐

resume 时从持久化的 history + thinking 数组重建 UI 块：

```ts
function rebuildBlocksFromHistory(messages: Message[], thinking: { text: string }[] = []): Block[] {
  let thinkingIdx = 0
  for (const m of messages) {
    if (m.role === 'assistant') {
      // 每条 assistant 消息消费一个 thinking 条目（含 content=null 的 tool_calls 消息）
      if (thinkingIdx < thinking.length) {
        const t = thinking[thinkingIdx]!
        if (t.text) {  // 空字符串跳过——这轮没开思考或没产生 reasoning
          blocks.push({ kind: 'thinking', color: 'yellow', text: summary, full: t.text })
        }
      }
      thinkingIdx++  // 每条 assistant 消息都递增（1:1 对齐）
      if (m.content) blocks.push({ kind: 'assistant', color: 'text', text: m.content })
    } else if (m.role === 'tool') {
      // 从 tool_calls + tool 消息配对重建工具块
    }
  }
}
```

**thinking 对齐原理**：
- `thinking` 数组每轮 LLM 调用产生一个条目（`run.ts` 中 `thinking.push({ text: deps.reasoning ? (result.reasoning ?? '') : '' })`）。
- 关闭思考时存空字符串（即使模型返回了 reasoning 也不记录）。
- `thinkingIdx` 每条 assistant 消息都递增——包括 content=null 的 tool_calls 消息——保证 1:1 对齐。
- 空字符串条目被跳过（不显示思考气泡），有内容的显示思考块。

## 视口滚动

```ts
// ui/src/tui/chat/viewport.ts（TUI 专属，不进 shared）
function buildDisplayBlocks(blocks, expanded, termWidth): DisplayBlock[] {
  return blocks.map((b, i) => {
    const expandable = (b.kind === 'thinking' || b.kind === 'tool') && b.full !== undefined
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
// ui/src/shared/commands.ts（已移到 shared，TUI 和 WebUI 共用）
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
