// WebUI 组合根：与 main.ts 并列。唯一 import agent + server（不 import ui——前端是静态文件被 serve）。
// 装配顺序：加载配置 → 创建 SSE 通道 → 构造 Agent（订阅 agentPort）→ 启动 HTTP server。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { Agent, ConfigStore, Logger } from '@dogegg/agent'
import { HttpServer, Router, SseChannel } from '@dogegg/server'

// 加载配置（找不到文件返回空配置，不抛错——让 server 能启动、引导用户 /config）。
const config = new ConfigStore().load()

// SSE 通道：本身就是 AgentPort——agent 与 HTTP 路由共享同一实例。
const channel = new SseChannel()

// 日志实例（~/.dogegg/logs/<session-id>.log）。
const logger = new Logger(join(homedir(), '.dogegg', 'logs'))

// 构造 Agent——它构造时自订阅 port 消息，后续一切由 port 驱动。
// eslint-disable-next-line no-new
new Agent(channel, config, process.cwd(), { logger })

// 启动 HTTP server。
// 开发模式（VITE_DEV=1）：staticDir=null，非 API 路径返回 404（前端由 Vite dev server 代理）。
// 生产模式：staticDir 指向 dist/web/，server serve 静态文件。
const isDev = process.env.VITE_DEV === '1'
const staticDir = isDev ? null : join(import.meta.dirname, 'web')
const port = Number(process.env.PORT) || 3000

new HttpServer({ router: new Router({ channel }), staticDir, port }).start()
