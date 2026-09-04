# ADR-0008：TUI 采用 Static 架构（alt-screen → 终端原生滚动）

状态：已采纳（2026-09-04）

## 背景

TUI 最初运行在终端备用屏幕（alt-screen，`\x1b[?1049h`）中：历史消息必须全部塞进一个 `termHeight` 高的视口里，自己管理滚动。为此实现了 `viewport.ts`（`estimateBlockLines` 行数估算 + `sliceViewport` 视口裁切）和 `browse.ts`（可折叠块导航），并经历了一整轮"显示不全/溢出/挤压输入框"的修复拉锯：

- `estimateBlockLines` 用字符数估算折行，永远无法与 Ink 实际渲染完全一致（markdown 折行、ANSI 序列、CJK 宽字符）；
- 估算偏大 → 内容显示不全；估算偏小 → 溢出（Ink 对超容器内容会跳行渲染）；
- 每次修补都只是把问题挪到另一个边界条件上。

## 决策

**放弃 alt-screen 与自制视口，改用 Ink `<Static>` + 终端原生滚动**（Claude Code 同款架构）：

- 已完成的消息块经 `<Static>` 打印进终端**正常滚动缓冲区**，打印后固化、永不重绘；
- 历史查看交给终端原生滚动（鼠标滚轮 / 滚动条 / 终端快捷键），TUI 内不再有任何 PageUp/PageDown、视口裁切、行数估算；
- Ink 只重绘底部动态区：未完成的 tool 块 + 流式 partial（`StreamingBlock`）+ 输入框 + overlay + 状态栏；
- `ChatState` 增加 `toolActive` 标志区分"可固化"与"仍会变化"的块（`tool_start` → true，`tool_end` 按 id 匹配成功 → false）；
- 需要"修改历史"的场景（会话切换 / 清空 / 切主题 / 折叠展开）统一用**清屏 + Static 重挂载**（`clearScreen()` + `staticKey++`）；
- 折叠/展开改为浏览模式：Ctrl+↑/Ctrl+↓ 移动焦点，Enter 切换（Esc 退出）——不再有视口内滚动。

## 约束与代价

- Static 打印的内容无法就地修改，一切历史变更只能清屏重绘（终端闪一下）；
- 打印行的宽度固定为打印时的终端宽，resize 后旧内容不重新折行；
- 动态区高度不能超过终端高度（否则 Ink 重绘混乱）——ListPicker/sessionPicker/info 均做了窗口化（最多 12-15 项）。

## 后果

视口相关的全部代码（~200 行估算/裁切/滚动逻辑）删除，"显示不全"类 bug 归零。滚动体验反而升级：原生滚轮 + 无限历史。教训沉淀为 entry.tsx 顶部注释与本文档。
