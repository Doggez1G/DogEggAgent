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
// - 工具名 mcp__<server>__<tool>（LLM 可见的命名空间标签；不合规时由注册关口整体哈希，见 registry）；
// - 注册必带身份 { kind: 'mcp', server, name }——权限服务键（服务裸名桶键）按身份匹配，
//   与标签字面无关；按身份摘除，绝不按前缀扫描；
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

// 启动期两阶段（connect / listTools）的超时上限（立法）：CALL_TIMEOUT_MS 只覆盖 callTool
// （SDK request 级 timeout 参数），启动期没有任何内建上限——command 误指 REPL、下载卡住的
// server 会把 connect 挂死，而 rebuild 是串行链（启动/config 变更/set_cwd/面板 manage 都排队），
// 一个挂死的 server 就阻塞整条链，MCP 子系统失去自愈。两阶段各自计时，超时按启动失败处理，
// 走 startOne 既有 catch 路径（closeQuietly 释放 client/子进程、状态落 error 面板可见）。
const MCP_STARTUP_TIMEOUT_MS = 30_000

export class McpManager {
  private readonly servers = new Map<string, McpServerRuntime>()

  constructor(private readonly deps: { registry: ToolRegistry; emit: (m: AgentToUiMessage) => void; /** 启动超时的测试接缝——缺省 MCP_STARTUP_TIMEOUT_MS（30s）。 */ startupTimeoutMs?: number }) {}

  // 期望状态 → diff 停启。幂等：多次调用收敛到 desired；任何变化后重播 tools_list + mcp_list。
  async rebuild(desired: McpMergedEntry[]): Promise<void> {
    let changed = false
    const desiredNames = new Set(desired.map((d) => d.server.name))

    // 停止：被移除 / 停用 / 配置变化的现有 server（被移除的顺带清出 map）。
    for (const [name, rt] of [...this.servers]) {
      const next = desired.find((d) => d.server.name === name)
      if (!next || !next.server.enabled || stableStringify(next.server.transport) !== stableStringify(rt.config.transport)) {
        void this.stopOne(name) // 同步落状态 + 后台关连接——广播不被 close 时序阻塞
        if (!next) this.servers.delete(name)
        else { rt.config = next.server; rt.scope = next.scope } // 保留壳体让 listStatus 反映最新配置
        changed = true
      }
    }
    // 启动：启用中的 server——新增 / 传输变化 / 尚未运行的才启动；disabled 跳过（保持 stopped）。
    for (const entry of desired) {
      if (!entry.server.enabled) continue
      const existing = this.servers.get(entry.server.name)
      if (existing?.status === 'running' && stableStringify(existing.config.transport) === stableStringify(entry.server.transport)) {
        // 迁移不改传输也要刷新归属（global↔project 同名覆盖）：scope 停留旧值会让面板的
        // 删除/启停写回错误层。归属真的变了才置 changed——静态刷新无需重播广播。
        if (existing.scope !== entry.scope) changed = true
        existing.config = entry.server
        existing.scope = entry.scope
        continue
      }
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
      rt.client = client // 先挂到 rt——catch 兜底统一经 closeQuietly 关闭（listTools 失败时连接已建立）
      const transport = cfg.transport.type === 'stdio'
        ? new StdioClientTransport({ command: cfg.transport.command, args: cfg.transport.args, env: toEnvMap(cfg.transport.env) })
        : new StreamableHTTPClientTransport(new URL(cfg.transport.url), { requestInit: { headers: cfg.transport.headers } })
      await this.withStartupTimeout(client.connect(transport), 'connect')
      const { tools } = await this.withStartupTimeout(client.listTools(), 'listTools')
      rt.tools = tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: (t.inputSchema ?? {}) as Record<string, unknown> }))
      rt.status = 'running'
      rt.error = undefined
    } catch (e) {
      rt.status = 'error'
      rt.error = (e as Error).message
      // 立法：connect 成功后任何失败路径都必须关闭连接，否则 stdio 子进程泄漏
      //（SDK 只在 connect 自身失败时自关；此后连接与子进程永久存活）。
      void this.closeQuietly(rt)
      rt.tools = []
    }
  }

  // 启动阶段带超时竞速（P2-8）：connect 与 listTools 各自计时，超时 reject 走 startOne 既有
  // 失败路径。race 出结果后必须 clearTimeout（finally）——否则定时器在剩余窗口内无谓持有进程；
  // unref 兜底：即使某处未来漏清，启动期挂着的定时器也不该拖住进程退出（shutdown 路径）。
  private withStartupTimeout<T>(stage: Promise<T>, phase: string): Promise<T> {
    const ms = this.deps.startupTimeoutMs ?? MCP_STARTUP_TIMEOUT_MS
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`MCP ${phase} 启动超时（${Math.round(ms / 1000)}s）`)), ms)
      timer.unref()
    })
    return Promise.race([stage, timeout]).finally(() => clearTimeout(timer))
  }

  // 停止单个 server（同步落状态）：摘除工具 + 状态落为 stopped 立即生效；连接关闭后台执行（1s 竞速上限）。
  // 立法：状态变更必须同步完成（广播/面板即时可见），连接关闭是后台事务——stdio 子进程退出时序
  // 偶发让 close 不返回，同步 await 会卡死 rebuild 与其后的整个串行链。
  // 返回 close 竞速的 Promise（stopAll 需要等待全部关闭完成；rebuild 等调用方以 void 丢弃维持原语义）。
  private stopOne(name: string): Promise<void> {
    const rt = this.servers.get(name)
    if (!rt) return Promise.resolve()
    rt.status = 'stopped'
    rt.tools = []
    this.unregisterServerTools(name)
    return this.closeQuietly(rt)
  }

  // 优雅退出（P2-6a）：停掉全部 server——唯一调用方是 Agent.dispose（组合根信号处理的下游）。
  // 复用 stopOne（注册表摘除 + 状态落 stopped + closeQuietly），退出与运行中停用走同一条清理路径，
  // 不另写一套（两套清理必然漂移）。await 全部 close 竞速（单个 1s 上限、并行）——dispose 返回后
  // 组合根即可安全退出，stdio 子进程不会拖着不回收。
  async stopAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((name) => this.stopOne(name)))
  }

  // 尽力而为关闭连接（1s 竞速上限）：startOne 失败兜底 / syncRegistry 判死 / stopOne 共用。
  // close 抛错（已断开/SDK connect 失败路径已自关）静默吞掉；关不动的连接放弃等待，
  // close 本身仍在后台推进（SDK close 内部会升级到强杀子进程）。
  // 返回竞速 Promise——调用方自行决定 fire-and-forget（void）还是等待（stopAll）。
  private closeQuietly(rt: McpServerRuntime): Promise<void> {
    const client = rt.client
    rt.client = undefined
    if (!client) return Promise.resolve()
    return Promise.race([
      client.close().catch(() => { /* 已断开则忽略 */ }),
      new Promise<void>((r) => setTimeout(r, 1000)),
    ])
  }

  // 把运行中 server 的工具注册进注册表（先摘后挂——server 工具清单可能变化）。
  // 注册携带身份（kind: 'mcp' + 服务名 + 内部工具名）——权限服务键匹配与 UI 分组的唯一事实源。
  // 单服务注册失败（合规关口的命名冲突等）按服务隔离：该服务落 error 可见，其余服务照常挂载。
  private syncRegistry(): void {
    for (const name of this.servers.keys()) this.unregisterServerTools(name)
    for (const [serverName, rt] of this.servers) {
      if (rt.status !== 'running') continue
      try {
        for (const t of rt.tools) {
          this.deps.registry.register(this.makeAdapter(serverName, rt, t), { kind: 'mcp', server: serverName, name: t.name })
        }
      } catch (e) {
        rt.status = 'error'
        rt.error = (e as Error).message
        rt.tools = []
        this.unregisterServerTools(serverName) // 清掉半挂状态：冲突前已注册的本服务工具一并摘除
        // 服务判死即断连（error 态不再持连接）：连接若留着，下次 rebuild 走 startOne 顶替
        // map 条目时旧 client 无人关闭——stdio 子进程泄漏。连接已建立，关闭必须兜底。
        void this.closeQuietly(rt)
      }
    }
  }

  // 按身份摘除（替代旧的前缀字符串扫描）：从注册表身份里找本服务的全部标签，逐个摘除。
  // 哈希标签不带 mcp__ 前缀，前缀扫描会漏删——身份是唯一可靠的归属事实源。
  private unregisterServerTools(serverName: string): void {
    for (const label of this.deps.registry.labelsWhere((id) => id.kind === 'mcp' && id.server === serverName)) {
      this.deps.registry.unregister(label)
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
    this.deps.emit({ type: 'tools_list', tools: this.deps.registry.listTools() })
  }
}

// env 数组语义：undefined → 继承父进程环境（SDK 默认行为）；显式对象 → 仅提供指定变量。
function toEnvMap(env: Record<string, string> | undefined): Record<string, string> | undefined {
  return env
}

// 稳定序列化：对象键排序后再 stringify（递归生效；数组保持原序——args/headers 数组的顺序本身是语义）。
// 立法：传输等价比较必须键序不敏感——手编配置文件键序不同（如 command/args 互换书写）不该被
// 误判为传输变化而触发无谓重启。
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    }
    return v
  })
}
