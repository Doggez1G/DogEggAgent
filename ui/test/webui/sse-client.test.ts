import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSseUiPort } from '../../src/webui/channel/sse-client'

// SSE 客户端测试：验证连接状态机与「断线重连感知」（onReconnect）。
// vitest 跑在 Node 环境（无 jsdom）——用最小 EventSource 桩替换全局，
// 只暴露被测代码用到的表面：onopen/onmessage/onerror 回调 + readyState + CLOSED 常量。

// 最小 EventSource 桩：构造时把实例交给外部（测试驱动回调）。
let lastInstance: FakeEventSource | null = null
class FakeEventSource {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  readyState = FakeEventSource.CONNECTING
  constructor() { lastInstance = this }
}

afterEach(() => {
  vi.unstubAllGlobals()
  lastInstance = null
})

// 装配：stub 全局 EventSource → 创建 port → 返回 port 与实例引用、状态收集器。
function setup() {
  vi.stubGlobal('EventSource', FakeEventSource)
  const states: string[] = []
  const port = createSseUiPort((s) => { states.push(s) })
  return { port, es: lastInstance!, states }
}

describe('createSseUiPort 连接状态与重连感知', () => {
  it('首连 onopen → connected，且不触发 onReconnect（不是重连）', () => {
    const { port, es, states } = setup()
    const onReconnect = vi.fn()
    port.setOnReconnect(onReconnect)

    es.onopen!()

    expect(states).toEqual(['connected'])
    expect(onReconnect).not.toHaveBeenCalled()
  })

  it('onerror（CONNECTING）→ 随后 onopen → connected 且触发 onReconnect', () => {
    const { port, es, states } = setup()
    const onReconnect = vi.fn()
    port.setOnReconnect(onReconnect)

    es.onerror!() // readyState 默认 CONNECTING——浏览器自动重连中
    // 初始状态即 'reconnecting'（setState 去重不重复推送），onerror 不产生新事件；
    es.onopen!()

    expect(states).toEqual(['connected'])
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('onerror（CLOSED）→ disconnected；之后重连成功同样触发 onReconnect', () => {
    const { port, es, states } = setup()
    const onReconnect = vi.fn()
    port.setOnReconnect(onReconnect)

    es.readyState = FakeEventSource.CLOSED
    es.onerror!()
    es.onopen!()

    expect(states).toEqual(['disconnected', 'connected'])
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('多次断线重连每次都触发 onReconnect（每次重连都要重新播种）', () => {
    const { port, es } = setup()
    const onReconnect = vi.fn()
    port.setOnReconnect(onReconnect)

    es.onopen!() // 首连
    es.onerror!(); es.onopen!()
    es.onerror!(); es.onopen!()

    expect(onReconnect).toHaveBeenCalledTimes(2)
  })

  it('onmessage 分发合法消息给 listener（回归：接线改动不破坏下行链路）', () => {
    const { port, es } = setup()
    const received: unknown[] = []
    port.onMessage((m) => { received.push(m) })

    es.onmessage!({ data: JSON.stringify({ type: 'finished' }) })

    expect(received).toEqual([{ type: 'finished' }])
  })
})
