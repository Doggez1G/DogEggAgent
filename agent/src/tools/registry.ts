import { createHash } from 'node:crypto'
import type { ToolIdentity } from '@dogegg/bridge'
import type { Tool } from './types'
import { ReadFileTool } from './read_file'
import { WriteFileTool } from './write_file'
import { EditFileTool } from './edit_file'
import { ShellTool } from './shell'
import { LsTool } from './ls'
import { GlobTool } from './glob'
import { GrepTool } from './grep'

// LLM 可见名的硬规定：供应商 API 对函数名的约束（OpenAI 系与 Anthropic 系一致——
// 字符集 [a-zA-Z0-9_-]、长度 ≤64）。校验发生在 API 请求层且拒绝整个请求，所以注册表
// 必须把住关口：任何来源（内建/MCP/未来扩展）的注册名不合格时整体哈希为确定性标签，
// 而不是把非法名字发给模型（那会让每一次对话请求整体 400）。
export const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

// 工具注册表：内置 7 个工具（withBuiltins()），支持运行期注册扩展（MCP 工具等）。
// schemas() 每次现算——替代旧 import 期固化的 toolSchemas() 快照，注册表变化能正确反映。
//
// 【统一关口立法】register 同时做三件事：
// 1. 合规转换——原名合规则原样注册（与现状逐字节一致）；不合规则整体哈希为 `h-<12位hex>`
//    确定性标签（同名必同标签）。变换落在 Tool 对象本身（name 字段被改写），保证 schemas()
//    发出的名字必然合规；
// 2. 冲突可见失败——目标标签已被占用时抛错，绝不静默覆盖（静默顶掉会让先注册的工具无声失联）；
// 3. 身份记录——每个工具带 ToolIdentity（builtin / mcp{server, name}），与工具同增同删。
//    身份是一切「工具从哪来」语义的唯一事实源：权限服务键匹配、UI 来源标注都查这里，
//    从不解析 LLM 可见名（哈希标签不透明也无妨）。
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()
  private readonly identityById = new Map<string, ToolIdentity>()

  // 内置工具集：read_file / write_file / edit_file / shell / ls / glob / grep。
  // 读类工具（read_file/ls/glob/grep）与写类工具（write_file/edit_file/shell）的默认权限分桶见出厂配置。
  static withBuiltins(): ToolRegistry {
    return new ToolRegistry([
      new ReadFileTool(),
      new WriteFileTool(),
      new EditFileTool(),
      new ShellTool(),
      new LsTool(),
      new GlobTool(),
      new GrepTool(),
    ])
  }

  constructor(tools: Tool[] = []) {
    for (const t of tools) this.register(t)
  }

  // 注册：返回最终注册标签（常规情况 === tool.name；哈希情况为 h-<hash>，调用方据此对接身份语义）。
  // identity 缺省为 builtin（内建构造路径零改动接入）。
  register(tool: Tool, identity: ToolIdentity = { kind: 'builtin' }): string {
    const label = TOOL_NAME_RE.test(tool.name)
      ? tool.name
      : `h-${createHash('sha256').update(tool.name).digest('hex').slice(0, 12)}`
    if (this.tools.has(label)) {
      throw new Error(`工具注册名冲突：${label}（原名 ${tool.name}）已被占用——请调整来源命名（如 /mcp 中的服务名）`)
    }
    this.tools.set(label, label === tool.name ? tool : { ...tool, name: label })
    this.identityById.set(label, identity)
    return label
  }

  // 运行期摘除（MCP server 停止/工具清单变化时用）——工具与身份同步删除；不存在时静默。
  unregister(name: string): void {
    this.tools.delete(name)
    this.identityById.delete(name)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  all(): Tool[] {
    return [...this.tools.values()]
  }

  // 身份只读访问：单查 / 全量快照（权限引擎注入用）/ 按谓词找标签（按服务摘除用）。
  identityOf(name: string): ToolIdentity | undefined {
    return this.identityById.get(name)
  }

  identities(): ReadonlyMap<string, ToolIdentity> {
    return this.identityById
  }

  labelsWhere(pred: (id: ToolIdentity) => boolean): string[] {
    const out: string[] = []
    for (const [label, id] of this.identityById) if (pred(id)) out.push(label)
    return out
  }

  // tools_list 载荷：工具 + 身份（注册表不变量：凡注册必有身份；?? 兜底仅为类型完备）。
  listTools(): { name: string; description: string; identity: ToolIdentity }[] {
    return this.all().map((t) => ({
      name: t.name,
      description: t.description,
      identity: this.identityOf(t.name) ?? { kind: 'builtin' },
    }))
  }

  // 组装为 OpenAI `tools` 参数：每个工具一个 { type: 'function', function: {...} }。
  schemas(): object[] {
    return this.all().map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }
}
