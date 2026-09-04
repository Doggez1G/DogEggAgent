# TUI 优化计划

> 基于 TUI vs WebUI 功能对等性分析 + 用户反馈的 12 项改进需求
> 创建日期：2026-08-29
> 状态：**已完成**（所有 Phase 0-5 已实施，typecheck + 167 测试 + 构建均通过）
>
> ### 实施结果与计划的偏差（2026-09-04 补记）
>
> 实施过程中方案有如下演进，以实际代码为准（见 `docs/learning/09-tui.md` 与 ADR-0008）：
>
> 1. **#10 滚动 / #12 鼠标**：计划保留 PageUp/PageDown + 步长优化，最终**整体被 Static 架构取代**——TUI 放弃 alt-screen，历史打印进终端滚动缓冲区，滚动交给终端原生（滚轮/滚动条），PageUp/PageDown、视口裁切、行数估算全部删除（ADR-0008）。
> 2. **#12 展开键**：计划用 Ctrl+Enter 展开/折叠，实施发现多数终端把 Ctrl+Enter 发送为 `\n`（Ink 解析为普通 Enter 且 ctrl 修饰丢失），**改为浏览模式中 Enter 直接切换**（输入框在浏览模式下失焦，不冲突）。
> 3. **#9 主题**：最终 5 套（mocha/tokyonight/gruvbox/onedark/dogegg），11 色 token（surface 两档/border/faint/purple），切换走清屏 + Static 重挂载；未持久化到 config。
> 4. **#3 状态栏轮询**：间隔 2s（非 3s）；另外 agent 在每次状态迁移时附带发 `status_state`（含最新 token 估算），双路更新。
> 5. **#4 多行输入**：主输入替换为自定义 `MultilineInput`（Ctrl+J/Alt+Enter 换行 + usePaste 粘贴——Windows 终端不报告 Shift 修饰符，Shift+Enter 不可检测）；`ink-text-input` 仅存于 config 的 prompt 标量视图。
> 6. **#7 会话搜索**：sessionPicker 视图同时具备搜索 + `d` 删除 + CWD 过滤（计划未含删除/CWD）。
> 7. **测试数**：文中"167"为实施中期数字，随测试增删会漂移，以 `npm run test:run` 实时输出为准。

---

## 调查发现（关键事实纠正）

### 多行输入：TUI 当前不支持 (#4)

- TUI 使用 `ink-text-input` 6.0.0，其 `useInput` 在 `key.return` 时直接调用 `onSubmit` 然后 return
- **没有任何 Shift+Enter / Ctrl+J 新行插入机制**
- 粘贴多行文本会在第一个换行处触发提交（`readline.emitKeypressEvents` 把每个 `\n` 变成独立 keypress）
- 用户看到的"多行"是终端对长文本的视觉折行，非真正多行编辑
- **决策：添加多行支持**（替换 ink-text-input 为自定义多行组件）

### 鼠标支持：本期不做 (#10, #12)

- Ink 7.1.1 无内置鼠标支持（无 `useMouse`、不解析鼠标 CSI、不启用鼠标报告）
- TypeScript 生态无带鼠标的 Ink 替代品（blessed 已停更 + 命令式 API，换语言不现实）
- 自定义 raw stdin 实现可行但用户选择暂不做
- **决策：纯键盘操作，不做鼠标**

### CWD：已经是 Claude 式启动 (#2)

- TUI 组合根 `main.ts:22` → `new Agent(agentPort, config, process.cwd())`
- 在哪个目录运行命令，cwd 就是那个目录——已实现
- 但 `listSessions()` 返回所有会话（含 cwd 字段），**不过滤**
- `statusBarData` 不存储 cwd

### 状态栏问题 (#3)

- **tokens 不实时更新**：TUI 不轮询 `context_request`，只在收到 `status_state` / `context_state` 时更新
- **StatusBar 仅在 `none` view 渲染**：overlay 期间消失，布局跳动
- **不含 CWD 显示**：statusBarData 不存 cwd
- **决策：就是这三个问题，无其他**

### 布局问题 (#11)

- alt-screen 已启用，聊天区用 `flexGrow={1}` + `sliceViewport`
- overlay 作为额外子元素追加到列布局，挤压其他元素
- **决策：overlay 放在输入框下方，视觉上和输入框一体**——像输入框被抬高，overlay 从下方展开

---

## 逐项计划

### 1. ✅ 会话删除

**方案**：
- 在 session picker（`menu` view）中加 `d` 键删除当前选中会话
- 删除前弹确认 menu（复用 `openMenu`）
- 发送 `delete_session { id }` 消息
- 收到 `session_deleted` 响应后从列表移除并刷新

**文件**：`ui/src/tui/app/app.tsx`

---

### 2. ✅ 会话列表按 CWD 过滤（不做项目分组）

**方案**：
- TUI 的 cwd = `process.cwd()`（已实现，Claude 式启动）
- session picker 只显示 `s.cwd === currentCwd` 的会话
- 在 TUI 状态中存储当前 cwd：从 `status_state` 消息提取
- 前端过滤：收到 `session_list` 后按 cwd 过滤再渲染
- 标题显示当前目录名

**文件**：`ui/src/tui/app/app.tsx`

---

### 3. ✅ 状态栏优化（三个问题）

**方案**：
1. **tokens 不实时更新** → 添加运行中轮询 `context_request`（3s 间隔，与 WebUI 一致），agent 运行状态下用 `useEffect` + `setInterval`
2. **StatusBar overlay 期间消失** → 移出 `view.kind === 'none'` 条件，始终渲染
3. **不含 CWD** → `status_state` handler 中提取并存储 cwd；StatusBar 增加 cwd 显示

**文件**：`ui/src/tui/app/app.tsx`、`ui/src/tui/components/status-bar/view.tsx`

---

### 4. ✅ 多行输入

**方案**：
- 替换 `ink-text-input` 为自定义多行文本输入组件
- 支持 Shift+Enter 换行（插入 `\n`）
- Enter（无修饰键）提交
- 多行光标移动：Up/Down 在多行文本内移动光标
- 自适应高度：随内容增长，最多占终端高度的一定比例
- 粘贴多行文本正确处理（不误提交）

**实现细节**：
- 组件接收 `value`、`onChange`、`onSubmit` props（兼容现有接口）
- 内部维护光标位置（行+列或字符偏移）
- 渲染时按行拆分，显示光标行
- `useInput` 处理：常规字符插入、Backspace 删除、Enter 判断（Shift→换行，无修饰→提交）、方向键移动光标

**文件**：新建 `ui/src/tui/components/text-input/`（view.tsx + index.ts）、`ui/package.json`

---

### 5. ✅ 代码语法高亮

**方案**：
- 在 `tui/markdown/render.ts` 中引入 `cli-highlight`
- 对 `marked` Lexer 解析出的 `code` block 用 ANSI 色彩高亮
- 保持纯文本兼容（高亮用 ANSI escape codes，不破坏 Ink 渲染）

**文件**：`ui/src/tui/markdown/render.ts`、`ui/package.json`

---

### 6. ⏸ 快捷操作菜单

暂缓（用户要求后面再加）

---

### 7. ✅ 会话搜索（仅当前 CWD 下）

**方案**：
- 在 session picker 中添加搜索输入框
- 实时按预览文本过滤
- 搜索范围：仅当前 cwd 的会话（#2 过滤后的列表）
- 搜索框聚焦时 Up/Down 仍可选择会话，输入时实时过滤

**文件**：`ui/src/tui/app/app.tsx`

---

### 8. ✅ Shell 检测

**方案**：
- TUI 同进程运行，直接用 `execFileSync` 检测可用 shell
- 复用 `server/src/shells/detect.ts` 的逻辑（提取到共享位置或直接在 TUI 内实现）
- 在 config 编辑器的 `shellProgram` 字段显示检测到的 shell 列表
- 用户可选择或手动输入

**文件**：`ui/src/tui/config/build.ts`、可能提取 `detectShells` 到共享位置

---

### 9. ✅ 主题切换

**方案**：
- 定义多套 palette（当前 Catppuccin Mocha + 新增如 Catppuccin Latte/Frappe、Tokyo Night、Gruvbox 等）
- 在 TUI 状态中存储当前主题
- 运行时切换 palette（`theme/palette.ts` 导出多个 palette）
- 通过 `/config` 或快捷键切换
- 主题存储：config 文件中新增 `ui.theme` 字段，或独立偏好文件

**文件**：`ui/src/tui/theme/palette.ts`、`ui/src/tui/app/app.tsx`、可能涉及 `bridge/src/contract/config.ts`

---

### 10. ✅ 消息滚动优化（纯键盘）

**方案**：
- **PageUp/PageDown** → 滚动视口，步长改为 **3-5 行**（当前半屏 `stdout.rows/2` 跳跃太大）
- 具体值：`Math.min(5, Math.max(3, Math.floor(stdout.rows / 20)))` 自适应终端高度
- 保留滚动指示器 `↑ {scrolled} 行历史`
- **不做鼠标滚轮**

**文件**：`ui/src/tui/app/app.tsx`（PageUp/PageDown handler）

---

### 11. ✅ 启动布局优化

**方案**：
- overlay 放在**输入框下方**，视觉上和输入框一体——像输入框被抬高，overlay 从下方展开
- TopBar 始终在顶部
- StatusBar 始终在底部
- 中间聊天区域（flexGrow）始终可见（overlay 不替换聊天，而是在输入框下方展开）
- overlay 出现时聊天区域收缩让出空间
- Input 始终可见（overlay 期间输入框可能改变行为，如 session picker 时变为搜索框）

**布局结构**：
```
┌─ TopBar ───────────────────┐
│                            │
│  chat content (收缩)        │
│                            │
│  ┌─ Input ──────────────┐  │  ← 输入框（抬高）
│  │ › type here_         │  │
│  ├──────────────────────┤  │  ← 视觉一体
│  │ [overlay content]    │  │  ← overlay 从下方展开
│  │ session picker etc.  │  │
│  └──────────────────────┘  │
├─ StatusBar ────────────────┤
└────────────────────────────┘
```

**文件**：`ui/src/tui/app/app.tsx`（render tree 重构）

---

### 12. ✅ 消息块键盘导航（纯键盘）

**完整的键盘导航模型**（已确认）：

| 按键 | 行为 | 适用场景 |
|---|---|---|
| **PageUp/PageDown** | 滚动视口（3-5 行步长） | 始终可用 |
| **Up/Down** | 回溯输入历史 | 输入框聚焦时 |
| **Ctrl+Up/Ctrl+Down** | 在所有消息块之间导航聚焦 | 进入块导航模式 |
| **Ctrl+Enter** | 展开/折叠当前聚焦的块 | 块导航模式，仅 thinking/tool 块有效 |
| **Escape** | 退出块导航模式，焦点回到输入框 | 块导航模式 |

**导航规则**：
- **所有消息块都能被选中聚焦**（user/assistant/thinking/tool/error/notice/auto_compact）
- 只有 thinking/tool 块能展开折叠（Ctrl+Enter 有效）
- 非 thinking/tool 块聚焦时 Ctrl+Enter 无操作（或给视觉反馈表示不可展开）
- 聚焦块自动滚动到视口内（如果超出可视范围）
- 视觉标记：聚焦块用左侧 `▌` 色条，未聚焦用 `│`

**块导航模式进出**：
- 按 Ctrl+Up 或 Ctrl+Down 进入块导航模式（输入框失焦）
- 按 Escape 退出（输入框重新聚焦）
- 块导航模式下 PageUp/PageDown 仍可滚动

**与现有逻辑的关系**：
- 替换当前 `browse` 机制（当前只导航 expandable 块，用 Up/Down + Enter toggle）
- 新机制：Ctrl+Up/Ctrl+Down 导航所有块，Ctrl+Enter toggle 展开
- 斜杠命令补全（Tab 补全）保持不变

**文件**：`ui/src/tui/app/app.tsx`（useInput handler 重构）、`ui/src/tui/chat/browse.ts`（导航逻辑扩展：从只导航 expandable 块改为导航所有块）

---

## 共享层优化

### 统一重复的标签/常量

- TUI 的 `STATE_META`（中文标签+emoji+颜色）和 WebUI 的 `STATUS_LABELS`（英文标签）是平行实现
- TUI 的 `DECISION_LABELS` 和 WebUI 的按钮文案也是平行实现
- 可在 `shared/` 中提取更多共享常量
- 注意：TUI 中文、WebUI 英文，可能需要保持分离或提供双语映射

### 统一配置字段定义

- TUI 的 `tui/config/build.ts` 和 WebUI 的 `settings/view.tsx` 各自实现配置字段遍历
- 可提取共享"字段定义"层，但 UI 渲染方式不同，共享价值有限

---

## 实施顺序

```
Phase 0: CLI 全局命令入口（前置）
  └─ 创建 dogegg 命令：单一入口 + 参数分发（dogegg → TUI, dogegg -web → WebUI）
      ├─ 新建 bin/dogegg.ts：解析 process.argv，有 -web 启动 WebUI 逻辑，否则启动 TUI 逻辑
      ├─ build.mjs 改为打包 bin/dogegg.ts → dist/dogegg.js（加 shebang #!/usr/bin/env node）
      ├─ package.json 加 bin: { "dogegg": "dist/dogegg.js" }
      ├─ 跨平台：npm 在 Windows 自动创建 .cmd 包装器，Linux/macOS 用 shebang，无需特殊处理
      ├─ 确保构建产物包含 dist/dogegg.js + dist/web/（WebUI 静态资源）
      └─ npm link 本地验证：dogegg → TUI, dogegg -web → WebUI

Phase 1: 基础功能补齐（无依赖）
  ├─ #2  CWD 过滤（存储 cwd + session_list 前端过滤）
  ├─ #1  会话删除（session picker 加 d 键 + 确认）
  ├─ #7  会话搜索（session picker 加搜索框，依赖 #2）
  └─ #8  Shell 检测（config tree 的 shellProgram 字段）

Phase 2: 状态栏 + 布局
  ├─ #3  状态栏优化（轮询 + 始终显示 + CWD）
  └─ #11 布局优化（overlay 在输入框下方一体展开）

Phase 3: 键盘导航 + 滚动
  ├─ #12 消息块键盘导航（Ctrl+Up/Down 导航所有块 + Ctrl+Enter 展开 + Escape 退出）
  └─ #10 滚动优化（PageUp/PageDown 步长 3-5 行）

Phase 4: 渲染增强
  ├─ #4  多行输入（自定义多行 TextInput 组件）
  ├─ #5  代码语法高亮（cli-highlight）
  └─ #9  主题切换（多 palette + 运行时切换）

Phase 5: 共享层优化
  └─ 统一重复标签/常量

暂缓：
  └─ #6  快捷操作菜单
```

每步完成后：`npm run typecheck` + `npm run test:run` 验证不影响现有功能。
Phase 0 额外验证：`npm link` 后在任意目录执行 `dogegg` 和 `dogegg -web` 确认可启动。

---

## 已确认的决策汇总

| # | 需求 | 决策 |
|---|---|---|
| 0 | CLI 全局命令 | ✅ 单一入口 bin/dogegg.ts，dogegg→TUI，dogegg -web→WebUI，package.json 加 bin + shebang，跨平台 |
| 1 | 会话删除 | ✅ 添加，session picker 加 d 键 + 确认 menu |
| 2 | CWD 过滤 | ✅ 前端过滤，不做项目分组，TUI = Claude 式启动 |
| 3 | 状态栏 | ✅ 三问题：轮询 + 始终显示 + CWD |
| 4 | 多行输入 | ✅ 添加，替换 ink-text-input 为自定义多行组件 |
| 5 | 语法高亮 | ✅ 用 cli-highlight 给代码块加 ANSI 色 |
| 6 | 快捷菜单 | ⏸ 暂缓 |
| 7 | 会话搜索 | ✅ 仅当前 cwd 下，session picker 加搜索框 |
| 8 | Shell 检测 | ✅ TUI 同进程，直接 execFileSync 检测 |
| 9 | 主题切换 | ✅ 多 palette + 运行时切换 |
| 10 | 滚动 | ✅ 纯键盘，PageUp/PageDown 步长 3-5 行，不做鼠标 |
| 11 | 布局 | ✅ overlay 在输入框下方一体展开，TopBar/StatusBar 始终固定 |
| 12 | 块导航 | ✅ Ctrl+Up/Down 导航所有块，Ctrl+Enter 展开，Escape 退出，纯键盘 |
