// 统一 CLI 入口：dogegg → TUI，dogegg -web → WebUI。
// 全局安装后（npm install -g）在任意目录可执行，cwd 即为当前终端目录。
// 跨平台：Windows 上 npm 自动创建 .cmd 包装器；Linux/macOS 用 shebang。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { ZodError } from 'zod'
import { Agent, ConfigStore, Logger } from '@dogegg/agent'
import { InMemoryChannel } from '@dogegg/bridge'
import { renderTui } from '@dogegg/ui'
import { HttpServer, Router, SseChannel } from '@dogegg/server'

const args = process.argv.slice(2)
const isWeb = args.includes('-web') || args.includes('--web')

// 加载配置（找不到文件返回空配置；存在但非法——如旧格式 permission——则给出人话提示后退出，
// 而不是裸抛 zod 堆栈）。错误信息必须可执行：指明待修文件、逐字段原因（带配置内路径）、
// 恢复方式、格式文档位置（本地实际存在的路径优先——在线文档可能尚未发布）。
function loadConfigOrExit(): ReturnType<ConfigStore['load']> {
  const store = new ConfigStore()
  try {
    return store.load()
  } catch (err) {
    const source = store.sourcePath()
    const issues = err instanceof ZodError
      ? err.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}：${i.message}` : i.message)).join('；')
      : String(err)
    console.error(`配置加载失败（文件：${source ?? '未找到'}）：${issues}`)
    console.error('恢复方式：把上述字段改写为当前格式 { "whole": boolean, "patterns": string[] }；或整段删除 "permission" 字段回退出厂默认，再经 /config 重新配置。')
    const doc = [join(import.meta.dirname, '../docs/config.md'), join(process.cwd(), 'docs/config.md')]
      .find((p) => existsSync(p))
    console.error(`配置格式说明：${doc ?? 'docs/config.md（DogEggAgent 仓库内；在线版尚未发布）'}`)
    process.exit(1)
  }
}

const config = loadConfigOrExit()
const logger = new Logger(join(homedir(), '.dogegg', 'logs'))

if (isWeb) {
  // ── WebUI 模式 ──
  // SSE 通道：本身就是 AgentPort，agent 与 HTTP 路由共享同一实例。
  const channel = new SseChannel()
  // eslint-disable-next-line no-new
  new Agent(channel, config, process.cwd(), { logger })

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
  // eslint-disable-next-line no-new
  new Agent(channel.agentPort, config, process.cwd(), { logger })
  renderTui(channel.uiPort)
}
