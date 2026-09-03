// 统一 CLI 入口：dogegg → TUI，dogegg -web → WebUI。
// 全局安装后（npm install -g）在任意目录可执行，cwd 即为当前终端目录。
// 跨平台：Windows 上 npm 自动创建 .cmd 包装器；Linux/macOS 用 shebang。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { Agent, loadConfig, initLogger } from '@dogegg/agent'
import { createChannelPair } from '@dogegg/bridge'
import { renderTui } from '@dogegg/ui'
import { createSseChannel, startServer } from '@dogegg/server'

const args = process.argv.slice(2)
const isWeb = args.includes('-web') || args.includes('--web')

// 加载配置（找不到文件返回空配置，不抛错——让程序能启动、引导用户 /config）。
const config = loadConfig()
const logsDir = join(homedir(), '.dogegg', 'logs')

if (isWeb) {
  // ── WebUI 模式 ──
  // SSE 通道：agentPort 与 sseHandler/postHandler 对偶。
  const { agentPort, sseHandler, postHandler } = createSseChannel()
  initLogger(logsDir)
  // eslint-disable-next-line no-new
  new Agent(agentPort, config, process.cwd())

  // 静态资源目录：与 dist/dogegg.js 同级的 web/ 目录。
  const staticDir = join(import.meta.dirname, 'web')
  if (!existsSync(staticDir)) {
    console.error('WebUI assets not found at: ' + staticDir)
    console.error('Please run "npm run build:web" to build the WebUI frontend.')
    process.exit(1)
  }

  const port = Number(process.env.PORT) || 3000
  startServer({ sseHandler, postHandler, staticDir, port })
} else {
  // ── TUI 模式 ──
  // 同进程通道：agentPort 与 uiPort 对偶，同步投递。
  const { agentPort, uiPort } = createChannelPair()
  initLogger(logsDir)
  // eslint-disable-next-line no-new
  new Agent(agentPort, config, process.cwd())
  renderTui(uiPort)
}
