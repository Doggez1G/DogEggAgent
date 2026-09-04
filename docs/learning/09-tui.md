# 09 · TUI 前端

## 架构：Static + 终端原生滚动

TUI 用 Ink（React for CLI）渲染。App 组件通过 `UiPort` 收发消息，**不 import Agent**——解耦落点。

核心架构决策（见 ADR-0008）：**不使用 alt-screen**。消息历史经 Ink `<Static>` 直接打印进终端的正常滚动缓冲区，用户用**终端原生滚动**（鼠标滚轮/滚动条）查看历史；Ink 只重绘底部动态区。这彻底消除了"自己估算行数做视口裁切"的整类问题——行数估算永远无法与 Ink 实际渲染完全一致（markdown 折行、ANSI、CJK 宽字符）。

```
终端（正常缓冲区，原生滚动）
├─ <Static>  已完成的消息块 —— 打印一次即固化，永不重绘
├─ 动态区    未完成的 tool 块 + 流式 partial + 输入框 + overlay + StatusBar
```

```
UI 层
├─ app/
│  ├─ app.tsx          # App 组件：状态持有 + Static/动态区渲染 + 键盘路由
│  ├─ view-state.ts    # View 视图态联合（none/permission/menu/sessionPicker/prompt/config/info）
│  └─ entry.tsx        # renderTui(port)：Ink render（无 alt-screen）+ 启动清屏 + SIGINT 兜底
├─ config/              # 配置树编辑器纯函数（build/navigation/label/entries/shells 检测）
├─ components/          # top-bar / message-block（含 StreamingBlock）/ multiline-input / status-bar / list-picker
├─ theme/
│  ├─ palette.ts       # 5 套主题 × 11 色 token（surface 两档/border/faint/purple 等）
│  └─ token-map.ts     # BlockKind→emoji, ColorToken→hex（动态 Proxy，随主题切换）
└─ markdown/render.ts   # markdown → 终端富文本（marked Lexer + cli-highlight + chalk ANSI）
```

> **共享模块**：reducer、block、commands 在 `ui/src/shared/`（TUI 和 WebUI 共用）。早期 TUI 专属的 `viewport.ts`（视口裁切）和 `browse.ts`（折叠导航）已随 Static 架构删除。

## Static 的三区渲染

```tsx
// app.tsx
<Static key={staticKey} items={staticItems} style={{ width: '100%' }}>
  {(item, index) => item.type === 'header'
    ? <TopBar ... />                                   // 品牌横幅（首项）
    : <MessageBlock block={block} expanded={expanded.has(index - 1)} />}
</Static>
```

三个关键机制：

1. **Static/动态区分界 = `toolActive`**。`ChatState` 多一个标志位（`ui/src/shared/reducer.ts`）：`tool_start` → `true`，`tool_end` 按 id 匹配成功 → `false`。Static 只渲染 `blocks.slice(0, stableCount)`——**内容还会变的块不能固化**（tool_end 会原地更新 tool 块），它们留在动态区由 Ink 重绘。

2. **Static 是 absolute + fit-content**。Ink Static 内部 `position: 'absolute'` 会收缩到内容宽度，子元素的 `width="100%"` 相对它无效——必须传 `style={{ width: '100%' }}` 覆盖，背景横幅才能贯穿终端全宽。

3. **清屏重绘模式**。Static 已打印的内容无法就地修改，任何"历史内容要变"的场景（会话切换、清空历史、切主题、折叠/展开切换）都用同一招：`clearScreen()` + `staticKey++` 强制 Static 重挂载重绘全部块。

## 消息块：BlockShell 头行 + 缩进内容

每个块统一为「头行在上、内容整体缩进在下、▌ 实色竖条标角色」的容器（`components/message-block/view.tsx`）：

```
▌🥚 你                        ← 头行：▌ 竖条（角色色）+ emoji + 名称
  你好，帮我看看结构            ← 内容缩进 3 格，背景贯穿全宽
```

五色角色系统：**accent 蓝=你、green 绿=DogEgg、purple 紫=思考、cyan 青=工具、red 红=错误**。背景两档：`surface`（user/assistant/error）、`surfaceAlt`（thinking/tool 卡片）。折叠态的 thinking/tool 只有头行一行；展开时内容缩进在下。

流式中的 partial 用 **StreamingBlock** 渲染——与完成块同构的容器，回复从第一个字就有头行和边框，完成后无缝进入 Static。

## 主题系统

`theme/palette.ts` 定义 5 套主题（mocha / tokyonight / gruvbox / onedark / dogegg），每套 11 色完整 token：`accent/text/subtext/faint/green/yellow/cyan/red/purple/surface/surfaceAlt/border`——对齐 WebUI 的多层背景体系（surface 两档 + 独立框线 + 最弱文字层），且每套主题的 surface 带自己的色相（蓝紫/深蓝/暖棕/蓝灰/梅紫），切换时一眼可辨。

`palette` 是 Proxy——属性访问时动态读当前主题；`theme/index.ts` 的 `TOKEN_COLOR` 同理。切换主题（`/config → theme`）时 `setTheme()` 触发 `onThemeChange` 回调 → App 清屏重绘，全部历史按新主题重渲染。

> **教训（ADR-0009）**：不要在任何地方设置 `chalk.level`——chalk 是进程级单例，Ink 的所有 hex 颜色都经它转换。曾有一处 `chalk.level = 1` 把全进程颜色降到 16 色：背景全部量化成黑色（不可见）、主题间差异归零。

## 多行输入

主输入框是自定义 `components/multiline-input/`（替代 ink-text-input，后者仅存于 config 的 prompt 标量输入视图）：

- **换行 = Ctrl+J（`\n`）或 Alt+Enter（`meta+return`）**——Windows 终端不报告 Shift 修饰符，Shift+Enter 不可检测
- **粘贴**：Ink `usePaste`（bracketed paste）整段插入，多行粘贴不误提交
- **Enter（`\r`）提交**；Up/Down 在多行文本内移动光标，单行时透传给输入历史回溯
- 渲染：全部行合并为单个 `<Text>`（Box 内多个 Text 会水平排列），光标字符用 inverse 高亮

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

sessionPicker view
  → 直接输入实时过滤（按预览/ID），↑↓ 选择，Enter 切换会话
  → d 删除当前会话（弹确认），Esc 返回
  → 列表只显示当前 cwd 的会话（路径归一化比较）

config view
  → ↑↓ 移动，Enter 钻入/编辑，←→ 切布尔，d 删除，Esc 返回
  → selectTool/selectShell/selectTheme 等 action：无 del 的留在同页，有 del 的回父层

none view
  → /开头：↑↓ 联想选择，Enter/Tab 补全
  → Ctrl+↑/Ctrl+↓：进入/移动浏览模式（所有消息块间移动焦点）
  → 浏览模式中：Enter 展开/折叠当前块（thinking/tool），Esc 退出
  → 非浏览模式：↑↓ 召回输入历史

info view
  → ↑↓ 翻页（固定 15 行窗口），Esc 关闭
```

滚动本身交给终端——历史在滚动缓冲区里，滚轮/滚动条/终端自带快捷键都能用，TUI 不做任何视口滚动。

### 折叠/展开：清屏重绘

历史块已打印进缓冲区，无法就地展开。浏览模式按 Enter 切换展开状态时：更新 `expanded` Set → `clearScreen()` + `staticKey++` → Static 重挂载按新状态重绘全部块。终端会闪一下，和 Claude Code 的 `/clear` 同款体验。

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
// ui/src/shared/commands.ts（TUI 和 WebUI 共用）
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

## 状态栏与实时 tokens

```tsx
// ui/src/tui/components/status-bar/view.tsx
<Box gap={1}>
  {/* 状态徽章：运行时黄底深字 + Braille spinner，空闲 surface 底 */}
  <Text backgroundColor={isSpinning ? palette.yellow : palette.surfaceAlt} ...>
    {meta.emoji} {spinner}{meta.label}
  </Text>
  <Text>· provider/model</Text>
  <Text>· [████░░░░] 1.8k/1.0M</Text>   {/* 8 格 context 进度条，超阈值变黄 */}
  <Text>· 📂 {cwdBasename}</Text>
  <Text>· 🔖 {sessionId.slice(0, 8)}</Text>
</Box>
```

tokens 实时更新靠两条路：
1. **App 每 2s 轮询 `context_request`**（仅运行中）；
2. **Agent 在每次状态迁移时附带发 `status_state`**（含最新 token 估算，见 02 章 emitState）。

消息块的 token 数在流式期间不变（assistant 完整消息在流结束后才进 context），所以更新发生在迭代边界（思考→回答→工具的切换点）。

## markdown 渲染

`markdown/render.ts` 用 marked Lexer 分词后输出**终端富文本**（不是纯文本）：

- 代码块：`cli-highlight` 按语言做 ANSI 语法高亮（无语言标签则原样）
- 行内：`**粗体**`→ ANSI bold、`*斜体*`→ italic、`` `代码` ``→ 青色
- 标题/列表圆点/引用：主题 accent 色（truecolor，随主题切换）

Ink 的 `<Text>` 会透传 ANSI 序列给终端。注意**不要**设置 `chalk.level`（见主题系统一节的教训）。
