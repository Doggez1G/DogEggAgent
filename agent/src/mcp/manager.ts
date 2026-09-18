import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import type { AgentToUiMessage, McpServerConfig } from '@dogegg/bridge'
import type { Tool, ToolResult } from '../tools'
import type { ToolRegistry } from '../tools'
import type { McpMergedEntry } from './project'

// MCP 管理器（M4.2）：官方 SDK Client 之上的一层薄封装——
// rebuild(desired) 做 diff 增删启停；每个 server 维护 状态 + 工具清单；工具适配进 ToolRegistry。
//
// 立法：
// - 工具名 mcp__<server>__<tool>（命名空间防撞 + 权限桶可按 mcp__fs__* 通配）；
// - 参数不本地强校验：zod 仅做「对象」级宽松校验，真实校验权在 server（原生 JSON Schema 透传给 LLM）；
// - 第三方工具默认走权限 ask（三桶无规则时的固定安全默认，无需额外处理）；
// - 生命周期全部异步：rebuild 由门面 fire-and-forget 调用，状态经 mcp_list 广播（不阻塞消息循环）。

export type McpStatus = 'running' | 'starting' | 'error' | 'stopped'

interface McpServerRuntime {
  config: McpServerConfig
  scope: 'global' | 'project'
  status: McpStatus
  error?: string
  client?: Client
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[]
}

export interface McpServerStatusView {
  name: string
  enabled: boolean
  scope: 'global' | 'project'
  transport: McpServerConfig['transport']
  type: 'stdio' | 'http'
  status: McpStatus
  error?: string
  tools: { name: string; description: string }[]
}

const CALL_TIMEOUT_MS = 60_000

export class McpManager {
  private readonly servers = new Map<string, McpServerRuntime>()

  constructor(private readonly deps: { registry: ToolRegistry; emit: (m: AgentToUiMessage) => void }) {}

  // 期望状态 → diff 停启。幂等：多次调用收敛到 desired；任何变化后重播 tools_list + mcp_list。
  async rebuild(desired: McpMergedEntry[]): Promise<void> {
    let changed = false
    const desiredNames = new Set(desired.map((d) => d.server.name))

    // 停止：被移除 / 停用 / 配置变化的现有 server（被移除的顺带清出 map）。
    for (const [name, rt] of [...this.servers]) {
      const next = desired.find((d) => d.server.name === name)
      if (!next || !next.server.enabled || JSON.stringify(next.server.transport) !== JSON.stringify(rt.config.transport)) {
        this.stopOne(name) // 同步落状态 + 后台关连接——广播不被 close 时序阻塞
        if (!next) this.servers.delete(name)
        else { rt.config = next.server; rt.scope = next.scope } // 保留壳体让 listStatus 反映最新配置
        changed = true
      }
    }
    // 启动：启用中的 server——新增 / 传输变化 / 尚未运行的才启动；disabled 跳过（保持 stopped）。
    for (const entry of desired) {
      if (!entry.server.enabled) continue
      const existing = this.servers.get(entry.server.name)
      if (existing?.status === 'running' && JSON.stringify(existing.config.transport) === JSON.stringify(entry.server.transport)) continue
      await this.startOne(entry)
      changed = true
    }
    // 清理被移除后残留的空壳。
    for (const name of [...this.servers.keys()]) if (!desiredNames.has(name)) this.servers.delete(name)

    if (changed) this.broadcast()
  }

  // 启动单个 server：connect → listTools → 注册适配工具。任何失败 → status=error（不抛出，面板可见）。
  private async startOne(entry: McpMergedEntry): Promise<void> {
    const cfg = entry.server
    const rt: McpServerRuntime = { config: cfg, scope: entry.scope, status: 'starting', tools: [] }
    this.servers.set(cfg.name, rt)
    this.broadcast()
    try {
      const client = new Client({ name: 'dogegg-agent', version: '0.2.0' })
      const transport = cfg.transport.type === 'stdio'
        ? new StdioClientTransport({ command: cfg.transport.command, args: cfg.transport.args, env: toEnvMap(cfg.transport.env) })
        : new StreamableHTTPClientTransport(new URL(cfg.transport.url), { requestInit: { headers: cfg.transport.headers } })
      await client.connect(transport)
      const { tools } = await client.listTools()
      rt.client = client
      rt.tools = tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: (t.inputSchema ?? {}) as Record<string, unknown> }))
      rt.status = 'running'
      rt.error = undefined
    } catch (e) {
      rt.status = 'error'
      rt.error = (e as Error).message
      rt.client = undefined
      rt.tools = []
    }
  }

  // 停止单个 server（同步）：摘除工具 + 状态落为 stopped 立即生效；连接关闭后台执行（1s 竞速上限）。
  // 立法：状态变更必须同步完成（广播/面板即时可见），连接关闭是后台事务——stdio 子进程退出时序
  // 偶发让 close 不返回，同步 await 会卡死 rebuild 与其后的整个串行链。
  private stopOne(name: string): void {
    const rt = this.servers.get(name)
    if (!rt) return
    const client = rt.client
    rt.client = undefined
    rt.status = 'stopped'
    rt.tools = []
    this.unregisterServerTools(name)
    if (client) {
      void Promise.race([
        client.close().catch(() => { /* 已断开则忽略 */ }),
        new Promise((r) => setTimeout(r, 1000)),
      ])
    }
  }

  // 把运行中 server 的工具注册进注册表（先摘后挂——server 工具清单可能变化）。
  private syncRegistry(): void {
    for (const [name, rt] of this.servers) this.unregisterServerTools(name)
    for (const [serverName, rt] of this.servers) {
      if (rt.status !== 'running') continue
      for (const t of rt.tools) this.deps.registry.register(this.makeAdapter(serverName, rt, t))
    }
  }

  private unregisterServerTools(serverName: string): void {
    const prefix = `mcp__${serverName}__`
    for (const name of this.deps.registry.all().map((t) => t.name)) {
      if (name.startsWith(prefix)) this.deps.registry.unregister(name)
    }
  }

  // MCP 工具 → Tool 适配器：schema 宽松（对象透传），parameters 用 server 提供的原生 JSON Schema。
  private makeAdapter(serverName: string, rt: McpServerRuntime, tool: { name: string; description: string; inputSchema: Record<string, unknown> }): Tool {
    const fullName = `mcp__${serverName}__${tool.name}`
    return {
      name: fullName,
      description: tool.description || `(MCP ${serverName}) ${tool.name}`,
      schema: z.record(z.string(), z.unknown()),
      parameters: tool.inputSchema,
      execute: async (args, ctx) => {
        const client = rt.client
        if (!client) return { error: `MCP server ${serverName} 未运行` }
        try {
          const result = await client.callTool({ name: tool.name, arguments: (args ?? {}) as Record<string, unknown> }, undefined, { signal: ctx.signal, timeout: CALL_TIMEOUT_MS })
          const content = result.content as Array<{ type?: string; text?: string }> | undefined
          const text = (content ?? []).map((b) => (b.type === 'text' ? b.text : JSON.stringify(b))).join('\n')
          if (result.isError) return { error: text || `MCP 工具 ${fullName} 执行失败` }
          return { content: text }
        } catch (e) {
          return { error: `MCP 调用失败：${(e as Error).message}` }
        }
      },
    } satisfies Tool
  }

  // 状态快照（mcp_list 载荷）。
  listStatus(): McpServerStatusView[] {
    return [...this.servers.values()].map((rt) => ({
      name: rt.config.name,
      enabled: rt.config.enabled,
      scope: rt.scope,
      transport: rt.config.transport, // 明细随快照下发——面板编辑预填（用户自己的配置，无隐私边界）
      type: rt.config.transport.type,
      status: rt.status,
      ...(rt.error ? { error: rt.error } : {}),
      tools: rt.tools.map((t) => ({ name: t.name, description: t.description })),
    }))
  }

  // 状态广播：mcp_list（配置+状态）与 tools_list（注册表已变化）。
  private broadcast(): void {
    this.syncRegistry()
    this.deps.emit({ type: 'mcp_list', servers: this.listStatus() })
    this.deps.emit({ type: 'tools_list', tools: this.deps.registry.all().map((t) => ({ name: t.name, description: t.description })) })
  }
}

// env 数组语义：undefined → 继承父进程环境（SDK 默认行为）；显式对象 → 仅提供指定变量。
function toEnvMap(env: Record<string, string> | undefined): Record<string, string> | undefined {
  return env
}
