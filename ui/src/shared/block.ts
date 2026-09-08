// 语义化的消息块模型：平台无关，不含任何终端或 DOM 依赖。
// TUI 与 WebUI 共用此模型——视觉映射（emoji/SVG、hex/CSS var）归各 UI 的 theme 层。

// 角色语义：标识一条消息「是谁说的/什么性质」。
// 视觉映射层据此选择图标（TUI: emoji，WebUI: Lucide SVG）和标签文本。
export type BlockKind =
  | 'user'          // 用户消息
  | 'assistant'    // 助手回复
  | 'thinking'     // 推理思考（可折叠）
  | 'tool'          // 工具调用（可折叠）
  | 'error'        // 错误消息
  | 'notice'       // 系统提示
  | 'auto_compact' // 自动压缩提示

// 语义色 token：标识一条消息的颜色角色。
// 视觉映射层据此选择具体色值（TUI: hex，WebUI: CSS variable）。
export type ColorToken =
  | 'accent'   // 强调色（用户/焦点）
  | 'text'     // 正文色（助手）
  | 'cyan'     // 工具色
  | 'yellow'   // 思考色
  | 'red'      // 错误色
  | 'subtext'  // 次要色（提示/自动压缩）

// 工具块的执行状态——结构化存储，渲染层据此选图标/文案（替代字符串探测 ✓/✕）。
// rejected = 被拒绝（用户 reject 或配置 reject 桶，后端以 error='denied' 标记）。
export type ToolStatus = 'running' | 'done' | 'error' | 'rejected'

// 工具块展开正文的一行：kind 驱动渲染层着色（add/del → diff 行，plain → 次要色）。
// 文案由 shared/tool-display 生成——模型持有类型，格式化持有内容。
export interface ToolBodyLine {
  text: string
  kind: 'plain' | 'add' | 'del'
}

// 消息块：一条消息在 UI 中的呈现单元。
// text = 折叠时显示的摘要；full = 展开时的完整内容（仅 thinking 使用）。
// tool 块不拼字符串：结构化字段 + toolBody（shared/tool-display 的产物）承载全部信息。
export interface Block {
  kind: BlockKind
  color: ColorToken
  text: string
  full?: string
  toolId?: string       // tool_start/tool_end 精确匹配（不靠数组尾部）
  toolInput?: unknown   // tool_start 的 input，供格式化参数段/diff
  // ── tool 块专用结构化字段 ──
  toolName?: string
  toolStatus?: ToolStatus
  toolOutput?: string   // 工具结果原文（tool_end 时回填；历史重建时为 tool 消息 content）
  toolError?: string    // 失败/拒绝原因
  toolBody?: ToolBodyLine[] // 展开正文（tool_end 时生成；running 块无 → 不可展开）
}

// 判断一个块是否可折叠：thinking 有 full、tool 有 toolBody 才可折叠。
// 提取此函数消除 viewport.ts 和 browse.ts 中的重复 ICON 检查。
export function isExpandable(b: Block): boolean {
  if (b.kind === 'thinking') return b.full !== undefined
  if (b.kind === 'tool') return b.toolBody !== undefined
  return false
}
