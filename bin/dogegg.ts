// 统一 CLI 入口：dogegg → TUI，dogegg -web → WebUI。
// 全局安装后（npm install -g）在任意目录可执行，cwd 即为当前终端目录。
// 跨平台：Windows 上 npm 自动创建 .cmd 包装器；Linux/macOS 用 shebang。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { ZodError } from 'zod'
import { Agent, ConfigStore, ConfigParseError, Logger } from '@dogegg/agent'
import { InMemoryChannel } from '@dogegg/bridge'
import { renderTui } from '@dogegg/ui'
import { HttpServer, Router, SseChannel } from '@dogegg/server'

const args = process.argv.slice(2)
const isWeb = args.includes('-web') || args.includes('--web')

// SIGINT/SIGTERM 优雅退出（两个组合根同款接线：bin/dogegg.ts ↔ main-web.ts 逐字同源，改一处必改另一处）。
// 【立法】第二信号强制退出：exiting 置位后再次到达的信号说明用户「不想再等」——此时不再等
// dispose 收尾（内部虽有宽限定时器，理论上仍可能被单个收尾环节拖住），直接 exit(1) 兜底。
// dispose 自身幂等（agent.ts 的 disposed 标记：重复调用直接返回），信号连发不会重复取消/停服/
// 落盘——接线层的 exiting 只负责区分「首次（启动优雅收尾）」与「后续（强制退出）」两态。
// TUI 已知边界：ui 的 entry.tsx 另注册了自己的 SIGINT 兜底（双击强退）与 SIGTERM 裸退 handler，
// 注册晚于本接线——TUI 下收到 SIGTERM 时它的裸 exit(0) 会抢先终止进程，dispose 收尾不保证
// 完成（ui 包侧未收回该兜底，组合根不越权移除）；正常 Ctrl+C 在 raw mode 下由 Ink 的 useInput
// 捕获，不产生 SIGINT，本接线只在 Ink 之外卡死等兜底场景生效。
let exiting = false
function wireGracefulExit(agent: Agent): void {
  const onSignal = (): void => {
    if (exiting) {
      process.exit(1) // 第二信号：强制退出，不再等 dispose 收尾。
    }
    exiting = true
    agent.dispose().then(
      () => process.exit(0),
      () => process.exit(1), // dispose 自身抛错：尽力而为失败，也必须退出。
    )
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
}

// 加载配置（找不到文件返回空配置；存在但非法——如旧格式 permission——则给出人话提示后退出，
// 而不是裸抛 zod 堆栈）。错误信息必须可执行：指明待修文件、逐字段原因（带配置内路径）、
// 恢复方式、格式文档位置（本地实际存在的路径优先——在线文档可能尚未发布）。
// 与 main-web.ts 的 loadConfigOrExit 逐字同源（仅文档回退首候选路径不同：本文件产物在 dist/
// 下需上跳一级，main-web 在仓库根直接运行）——改一处必改另一处。
function loadConfigOrExit(): ReturnType<ConfigStore['load']> {
  const store = new ConfigStore()
  try {
    return store.load()
  } catch (err) {
    // 损坏 JSON → ConfigParseError（从 @dogegg/agent 导出，message 自带文件路径与
    // 「修复或删除该文件后重试」指引）。不覆写文件：配置是用户数据，损坏也不得自动重建吞掉。
    if (err instanceof ConfigParseError) {
      console.error(err.message)
      console.error('恢复方式：修复或删除该文件后重试。')
      process.exit(1)
    }
    const source = store.sourcePath()
    const issues = err instanceof ZodError
      ? err.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}：${i.message}` : i.message)).join('；')
      : String(err)
    console.error(`配置加载失败（文件：${source ?? '未找到'}）：${issues}`)
    console.error('恢复方式：把上述字段改写为当前格式 { "whole": boolean, "patterns": string[] }；或整段删除 "permission" 字段回退出厂默认，再经 /config 重新配置。')
    const doc = [
      join(import.meta.dirname, '../docs/versions/0.2/03-用户手册/01-配置指南.md'),
      join(process.cwd(), 'docs/versions/0.2/03-用户手册/01-配置指南.md'),
      join(process.cwd(), 'docs/config.md'),
    ].find((candidate: string) => existsSync(candidate))
    console.error(`配置格式说明：${doc ?? 'docs/versions/0.2/03-用户手册/01-配置指南.md（仓库内；在线版尚未发布）'}`)
    process.exit(1)
  }
}

const config = loadConfigOrExit()
const logger = new Logger(join(homedir(), '.dogegg', 'logs'))

if (isWeb) {
  // ── WebUI 模式 ──
  // SSE 通道：本身就是 AgentPort，agent 与 HTTP 路由共享同一实例。
  const channel = new SseChannel()
  const agent = new Agent(channel, config, process.cwd(), { logger })
  // 信号接线紧跟 Agent 创建：启动窗口期（建 server 前）的 Ctrl+C 也能走优雅收尾。
  wireGracefulExit(agent)
  // SSE 重连/刷新后前端没有后端事件重放，新连接必须重发会话快照——兑现 sse-client 注释承诺。
  // 【立法】恢复是新连接的私事，必须单播：send 由 SseChannel 闭包捕获发起连接构造，快照只写
  // 这一个连接。若走无参广播（resendSessionState() → post），任一标签重连都会把其它正在看的
  // 客户端聊天区整体重置（运行中的流式内容丢失），且 N 客户端一次重连退化为 O(N²) 消息。
  channel.onConnect = (send) => agent.resendSessionState(send)

  // 静态资源目录：与 dist/dogegg.js 同级的 web/ 目录。
  const staticDir = join(import.meta.dirname, 'web')
  if (!existsSync(staticDir)) {
    console.error('WebUI assets not found at: ' + staticDir)
    console.error('Please run "npm run build:web" to build the WebUI frontend.')
    process.exit(1)
  }

  const port = Number(process.env.PORT) || 3000
  new HttpServer({ router: new Router({ channel }), staticDir, port }).start()
} else {
  // ── TUI 模式 ──
  // 同进程通道：agentPort 与 uiPort 对偶，同步投递。
  const channel = new InMemoryChannel()
  const agent = new Agent(channel.agentPort, config, process.cwd(), { logger })
  // 信号接线先于 renderTui：本文件的 handler 必须注册在 ui entry.tsx 的兜底 handler 之前
  //（首信号启动 dispose，第二信号由本文件强制退出——共存关系见 wireGracefulExit 立法注释）。
  wireGracefulExit(agent)
  renderTui(channel.uiPort)
}
