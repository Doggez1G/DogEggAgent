import React from 'react'
import { render } from 'ink'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Agent } from '../agent/index'
import { loadConfig } from '../config/loader'
import { initLogger } from '../common/utils/logger'
import { App } from '../ui/tui/index'

// 组合根：装配 agent + ui，把事件/命令在 App 里通过 agent.on / agent.send 对接。
export function bootstrap(): void {
  const config = loadConfig()
  initLogger(join(homedir(), '.dogegg', 'logs', 'latest.log'))
  const agent = new Agent(config, process.cwd())

  // 进入备用屏幕（full-screen 应用模式）。否则 Ink 每帧写 stdout 会污染终端滚动条，流式输出时滚动会跳回开头。
  process.stdout.write('\x1b[?1049h')
  const leaveAlt = () => process.stdout.write('\x1b[?1049l')
  process.on('exit', leaveAlt)

  render(React.createElement(App, { agent }))
}