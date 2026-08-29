// WebUI 组合根：与 main.ts 并列。唯一 import agent + server（不 import ui——前端是静态文件被 serve）。
// 装配顺序：加载配置 → 创建 SSE 通道 → 构造 Agent（订阅 agentPort）→ 启动 HTTP server（持 sseHandler/postHandler）。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { Agent, loadConfig, initLogger } from '@dogegg/agent'
import { createSseChannel, startServer } from '@dogegg/server'

// 加载配置（找不到文件返回空配置，不抛错——让 server 能启动、引导用户 /config）。
const config = loadConfig()

// SSE 通道：agentPort 与 uiPort 对偶，agent 侧持有 agentPort，server 侧持有 sseHandler/postHandler。
const { agentPort, sseHandler, postHandler } = createSseChannel()

// 初始化调试日志目录（~/.dogegg/logs/<session-id>.log）。
initLogger(join(homedir(), '.dogegg', 'logs'))

// 构造 Agent——它构造时自订阅 port 消息，后续一切由 port 驱动。
// eslint-disable-next-line no-new
new Agent(agentPort, config, process.cwd())

// 启动 HTTP server。
// 开发模式（VITE_DEV=1）：staticDir=null，非 API 路径返回 404（前端由 Vite dev server 代理）。
// 生产模式：staticDir 指向 dist/web/，server serve 静态文件。
const isDev = process.env.VITE_DEV === '1'
const staticDir = isDev ? null : join(import.meta.dirname, 'web')
const port = Number(process.env.PORT) || 3000

startServer({ sseHandler, postHandler, staticDir, port })
