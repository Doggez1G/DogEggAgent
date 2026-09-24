import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { Agent } from '../../src/agent'
import { ConfigStore } from '../../src/config'
import { InMemoryChannel } from '@dogegg/bridge'
import type { AgentToUiMessage, Message, McpServerConfig, UiToAgentMessage } from '@dogegg/bridge'
import type { LlmClient, LlmStreamEvent } from '../../src/llm'

// MCP 端到端（假 stdio server = 原生 JSON-RPC 脚本，零 SDK 依赖——与真实 server 同为行分隔 JSON-RPC）：
// 启动注册（tools_list 含 mcp 工具）→ 轮次调用（权限审批后 echo 回显）→ 面板 CRUD（启停/项目文件）。

// 假 server：逐行读请求，按 method 返回固定结果；initialize/tools:list/tools:call 三件套。
// pid 落盘（argv[2] 给出标记文件时）：供测试断言「子进程存续/回收」——是否被无谓重启、失败路径是否泄漏。
const FAKE_SERVER_JS = `
import readline from 'node:readline'
import { writeFileSync } from 'node:fs'
if (process.argv[2]) writeFileSync(process.argv[2], String(process.pid))
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined || msg.id === null) return
  let result = {}
  if (msg.method === 'initialize') {
    result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } }
  } else if (msg.method === 'tools/list') {
    result = { tools: [{ name: 'echo', description: '回显输入文本', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }
  } else if (msg.method === 'tools/call') {
    result = { content: [{ type: 'text', text: 'echo:' + JSON.stringify(msg.params.arguments ?? {}) }] }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
})
`

// 只答 initialize 的假 server：tools/list（及一切后续请求）回 JSON-RPC 错误——
// 模拟「connect 成功但 listTools 失败」：不走 60s SDK 默认超时，错误响应让 listTools 立即 reject。
const FAKE_LIST_FAIL_JS = `
import readline from 'node:readline'
import { writeFileSync } from 'node:fs'
if (process.argv[2]) writeFileSync(process.argv[2], String(process.pid))
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined || msg.id === null) return
  if (msg.method === 'initialize') {
    const result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
    return
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'tools/list failed' } }) + '\\n')
})
`

function makeConfig(mcpServers: McpServerConfig[]) {
  return new ConfigStore().load({
    providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x/v1', apiKey: 'k', models: [{ name: 'm' }] }],
    mcpServers,
  })
}

// 脚本化 client：call 1 发 tool_calls（echo 工具），call 2 收尾。
function toolCallScript(): LlmClient {
  let call = 0
  return {
    async chat(_req: unknown, _signal: AbortSignal, _emit: (e: LlmStreamEvent) => void) {
      call++
      if (call === 1) {
        return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'mcp__fake__echo', arguments: '{"text":"hi"}' } }] } } as unknown as Message
      }
      return { message: { role: 'assistant', content: '工具结果已收到' }, reasoning: undefined }
    },
  } as unknown as LlmClient
}

function makeAgent(client: LlmClient, mcpServers: McpServerConfig[]) {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'dogegg-mcp-'))
  const cwd = mkdtempSync(join(tmpdir(), 'dogegg-mcpcwd-'))
  // 配置落盘路径必须指向临时文件——全局 mcp_manage 会触发 config 保存，
  // 缺省路径是用户真实配置（本测试曾因此覆写真实配置，教训立法）。
  const configPath = mkdtempSync(join(tmpdir(), 'dogegg-mcpcfg-')) + '/config.json'
  const { agentPort, uiPort } = new InMemoryChannel()
  const events: AgentToUiMessage[] = []
  // eslint-disable-next-line no-new
  new Agent(agentPort, makeConfig(mcpServers), cwd, { client, sessionsDir, configPath })
  uiPort.onMessage((m) => {
    events.push(m)
    log.push(`${m.type}${m.type === 'mcp_list' ? ':' + JSON.stringify(m.servers.map((s) => ({ name: s.name, enabled: s.enabled, status: s.status }))) : m.type === 'notice' ? ':' + m.text + '|' + (m.channel ?? '-') : m.type === 'tools_list' ? ':' + (m.tools.some((t) => t.name.startsWith('mcp')) ? '有mcp' : '无mcp') : ''}`)
  })
  const post = (m: UiToAgentMessage) => { uiPort.post(m) }
  return { events, post, cwd, sessionsDir, configPath }
}

async function waitFor(events: AgentToUiMessage[], pred: (e: AgentToUiMessage) => boolean, label: string): Promise<AgentToUiMessage> {
  // 从最新往回找——同一类事件会多次到达（starting→running 等），断言必须针对最新快照。
  const deadline = Date.now() + 3000
  for (;;) {
    const found = [...events].reverse().find(pred)
    if (found) return found
    if (Date.now() > deadline) throw new Error(`等待 ${label} 超时；已收到：${events.map((e) => e.type).join(',')}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function waitRunning(post: (m: UiToAgentMessage) => void, events: AgentToUiMessage[]): Promise<void> {
  const deadline = Date.now() + 3000
  for (;;) {
    post({ type: 'mcp_request' })
    // 从最新往回找——mcp_list 会随生命周期多次到达（starting→running）。
    const list = [...events].reverse().find((e) => e.type === 'mcp_list') as Extract<AgentToUiMessage, { type: 'mcp_list' }> | undefined
    if (list?.servers.some((s) => s.name === 'fake' && s.status === 'running')) return
    if (Date.now() > deadline) throw new Error(`等待 fake server 启动超时；最后状态：${JSON.stringify(list?.servers)}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

// 轮询进程存活（signal 0 探测）——断言 stdio 子进程真的退出（close 兜底生效），而非仅状态翻转。
async function waitPidDead(pid: number, label: string): Promise<void> {
  const deadline = Date.now() + 5000
  for (;;) {
    let alive = true
    try { process.kill(pid, 0) } catch { alive = false }
    if (!alive) return
    if (Date.now() > deadline) throw new Error(`等待 ${label} 退出超时：pid ${pid} 仍存活`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

const log: string[] = []

describe('MCP 端到端（假 stdio server）', () => {
  it('启动注册：tools_list 出现 mcp 工具；轮次调用经审批后回显', async () => {
    const script = join(mkdtempSync(join(tmpdir(), 'dogegg-mcpbin-')), 'fake.mjs')
    writeFileSync(script, FAKE_SERVER_JS, 'utf8')
    const { events, post } = makeAgent(toolCallScript(), [{ name: 'fake', enabled: true, transport: { type: 'stdio', command: process.execPath, args: [script] } }])

    await waitRunning(post, events)
    // mcp_list 快照携带 transport 明细（面板编辑预填的数据源）。
    const list = [...events].reverse().find((e) => e.type === 'mcp_list') as Extract<AgentToUiMessage, { type: 'mcp_list' }>
    expect(list.servers[0]?.transport).toMatchObject({ type: 'stdio', command: process.execPath })
    // MCP 工具集注册联动 token 显示刷新：本用例从未 post 过 context_request——
    // 注册完成的 tools_list 广播伴随的 context_state 出现即证明刷新链路生效。
    const ctxState = await waitFor(events, (e) => e.type === 'context_state', 'context_state') as Extract<AgentToUiMessage, { type: 'context_state' }>
    expect(ctxState.breakdown!.tools).toBeGreaterThan(0)
    // 工具注册进注册表：tools_list 出现命名空间化的 mcp 工具。
    post({ type: 'tools_request' })
    const tools = await waitFor(events, (e) => e.type === 'tools_list', 'tools_list')
    expect(JSON.stringify(tools)).toContain('mcp__fake__echo')

    // 轮次调用：模型发起 → 权限默认 ask → 审批放行 → adapter 调 server → 回显。
    post({ type: 'submit', text: '调用 echo 工具' })
    const perm = await waitFor(events, (e) => e.type === 'permission_request', 'permission_request')
    post({ type: 'permission_decision', id: (perm as Extract<AgentToUiMessage, { type: 'permission_request' }>).id, decision: 'allow_once' })
    await waitFor(events, (e) => e.type === 'finished', 'finished')
    const toolEnd = events.find((e) => e.type === 'tool_end') as Extract<AgentToUiMessage, { type: 'tool_end' }> | undefined
    expect(toolEnd?.output).toBe('echo:{"text":"hi"}')
  })

  it('面板 CRUD：停用 → 工具摘除；项目级 save 落盘 .dogegg/.mcp.json；delete 移除', async () => {
    const script = join(mkdtempSync(join(tmpdir(), 'dogegg-mcpbin-')), 'fake.mjs')
    writeFileSync(script, FAKE_SERVER_JS, 'utf8')
    const { events, post, cwd, configPath } = makeAgent(toolCallScript(), [{ name: 'fake', enabled: true, transport: { type: 'stdio', command: process.execPath, args: [script] } }])
    await waitRunning(post, events)

    // 停用 → rebuild → 工具从注册表摘除。
    post({ type: 'mcp_manage', action: 'toggle', scope: 'global', name: 'fake', enabled: false })
    await waitFor(events, (e) => e.type === 'tools_list' && !(e as Extract<AgentToUiMessage, { type: 'tools_list' }>).tools.some((t) => t.name === 'mcp__fake__echo'), 'tools 摘除')
    const stopped = await waitFor(events, (e) => e.type === 'mcp_list', 'mcp_list 停用')
    expect(JSON.stringify(stopped)).toContain('"stopped"')
    // 配置变更即时推送 status_state（状态栏/右侧面板不等下一轮问答才刷新）。
    await waitFor(events, (e) => e.type === 'status_state', 'toggle 后的 status_state')
    // 全局写入只落测试配置文件（接缝生效）——用户真实配置永不被测试触碰。
    expect(readFileSync(configPath, 'utf8')).toContain('"enabled": false')

    // 项目级 save → .dogegg/.mcp.json 落盘。
    const cfg2: McpServerConfig = { name: 'proj-srv', enabled: true, transport: { type: 'stdio', command: process.execPath, args: [script] } }
    post({ type: 'mcp_manage', action: 'save', scope: 'project', server: cfg2 })
    await waitFor(events, (e) => e.type === 'mcp_list' && JSON.stringify(e).includes('proj-srv'), 'project save')
    expect(existsSync(join(cwd, '.dogegg', '.mcp.json'))).toBe(true)
    expect(readFileSync(join(cwd, '.dogegg', '.mcp.json'), 'utf8')).toContain('proj-srv')

    // delete → 移除。
    post({ type: 'mcp_manage', action: 'delete', scope: 'project', name: 'proj-srv' })
    await waitFor(events, (e) => e.type === 'mcp_list' && !JSON.stringify(e).includes('proj-srv'), 'project delete')
    expect(readFileSync(join(cwd, '.dogegg', '.mcp.json'), 'utf8')).not.toContain('proj-srv')
  })

  it('失败路径回收：connect 成功但 tools/list 失败 → error 可见且 stdio 子进程被关闭（不泄漏）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dogegg-mcpfail-'))
    const script = join(dir, 'fake.mjs')
    writeFileSync(script, FAKE_LIST_FAIL_JS, 'utf8')
    const marker = join(dir, 'pid.txt')
    const { events } = makeAgent(toolCallScript(), [{ name: 'fake', enabled: true, transport: { type: 'stdio', command: process.execPath, args: [script, marker] } }])

    // 失败可见：面板状态落 error 且携带人话原因（mcp_list 的 error 字段）。
    await waitFor(events, (e) => e.type === 'mcp_list' && JSON.stringify(e).includes('"error"'), 'error 状态')
    // 泄漏立法：connect 成功后任何失败路径都必须关闭连接——子进程随之退出（closeQuietly 1s 竞速兜底）。
    const pid = Number(readFileSync(marker, 'utf8'))
    await waitPidDead(pid, '失败路径泄漏的 stdio 子进程')
  })

  it('同名同传输 global→project 迁移：不重启子进程且 mcp_list 刷新为新 scope（面板操作打到正确层）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dogegg-mcpscope-'))
    const script = join(dir, 'fake.mjs')
    writeFileSync(script, FAKE_SERVER_JS, 'utf8')
    const marker = join(dir, 'pid.txt')
    const cfg: McpServerConfig = { name: 'fake', enabled: true, transport: { type: 'stdio', command: process.execPath, args: [script, marker] } }
    const { events, post } = makeAgent(toolCallScript(), [cfg])
    await waitRunning(post, events)
    const pidBefore = Number(readFileSync(marker, 'utf8'))

    // 同名同传输落到项目层：merge 后 scope 变 project、transport 不变 → 只刷归属，不该重启。
    post({ type: 'mcp_manage', action: 'save', scope: 'project', server: cfg })
    await waitFor(events, (e) => e.type === 'mcp_list' && JSON.stringify(e).includes('"scope":"project"'), 'scope 迁移到 project')
    // 无谓重启防护：等价传输（稳定序列化，键序不敏感）不该换子进程——同一 pid 仍在服务。
    expect(Number(readFileSync(marker, 'utf8'))).toBe(pidBefore)
  })
})

afterEach(() => {
  console.log('EVENTS:', JSON.stringify(log))
  log.length = 0
})
