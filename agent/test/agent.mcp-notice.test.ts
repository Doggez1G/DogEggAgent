import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { Agent } from '../src/agent'
import { ConfigStore } from '../src/config'
import { InMemoryChannel } from '@dogegg/bridge'
import type { AgentToUiMessage, McpServerConfig, UiToAgentMessage } from '@dogegg/bridge'
import type { LlmClient } from '../src/llm'

// ─────────────────────────────────────────────────────────────────────────────
// MCP 配置的可见失败测试（黑盒走 Port 收发）：
// 1. 项目级 .mcp.json 写失败 → 发 notice（channel: mcp），不静默（错误可见立法）；
// 2. 项目级服务的裸名权限键（如 "playwright"）→ MCP 重建后发运行时告警——
//    config superRefine 只校验全局名单，项目级服务的裸键在此前是静默失效的盲区。
// ─────────────────────────────────────────────────────────────────────────────

// 永不真正启动 server 的条目（enabled=false 只留配置事实，避免测试拉起进程）。
const disabledServer: McpServerConfig = {
  name: 'playwright',
  enabled: false,
  transport: { type: 'http', url: 'http://localhost:1' },
}

function makeAgent(opts: {
  permission?: Record<string, Record<string, { whole: boolean; patterns: string[] }>>
  cwd?: string
  client?: LlmClient
} = {}) {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'dogegg-mcp-notice-sessions-'))
  const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), 'dogegg-mcp-notice-'))
  const config = new ConfigStore().load({
    providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x/v1', apiKey: 'k', models: [{ name: 'm' }] }],
    permission: opts.permission ?? { allow: {}, reject: {}, ask: {} },
  })
  const { agentPort, uiPort } = new InMemoryChannel()
  const events: AgentToUiMessage[] = []
  // eslint-disable-next-line no-new
  new Agent(agentPort, config, cwd, { client: opts.client, sessionsDir })
  uiPort.onMessage((m) => events.push(m))
  const post = (m: UiToAgentMessage) => { uiPort.post(m) }
  return { events, post, cwd }
}

// 轮询等待条件满足（2s 超时，超时输出已收到的事件类型辅助定位）。
async function waitFor(events: AgentToUiMessage[], pred: (e: AgentToUiMessage) => boolean, label: string): Promise<AgentToUiMessage> {
  const deadline = Date.now() + 2000
  for (;;) {
    const found = events.find(pred)
    if (found) return found
    if (Date.now() > deadline) {
      throw new Error(`等待 ${label} 超时；已收到：${events.map((e) => e.type).join(',')}`)
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('MCP 配置的可见失败', () => {
  it('项目级 .mcp.json 写失败：发 notice（channel: mcp），不静默', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dogegg-mcpwrite-'))
    // .dogegg 是一个文件而非目录 → writeProjectMcp 的 mkdirSync 必然失败，构造写盘故障。
    writeFileSync(join(cwd, '.dogegg'), 'blocker')
    const { events, post } = makeAgent({ cwd })

    post({ type: 'mcp_manage', scope: 'project', action: 'save', server: disabledServer })
    const notice = await waitFor(
      events,
      (e) => e.type === 'notice' && e.channel === 'mcp' && e.text.includes('写入失败'),
      '写入失败 notice',
    ) as Extract<AgentToUiMessage, { type: 'notice' }>
    expect(notice.text).toContain('项目级 MCP 配置写入失败')
  })

  it('项目级服务的裸名权限键：MCP 重建后发运行时告警（应写作 mcp:X）', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dogegg-mcpkey-'))
    mkdirSync(join(cwd, '.dogegg'), { recursive: true })
    writeFileSync(join(cwd, '.dogegg', '.mcp.json'), JSON.stringify({ mcpServers: [disabledServer] }))
    // 全局 config 的 mcpServers 为空 → superRefine 拦不住裸键（这正是加载期盲区）；
    // allow 桶写裸名 "playwright"——前缀立法下静默失效，只能靠运行时告警暴露。
    const { events } = makeAgent({
      cwd,
      permission: { allow: { playwright: { whole: true, patterns: [] } }, reject: {}, ask: {} },
    })

    // 启动即 rebuildMcp，重建完成后告警；文案指明正确写法。
    const notice = await waitFor(
      events,
      (e) => e.type === 'notice' && e.channel === 'mcp' && e.text.includes('playwright'),
      '裸键告警 notice',
    ) as Extract<AgentToUiMessage, { type: 'notice' }>
    expect(notice.text).toContain('应写作')
    expect(notice.text).toContain('mcp:playwright')
  })
})
