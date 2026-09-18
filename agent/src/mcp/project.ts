import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { mcpServerSchema, type McpServerConfig } from '@dogegg/bridge'

// 项目级 MCP 配置（.dogegg/.mcp.json）：与全局 config.json 的 mcpServers 同 schema，同名覆盖全局。
// 读取容错：文件缺失 / JSON 损坏 / 条目校验失败 → 空数组（项目配置错误不拖垮全局）。

function projectFile(cwd: string): string {
  return join(cwd, '.dogegg', '.mcp.json')
}

const projectListSchema = z.array(mcpServerSchema)

export function readProjectMcp(cwd: string): McpServerConfig[] {
  const file = projectFile(cwd)
  if (!existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return projectListSchema.parse(raw.mcpServers ?? [])
  } catch {
    return []
  }
}

export function writeProjectMcp(cwd: string, servers: McpServerConfig[]): void {
  mkdirSync(join(cwd, '.dogegg'), { recursive: true })
  writeFileSync(projectFile(cwd), JSON.stringify({ mcpServers: servers }, null, 2) + '\n', 'utf8')
}

export interface McpMergedEntry {
  server: McpServerConfig
  scope: 'global' | 'project'
}

// 合并立法：项目级同名条目覆盖全局；其余全局条目原样保留。顺序：全局在前、项目新增在后。
// scope 随条目下发——manager 状态与 /mcp 面板的启停/删除需要知道写回哪一层。
export function mergeMcpServers(globalServers: McpServerConfig[], projectServers: McpServerConfig[]): McpMergedEntry[] {
  const merged = globalServers
    .filter((g) => !projectServers.some((p) => p.name === g.name))
    .map((server) => ({ server, scope: 'global' as const }))
  return [...merged, ...projectServers.map((server) => ({ server, scope: 'project' as const }))]
}
