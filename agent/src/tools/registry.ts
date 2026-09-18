import type { Tool } from './types'
import { ReadFileTool } from './read_file'
import { WriteFileTool } from './write_file'
import { EditFileTool } from './edit_file'
import { ShellTool } from './shell'
import { LsTool } from './ls'
import { GlobTool } from './glob'
import { GrepTool } from './grep'

// 工具注册表：内置 7 个工具（withBuiltins()），支持运行期注册扩展（如将来 MCP 工具）。
// schemas() 每次现算——替代旧 import 期固化的 toolSchemas() 快照，注册表变化能正确反映。
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

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

  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  // 运行期摘除（MCP server 停止/工具清单变化时用）——不存在时静默。
  unregister(name: string): void {
    this.tools.delete(name)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  all(): Tool[] {
    return [...this.tools.values()]
  }

  // 组装为 OpenAI `tools` 参数：每个工具一个 { type: 'function', function: {...} }。
  schemas(): object[] {
    return this.all().map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }
}
