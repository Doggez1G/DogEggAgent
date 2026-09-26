import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, expect } from 'vitest'
import { Agent } from '../../src/agent'
import { ConfigStore, ConfigController } from '../../src/config'
import { InMemoryChannel } from '@dogegg/bridge'
import type { AgentToUiMessage, UiToAgentMessage } from '@dogegg/bridge'
import type { LlmClient } from '../../src/llm'

// ─────────────────────────────────────────────────────────────────────────────
// ConfigController 链路测试（黑盒走 Port 收下行）：配置编辑是「编辑 → 校验/回滚 → 落盘 →
// 运行时热重建 → config_updated 广播」的唯一写路径。与 loader.test.ts（ConfigStore.load 的
// zod/默认值语义）和 editor.test.ts（编辑器纯逻辑）互补，本文件聚焦 controller 的编排行为：
// 成功路径（落盘+热重建+广播）、busy 拦截、保存失败可见（不换运行时、不广播）、
// 非法值回滚守卫（config_updated 带回滚后的 lastGood 快照）。
// ─────────────────────────────────────────────────────────────────────────────

type NoticeMsg = Extract<AgentToUiMessage, { type: 'notice' }>
type ConfigUpdatedMsg = Extract<AgentToUiMessage, { type: 'config_updated' }>
type ConfigStateMsg = Extract<AgentToUiMessage, { type: 'config_state' }>
type StatusStateMsg = Extract<AgentToUiMessage, { type: 'status_state' }>

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

function makeConfig() {
  return new ConfigStore().load({
    providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x/v1', apiKey: 'k', models: [{ name: 'm' }] }],
  })
}

// 即答式 client：任何 chat 调用直接返回最终文本（config 测试不关心轮次内容）。
function echoAdapter(): LlmClient {
  return {
    async chat() {
      return { message: { role: 'assistant', content: '回复' }, reasoning: undefined }
    },
  } as unknown as LlmClient
}

// 首次调用挂起直到手动放行——制造「轮次在飞」（gate busy）的稳定观察窗口；
// 第二次调用起（放行后的自动标题）即答，保证收尾干净。
function hangingTurnAdapter(): { client: LlmClient; releaseTurn: () => void } {
  let call = 0
  let release!: () => void
  const gate = new Promise<void>((res) => { release = res })
  const client = {
    async chat(_req: unknown, _signal: AbortSignal, _emit: (e: never) => void) {
      call++
      if (call === 1) {
        await gate
        return { message: { role: 'assistant', content: '慢轮次' }, reasoning: undefined }
      }
      return { message: { role: 'assistant', content: '自动标题' }, reasoning: undefined }
    },
  } as unknown as LlmClient
  return { client, releaseTurn: release }
}

// configPath 注入临时目录（ConfigStore 的落盘测试接缝）——config_set 会真实写盘，
// 不注入的话会用测试数据覆写用户真实配置（见 ConfigStore 构造注释）。
function makeAgent(client: LlmClient) {
  const sessionsDir = tmp('dogegg-ctrl-sess-')
  const cwd = tmp('dogegg-ctrl-cwd-')
  const configDir = tmp('dogegg-ctrl-cfg-')
  const configPath = join(configDir, 'config.json')
  const { agentPort, uiPort } = new InMemoryChannel()
  const events: AgentToUiMessage[] = []
  const agent = new Agent(agentPort, makeConfig(), cwd, { client, sessionsDir, configPath })
  uiPort.onMessage((m) => events.push(m))
  const post = (m: UiToAgentMessage) => { uiPort.post(m) }
  return { events, post, agent, configPath }
}

// 轮询等待目标事件（2s 超时）。
async function waitFor(events: AgentToUiMessage[], pred: (e: AgentToUiMessage) => boolean, label: string): Promise<AgentToUiMessage> {
  const deadline = Date.now() + 2000
  for (;;) {
    const found = events.find(pred)
    if (found) return found
    if (Date.now() > deadline) throw new Error(`等待 ${label} 超时；已收到：${events.map((e) => e.type).join(',')}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('ConfigController（config_set 编辑链路）', () => {
  it('成功路径：合法 config_set → config_updated 携带新值 + 磁盘 config.json 已更新 + 运行时热切换', async () => {
    const { events, post, configPath } = makeAgent(echoAdapter())
    // 起点：本测试未发生任何成功保存——磁盘上还没有配置文件。
    expect(existsSync(configPath)).toBe(false)

    post({ type: 'config_set', path: 'providers.0.models.0.contextWindow', value: 64000 })

    // 广播：config_updated 载荷为新值（且只有这一次编辑、只有一条广播）。
    const updated = await waitFor(events, (e) => e.type === 'config_updated', 'config_updated')
    expect(events.filter((e) => e.type === 'config_updated')).toHaveLength(1)
    const cfg = (updated as ConfigUpdatedMsg).config
    expect(cfg.providers[0]?.models[0]?.contextWindow).toBe(64000)

    // 磁盘：config.json 已按新值落盘（原子写不留 tmp，此处只断内容）。
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as { providers: { models: { contextWindow: number }[] }[] }
    expect(onDisk.providers[0]!.models[0]!.contextWindow).toBe(64000)

    // 运行时热重建：onConfigChanged 已整体替换 ctx.config——status_state 的 windowTokens
    // 取运行时 contextWindow（resolveCurrent(ctx.config)），必须反映新值而非启动旧值。
    post({ type: 'status_request' })
    await waitFor(events, (e) => e.type === 'status_state' && (e as StatusStateMsg).windowTokens === 64000, 'status_state(windowTokens=64000)')
  })

  it('busy 拦截：运行中 config_set → busy notice（channel=config）、无 config_updated、磁盘未变', async () => {
    const { client, releaseTurn } = hangingTurnAdapter()
    const { events, post, configPath } = makeAgent(client)
    // 起一轮慢轮次（chat 挂起）——gate busy。
    post({ type: 'submit', text: '慢轮次' })
    await waitFor(events, (e) => e.type === 'state' && (e as { to: string }).to !== 'idle', '轮次开始（离开 idle）')

    // 运行中发 config_set（值本身合法——证明拦截的是 busy gate 而非校验）。
    post({ type: 'config_set', path: 'defaultModel', value: 'm2' })
    const busy = await waitFor(events, (e) => e.type === 'notice' && (e as NoticeMsg).channel === 'config', 'busy notice')
    expect((busy as NoticeMsg).text).toBe('运行中，请稍候')

    // 无广播、无落盘：busy 路径在编辑之前就被拦截。
    expect(events.some((e) => e.type === 'config_updated')).toBe(false)
    expect(existsSync(configPath)).toBe(false)

    // 收尾：放行轮次（finished 后 gate 归还，自动标题走即答分支）。
    releaseTurn()
    await waitFor(events, (e) => e.type === 'finished', 'finished')
  })

  it('保存失败可见：save 抛错 → 「配置保存失败」notice（channel=config）、无 config_updated、运行时未切换', async () => {
    // save 抛错的 ConfigStore 子类——注入点取 ConfigController 构造 deps.configs（其依赖注入缝）：
    // 把 agent 内部 controller 依赖里的 ConfigStore 实例替换为抛错子类（实例替换 + 子类包装）。
    class ThrowingConfigStore extends ConfigStore {
      override save(): void {
        throw new Error('EACCES: 模拟磁盘写入失败')
      }
    }
    const { events, post, agent, configPath } = makeAgent(echoAdapter())
    const controller = (agent as unknown as { configController: ConfigController }).configController
    const deps = (controller as unknown as { deps: { configs: ConfigStore } }).deps
    deps.configs = new ThrowingConfigStore()

    post({ type: 'config_set', path: 'providers.0.models.0.contextWindow', value: 96000 })

    // notice：保存失败对用户可见（channel=config → WebUI 设置面板 inline 展示）。
    const failed = await waitFor(events, (e) => e.type === 'notice' && (e as NoticeMsg).channel === 'config' && (e as NoticeMsg).text.includes('配置保存失败'), '保存失败 notice')
    expect((failed as NoticeMsg).text).toContain('本次修改未生效')

    // 立法顺序（先落盘、再联动运行时、最后广播）的可观测后果：save 抛错 → onConfigChanged 未执行 →
    // 运行时联动广播（system_state / status_state / context_state，成功路径会由 onConfigChanged
    // 主动推送）全部缺席——这就是「运行时未切换」的可观测面（ctx.config 对象被编辑器原地共享改写，
    // 字段级旧值断言不可靠，不作断言）。
    expect(events.some((e) => e.type === 'config_updated')).toBe(false)
    expect(events.some((e) => e.type === 'system_state')).toBe(false)
    expect(events.some((e) => e.type === 'status_state')).toBe(false)
    expect(events.some((e) => e.type === 'context_state')).toBe(false)

    // 编辑器内存态保持编辑后值（controller 立法注释：后续编辑在其上继续，可再重试落盘）。
    post({ type: 'config_request' })
    const state = await waitFor(events, (e) => e.type === 'config_state', 'config_state')
    expect((state as ConfigStateMsg).config.providers[0]?.models[0]?.contextWindow).toBe(96000)

    // 磁盘上也从未写出新配置。
    expect(existsSync(configPath)).toBe(false)
  })

  it('回归守卫：contextWindow/maxOutput 交叉违规 → 编辑被拒 + lastGood 回滚 notice + 回滚快照广播、未落盘', async () => {
    const { events, post, configPath } = makeAgent(echoAdapter())
    // maxOutput 200000 > contextWindow 128000（zod superRefine 交叉校验）——编辑期就该被拒。
    post({ type: 'config_set', path: 'providers.0.models.0.maxOutput', value: 200000 })

    // notice：回滚文案来自 editor 的校验错误（「配置校验失败，已回滚：…」）。
    const rolled = await waitFor(events, (e) => e.type === 'notice' && (e as NoticeMsg).channel === 'config', '回滚 notice')
    expect((rolled as NoticeMsg).text).toContain('已回滚')
    expect((rolled as NoticeMsg).text).toContain('maxOutput')

    // 失败补发 config_updated（回滚后的 lastGood 快照）——WebUI 表单回到真实合法值，不残留用户非法输入。
    const updated = await waitFor(events, (e) => e.type === 'config_updated', 'config_updated（回滚快照）')
    const cfg = (updated as ConfigUpdatedMsg).config
    expect(cfg.providers[0]?.models[0]?.maxOutput).toBe(16384) // 启动加载的 zod 默认值
    expect(cfg.providers[0]?.models[0]?.contextWindow).toBe(128000)

    // 编辑被拒发生在落盘之前——磁盘从未写出。
    expect(existsSync(configPath)).toBe(false)
  })
})
