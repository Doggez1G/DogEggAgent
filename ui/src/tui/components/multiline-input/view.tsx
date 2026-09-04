import React, { useState, useEffect } from 'react'
import { Text, useInput, usePaste } from 'ink'
import chalk from 'chalk'

// 多行文本输入组件：替换 ink-text-input，支持多行编辑。
// 换行方式（Windows 终端不报告 Shift 修饰符，Shift+Enter 不可检测）：
//   Ctrl+J（发送 \n，readline 标准）或 Alt+Enter（\x1b\r，key.meta）→ 插入换行。
//   粘贴多行文本经 usePaste（bracketed paste）整段插入，不误提交。
// Enter（\r，无修饰）提交。Up/Down 在多行文本内移动光标行；单行时不上报
//（让 app 的输入历史回溯生效）。
chalk.level = 1

export function MultilineInput(props: {
  value: string
  onChange: (v: string) => void
  onSubmit: (v: string) => void
  focus?: boolean
  placeholder?: string
}) {
  const { value, onChange, onSubmit, focus = true, placeholder = '' } = props
  const [cursorOffset, setCursorOffset] = useState(value.length)

  // 外部 value 变更时同步光标（如输入历史回溯清空）。
  useEffect(() => {
    setCursorOffset((prev) => {
      if (prev > value.length) return value.length
      return prev
    })
  }, [value])

  useInput((inputChar, key) => {
    // Ctrl+C 不拦截——让 app 的全局 Ctrl+C 处理器处理（cancel/quit）。
    if (key.ctrl && inputChar === 'c') return

    // Tab 不拦截——让 app 的命令补全处理器处理。
    if (key.tab) return

    // Ctrl+J（\n，多数终端的换行键）或 Alt+Enter（meta+return）→ 插入换行。
    if (inputChar === '\n' || (key.meta && key.return)) {
      const newValue = value.slice(0, cursorOffset) + '\n' + value.slice(cursorOffset)
      onChange(newValue)
      setCursorOffset(cursorOffset + 1)
      return
    }

    // Enter（\r，无修饰）→ 提交。
    if (key.return) {
      onSubmit(value)
      return
    }

    if (key.leftArrow) {
      setCursorOffset((c) => Math.max(0, c - 1))
      return
    }
    if (key.rightArrow) {
      setCursorOffset((c) => Math.min(value.length, c + 1))
      return
    }

    // Up/Down：多行文本内在行间移动光标。
    // 单行时不拦截——让 app 的输入历史回溯生效。
    if (key.upArrow) {
      const before = value.slice(0, cursorOffset)
      const lastNewline = before.lastIndexOf('\n')
      if (lastNewline === -1) return // 在第一行，不拦截
      const currentCol = cursorOffset - lastNewline - 1
      const prevLineStart = before.slice(0, lastNewline).lastIndexOf('\n') + 1
      const prevLineEnd = lastNewline
      const prevLineLen = prevLineEnd - prevLineStart
      const newCol = Math.min(currentCol, prevLineLen)
      setCursorOffset(prevLineStart + newCol)
      return
    }
    if (key.downArrow) {
      const after = value.slice(cursorOffset)
      const nextNewline = after.indexOf('\n')
      if (nextNewline === -1) return // 在最后一行，不拦截
      const before = value.slice(0, cursorOffset)
      const currentCol = cursorOffset - (before.lastIndexOf('\n') + 1)
      const afterNextNewline = after.slice(nextNewline + 1)
      const lineAfterNext = afterNextNewline.indexOf('\n')
      const nextLineLen = lineAfterNext === -1 ? afterNextNewline.length : lineAfterNext
      const newCol = Math.min(currentCol, nextLineLen)
      setCursorOffset(cursorOffset + nextNewline + 1 + newCol)
      return
    }

    if (key.backspace || key.delete) {
      if (cursorOffset > 0) {
        const newValue = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset)
        onChange(newValue)
        setCursorOffset(cursorOffset - 1)
      }
      return
    }

    // 普通字符插入（过滤控制字符；\n 已在上面处理）。
    if (inputChar && inputChar.length > 0 && inputChar >= ' ' && inputChar !== '\n') {
      const newValue = value.slice(0, cursorOffset) + inputChar + value.slice(cursorOffset)
      onChange(newValue)
      setCursorOffset(cursorOffset + inputChar.length)
    }
  }, { isActive: focus })

  // 粘贴：bracketed paste 事件——整段插入（含换行），不触发提交。
  usePaste((paste) => {
    if (!focus || !paste) return
    const newValue = value.slice(0, cursorOffset) + paste + value.slice(cursorOffset)
    onChange(newValue)
    setCursorOffset(cursorOffset + paste.length)
  }, { isActive: focus })

  // 渲染：按行拆分，光标行用 inverse 高亮光标字符。
  const lines = value.split('\n')
  const clampedCursor = Math.min(cursorOffset, value.length)

  // 计算光标在哪个行和列。
  let cursorLine = 0
  let cursorCol = 0
  let pos = 0
  for (let i = 0; i < lines.length; i++) {
    if (pos + lines[i]!.length >= clampedCursor) {
      cursorLine = i
      cursorCol = clampedCursor - pos
      break
    }
    pos += lines[i]!.length + 1 // +1 for \n
    cursorLine = i + 1
    cursorCol = 0
  }

  if (value.length === 0 && placeholder) {
    return <Text>{chalk.inverse(placeholder[0] ?? ' ')}{chalk.gray(placeholder.slice(1))}</Text>
  }

  // 渲染：所有行合并为一个 Text（Ink 中 Box 内多个 Text 会水平排列，需用 \n 分隔）。
  const renderedLines = lines.map((line, i) => {
    if (i === cursorLine && focus) {
      const before = line.slice(0, cursorCol)
      const cursorChar = line[cursorCol] ?? ' '
      const after = line.slice(cursorCol + 1)
      return before + chalk.inverse(cursorChar) + after
    }
    return line || ' '
  })

  return <Text>{renderedLines.join('\n')}</Text>
}
