import type { McpTransport } from '@dogegg/bridge'
import type { ConfigPath } from './features/config'

// UI 自己的视图态（叠加在后端状态机之上，二者正交）。
// 决定当前显示哪个 overlay：无 / 权限弹层 / 菜单选择器 / 会话选择器 / 标量输入 / 配置编辑器 / 只读信息面板。
// skills 面板条目（skills_list 消息的条目形态；scope 决定分组与覆盖关系）。
// missing = 停用名单在案但目录已消失（孤儿条目）——仅供展示与清理。
export interface SkillEntry {
  name: string
  description: string
  scope: 'project' | 'user'
  path: string
  enabled: boolean
  missing: boolean
}

// MCP server 条目（mcp_list 消息的条目形态：配置（含 transport 明细——编辑预填）+ 运行时状态）。
export interface McpServerEntry {
  name: string
  enabled: boolean
  scope: 'global' | 'project'
  transport: McpTransport
  status: 'running' | 'starting' | 'error' | 'stopped'
  error?: string
  tools: { name: string; description: string }[]
}

export type View =
  | { kind: 'none' }
  // returnView：审批弹层插入前的来源视图（/config 树、表单、菜单等）。非 none 时收到
  // permission_request 会把当前视图挂进来，决议/拒绝后原样恢复——审批不得顶掉用户
  // 正在进行的操作（深层游标、已填字段都在快照里）；当前无视图（none）或已在审批弹层
  // （链式请求）时不挂，行为与旧版一致。
  | { kind: 'permission'; id: string; tool: string; input: unknown; alwaysScope?: { pattern: string }; cursor: number; returnView?: View }
  | { kind: 'menu'; title: string; items: { label: string; onSelect: () => void }[]; cursor: number; /** esc 返回来源视图（缺省关面板）——面板内确认菜单不再「一键退出设置」。 */ returnView?: View }
  | { kind: 'sessionPicker'; sessions: { id: string; preview: string; title?: string; updatedAt: string }[]; cursor: number; query: string }
  | { kind: 'prompt'; title: string; value: string; onSubmit: (v: string) => void; returnPath?: ConfigPath; returnCursor?: number; returnView?: View }
  | { kind: 'skills'; cursor: number; skills: SkillEntry[] }
  | { kind: 'mcp'; cursor: number; servers: McpServerEntry[] }
  | { kind: 'config'; path: ConfigPath; cursor: number; preview: boolean | null }
  | { kind: 'info'; title: string; lines: string[]; /** esc 返回来源视图（缺省关面板）——面板内钻入的详情不再「一键退出设置」。 */ returnView?: View } // /context /tools /status /system /log /help 的只读面板
  | { kind: 'form'; title: string; fields: FormField[]; cursor: number; returnView: View; submitLabel: string; onSubmit: (values: string[]) => void } // 多字段表单（/mcp、/skills 的新建/编辑）：一行一字段，Enter 编辑/切换

// 表单字段：options 存在 = 固定选项字段（Enter 循环切换，显示 label 提交 value）；
// 否则文本字段（Enter 弹 prompt 编辑，prefill 当前值）。readonly = 身份锁定行（编辑态名称/落点）。
export interface FormField {
  label: string
  value: string
  options?: { label: string; value: string }[]
  readonly?: boolean
}

// ── returnView 链的深更新 ──
// 持有 returnView 的视图变体（menu/prompt/info/permission 可选；form 必有——表单永远从某处进入）。
// config 的 returnPath/returnCursor 是路径游标不是视图快照；sessionPicker/skills/mcp/config 无链。
type ReturnViewHolder = Extract<View, { kind: 'menu' | 'prompt' | 'info' | 'permission' | 'form' }>

function returnViewChild(v: View): View | undefined {
  switch (v.kind) {
    case 'menu': case 'prompt': case 'info': case 'permission': case 'form': return v.returnView
    default: return undefined
  }
}

// 沿 returnView 链深更新同 kind 的面板快照（含当前视图本身，递归）。
//
// 立法（2026-09-24）：skills_list / mcp_list 等广播到达时，除了刷新「当前」视图，还必须刷新
// 挂在 menu/prompt/info/form/permission 的 returnView 链上的同 kind 面板——详情弹层、表单等
// 返回链里挂的面板快照若不跟随刷新，esc 返回后看到的是过期列表。
//
// update 只在 kind 匹配的视图上调用；无任何匹配时返回原引用（React 依引用相等跳过重渲染，
// 不做无谓 setView）。update 内部自行处理 cursor 夹取等语义，本函数只负责「沿链到达」。
export function refreshPanelsDeep(
  view: View,
  kind: 'skills' | 'mcp',
  update: (v: View) => View,
): View {
  const next = view.kind === kind ? update(view) : view
  const child = returnViewChild(next)
  if (child === undefined) return next
  const patched = refreshPanelsDeep(child, kind, update)
  // 子视图未变则保持父引用不变——逐层短路，保证「无匹配 → 原引用」传递到顶层。
  return patched === child ? next : { ...(next as ReturnViewHolder), returnView: patched }
}
