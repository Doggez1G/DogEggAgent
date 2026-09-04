# ADR-0009：禁止设置 chalk.level（全局颜色污染）

状态：已采纳（2026-09-04）

## 背景

TUI 重构主题系统（11 色 token、5 套主题、背景色块、彩色竖条）后，用户报告"设计没有生效"：背景色不可见、竖条无色、主题切换毫无差异——但代码检查全部正确。

排查发现 `multiline-input/view.tsx` 和 `markdown/render.ts` 各有一行：

```ts
chalk.level = 1   // 本意：强制基础 ANSI，避免 256-color 冲突
```

## 原因

**chalk 是进程级单例**。Ink 的 `colorize`（所有 hex 颜色的转换入口）直接 `import chalk from 'chalk'` 使用全局实例：

- `chalk.hex(...)` / `chalk.bgHex(...)` 的输出依赖 `chalk.level`；
- `level = 1`（16 色）会把 truecolor 背景降级——深蓝紫的 `surface` 被量化成最接近的基础色（黑）→ **背景不可见**；
- 前景彩色降级为基础 ANSI 色 → 五色竖条变成无区分的基础色；
- 所有主题的精细色差在 16 色下归零 → "切主题没变化"。

任何模块设置 `chalk.level` 都会影响整个进程，包括 Ink 内部。

## 决策

1. **禁止在项目任何位置设置 `chalk.level`**（或 chalk 的 `level`/`enabledColor` 相关全局态）。颜色深度交由 Ink 通过 supports-color 按终端自动检测（Windows Terminal / iTerm2 = truecolor 24bit）。
2. 语法高亮（cli-highlight 的 theme）使用惰性调用的 chalk 函数——在真实 TTY 下自然输出 truecolor，不做全局降级。

## 后果

- 删除两处 `chalk.level = 1` 后，主题系统的全部设计立即按预期渲染——一行毒药曾让数轮视觉重构"看起来没生效"。
- 排查经验：**"颜色不生效"先查全局 chalk 级别污染，再查渲染代码**。管道/重定向环境下 stdout 非 TTY，supports-color 返回 0，颜色同样消失——验证颜色问题必须在真实 TTY 中进行。
