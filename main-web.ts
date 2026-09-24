// WebUI 组合根：与 main.ts 并列。唯一 import agent + server（不 import ui——前端是静态文件被 serve）。
// 装配顺序：加载配置 → 创建 SSE 通道 → 构造 Agent（订阅 agentPort）→ 启动 HTTP server。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { ZodError } from 'zod'
import { Agent, ConfigStore, Logger } from '@dogegg/agent'
import { HttpServer, Router, SseChannel } from '@dogegg/server'

// 加载配置（找不到文件返回空配置；存在但非法则给出人话提示后退出，与 bin/dogegg.ts 同一策略）。
function loadConfigOrExit(): ReturnType<ConfigStore['load']> {
  try {
    return new ConfigStore().load()
  } catch (err) {
    const detail = err instanceof ZodError ? err.issues.map((i) => i.message).join('；') : String(err)
    console.error(`配置加载失败：${detail}`)
    console.error('配置怎么写：https://github.com/Doggez1G/DogEggAgent/blob/main/docs/config.md（与你的 dogegg-agent 版本对应）')
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

// SSE 重连/刷新后前端没有后端事件重放，新连接必须重发会话快照——兑现 sse-client 注释承诺。
// （客户端侧另有断线重连后的播种请求补发，见 ui/src/webui/app/app.tsx，两者互补。）
channel.onConnect = () => agent.resendSessionState()

// 启动 HTTP server。
// 开发模式（VITE_DEV=1）：staticDir=null，非 API 路径返回 404（前端由 Vite dev server 代理）。
// 生产模式：staticDir 指向 dist/web/，server serve 静态文件。
const isDev = process.env.VITE_DEV === '1'
const staticDir = isDev ? null : join(import.meta.dirname, 'web')
const port = Number(process.env.PORT) || 3000

new HttpServer({ router: new Router({ channel }), staticDir, port }).start()
