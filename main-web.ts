// WebUI 组合根：与 main.ts 并列。唯一 import agent + server（不 import ui——前端是静态文件被 serve）。
// 装配顺序：加载配置 → 创建 SSE 通道 → 构造 Agent（订阅 agentPort）→ 启动 HTTP server。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { ZodError } from 'zod'
import { Agent, ConfigStore, ConfigParseError, Logger } from '@dogegg/agent'
import { HttpServer, Router, SseChannel } from '@dogegg/server'

// SIGINT/SIGTERM 优雅退出——与 bin/dogegg.ts 的 wireGracefulExit 逐字同源（两个组合根是独立
// 文件、不允许抽共享模块；改一处必改另一处）。立法注释见 bin/dogegg.ts 同名函数。
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

// 加载配置——与 bin/dogegg.ts 的 loadConfigOrExit 逐字同源（仅文档回退首候选路径不同：bin
// 产物在 dist/ 下需上跳一级，本文件在仓库根直接运行）。立法注释见 bin/dogegg.ts 同名函数。
function loadConfigOrExit(): ReturnType<ConfigStore['load']> {
  const store = new ConfigStore()
  try {
    return store.load()
  } catch (err) {
    // 损坏 JSON → ConfigParseError（从 @dogegg/agent 导出，message 自带文件路径与恢复指引）。
    // 不覆写文件：配置是用户数据，损坏也不得自动重建吞掉。
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
      join(import.meta.dirname, 'docs/versions/0.2/03-用户手册/01-配置指南.md'),
      join(process.cwd(), 'docs/versions/0.2/03-用户手册/01-配置指南.md'),
      join(process.cwd(), 'docs/config.md'),
    ].find((candidate: string) => existsSync(candidate))
    console.error(`配置格式说明：${doc ?? 'docs/versions/0.2/03-用户手册/01-配置指南.md（仓库内；在线版尚未发布）'}`)
    process.exit(1)
  }
}

const config = loadConfigOrExit()

// SSE 通道：本身就是 AgentPort——agent 与 HTTP 路由共享同一实例。
const channel = new SseChannel()

// 日志实例（~/.dogegg/logs/<session-id>.log）。
const logger = new Logger(join(homedir(), '.dogegg', 'logs'))

// 构造 Agent——它构造时自订阅 port 消息，后续一切由 port 驱动。
const agent = new Agent(channel, config, process.cwd(), { logger })
// 信号接线紧跟 Agent 创建：启动窗口期（建 server 前）的 Ctrl+C 也能走优雅收尾。
wireGracefulExit(agent)

// SSE 重连/刷新后前端没有后端事件重放，新连接必须重发会话快照——兑现 sse-client 注释承诺。
// （客户端侧另有断线重连后的播种请求补发，见 ui/src/webui/app/app.tsx，两者互补。）
// 【立法】恢复是新连接的私事，必须单播：send 由 SseChannel 闭包捕获发起连接构造，快照只写
// 这一个连接。若走无参广播（resendSessionState() → post），任一标签重连都会把其它正在看的
// 客户端聊天区整体重置（运行中的流式内容丢失），且 N 客户端一次重连退化为 O(N²) 消息。
channel.onConnect = (send) => agent.resendSessionState(send)

// 启动 HTTP server。
// 开发模式（VITE_DEV=1）：staticDir=null，非 API 路径返回 404（前端由 Vite dev server 代理）。
// 生产模式：staticDir 指向 dist/web/，server serve 静态文件。
const isDev = process.env.VITE_DEV === '1'
const staticDir: string | null = isDev ? null : join(import.meta.dirname, 'web')
// 静态资源检查——与 bin/dogegg.ts 的 -web 分支同款（目录缺失即提示后退出，不白启动一个只有
// API 的半残服务）。staticDir 为 null 即开发模式（两者由上面的三元绑定），跳过检查。
if (staticDir !== null && !existsSync(staticDir)) {
  console.error(`WebUI 前端尚未构建（目录缺失：${staticDir}），请先运行 npm run build:web`)
  process.exit(1)
}
const port = Number(process.env.PORT) || 3000

new HttpServer({ router: new Router({ channel }), staticDir, port }).start()
