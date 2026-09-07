// 组合根：全项目唯一同时 import agent 与 ui 的地方。
// 装配顺序：加载配置 → 创建通道 → 构造 Agent（订阅 agentPort）→ 渲染 UI（持有 uiPort）。
// 这里的「对接知识」不归任何一包所有——放任何一包都会造成反向依赖。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { Agent, ConfigStore, Logger } from '@dogegg/agent'
import { InMemoryChannel } from '@dogegg/bridge'
import { renderTui } from '@dogegg/ui'

// 加载配置（找不到文件返回空配置，不抛错——让 TUI 能启动、引导用户 /config）。
const config = new ConfigStore().load()

// 同进程通道：agentPort 与 uiPort 对偶，同步投递（与旧 emit/send 时序一致）。
const channel = new InMemoryChannel()

// 日志实例（~/.dogegg/logs/<session-id>.log）。
const logger = new Logger(join(homedir(), '.dogegg', 'logs'))

// 构造 Agent——它构造时自订阅 port 消息，后续一切由 port 驱动。
// eslint-disable-next-line no-new
new Agent(channel.agentPort, config, process.cwd(), { logger })

// 渲染 TUI——uiPort 是 UI 的唯一消息通道，alt-screen 进出由 entry.tsx 管。
renderTui(channel.uiPort)
