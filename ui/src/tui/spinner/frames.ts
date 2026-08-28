import type { State } from '@dogegg/bridge'

// 狗蛋风格 Spinner 帧序列——每个运行态有专属动效，非运行态返回静态图标。
// 帧序列的设计语义见需求文档 §14「Spinner 动效设计」。

// thinking：蛋静止 3 帧，偶尔裂开露 🐣（灵感闪现）
const THINKING_FRAMES = ['🥚', '🥚', '🥚', '🐣'] as const

// executing / tool_calling：狗爪左右移动（在动手）
const EXECUTING_FRAMES = ['🐾', ' 🐾', '  🐾', ' 🐾'] as const

// responding：爪+光标交替闪烁（狗在说话）
const RESPONDING_FRAMES = ['🐾 ▌', '🐾  '] as const

// compacting：蛋微微抖动（内容被压缩打包）
const COMPACTING_FRAMES = ['🥚', '🥚'] as const

// 非运行态的静态图标
const STATIC_ICONS: Partial<Record<State, string>> = {
  idle: '🥚',
  finished: '🐥',
  cancelled: '🥚',
  error: '🐶 汪',
  waiting_permission: '⚠',
}

// 获取指定状态在第 frame 帧的 spinner 内容。
// 运行态（thinking/responding/executing/tool_calling/compacting）循环帧序列；
// 非运行态返回静态图标（frame 参数无效）。
export function spinnerFrame(state: State, frame: number): string {
  const frames = getFrames(state)
  if (!frames) return STATIC_ICONS[state] ?? '🥚'
  return frames[frame % frames.length]!
}

// 获取状态的帧序列（运行态）或 null（非运行态，用静态图标）。
export function getFrames(state: State): readonly string[] | null {
  switch (state) {
    case 'thinking': return THINKING_FRAMES
    case 'responding': return RESPONDING_FRAMES
    case 'tool_calling':
    case 'executing': return EXECUTING_FRAMES
    case 'compacting': return COMPACTING_FRAMES
    default: return null
  }
}

// 是否需要动画（运行态需要定时器驱动帧切换）。
export function isAnimated(state: State): boolean {
  return getFrames(state) !== null
}
