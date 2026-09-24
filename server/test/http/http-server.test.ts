import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, it, expect, vi } from 'vitest'
import { HttpServer } from '../../src/http/http-server'
import type { Router } from '../../src/http/router'

// HttpServer 测试：
// 1. 本地来源校验（host/origin → 403）——直接驱动 dispatch（私有方法，测试里经类型断言调用），
//    用 mock req/res + 桩 Router，不建真 socket（确定性，不占端口）。
// 2. EADDRINUSE 兜底——真端口冲突（先占住端口再 start），验证人话提示 + process.exit(1)。

// 可记录状态的最小 ServerResponse 桩。
function makeRes() {
  const state = { statusCode: 0, body: '' }
  return {
    state,
    writeHead: (code: number) => { state.statusCode = code },
    setHeader: () => {},
    end: (body?: string) => { state.body = body ?? '' },
  }
}

// 桩 Router：记录是否被路由命中。
function makeRouter() {
  let handled = false
  return {
    router: { handle: async () => { handled = true; return true } } as unknown as Router,
    wasHandled: () => handled,
  }
}

// dispatch 是私有方法——测试经类型断言调用（TS private 仅编译期）。
// dispatch 内部有 await（router.handle），404 等后备响应落在 await 之后——必须 await 才能断言。
async function dispatch(srv: HttpServer, url: string, headers: Record<string, string>, method = 'GET'): Promise<ReturnType<typeof makeRes>> {
  const res = makeRes()
  const req = { url, method, headers } as unknown as IncomingMessage
  await (srv as unknown as { dispatch: (req: IncomingMessage, res: ServerResponse) => Promise<void> })
    .dispatch(req, res as unknown as ServerResponse)
  return res
}

describe('本地来源校验（/api/* 全部路由）', () => {
  it('Host 非本地 → 403，且不进路由（DNS rebinding 的 host 是攻击域名）', async () => {
    const { router, wasHandled } = makeRouter()
    const srv = new HttpServer({ router, staticDir: null, port: 3000 })

    const res = await dispatch(srv, '/api/fs?path=/', { host: 'evil.com' })

    expect(res.state.statusCode).toBe(403)
    expect(wasHandled()).toBe(false)
  })

  it('Host 为本地回环的子域形态（127.0.0.1.evil.com）→ 403（rebinding 变体）', async () => {
    const { router } = makeRouter()
    const srv = new HttpServer({ router, staticDir: null, port: 3000 })

    const res = await dispatch(srv, '/api/fs?path=/', { host: '127.0.0.1.evil.com' })

    expect(res.state.statusCode).toBe(403)
  })

  it('Host 本地但 Origin 非本地 → 403（跨站页面带 Origin 的 simple request）', async () => {
    const { router } = makeRouter()
    const srv = new HttpServer({ router, staticDir: null, port: 3000 })

    const res = await dispatch(srv, '/api/message', { host: '127.0.0.1:3000', origin: 'http://evil.com' }, 'POST')

    expect(res.state.statusCode).toBe(403)
  })

  it('Host 本地 + Origin 本地（Vite dev 代理场景 localhost:5173）→ 放行进路由', async () => {
    const { router, wasHandled } = makeRouter()
    const srv = new HttpServer({ router, staticDir: null, port: 3001 })

    const res = await dispatch(srv, '/api/message', { host: 'localhost:3001', origin: 'http://localhost:5173' }, 'POST')

    expect(res.state.statusCode).toBe(0) // 未被 403 拦截
    expect(wasHandled()).toBe(true)
  })

  it('Host 本地 + 无 Origin（curl / 部分同源 GET）→ 放行', async () => {
    const { router, wasHandled } = makeRouter()
    const srv = new HttpServer({ router, staticDir: null, port: 3000 })

    const res = await dispatch(srv, '/api/shells', { host: '127.0.0.1:3000' })

    expect(res.state.statusCode).toBe(0)
    expect(wasHandled()).toBe(true)
  })

  it('Host 为 IPv6 回环 [::1]:3000 → 放行', async () => {
    const { router, wasHandled } = makeRouter()
    const srv = new HttpServer({ router, staticDir: null, port: 3000 })

    const res = await dispatch(srv, '/api/shells', { host: '[::1]:3000' })

    expect(res.state.statusCode).toBe(0)
    expect(wasHandled()).toBe(true)
  })

  it('非 /api 路径不做来源校验（静态文件是公开资产）——evil host 的页面请求走到 404', async () => {
    const srv = new HttpServer({ router: { handle: async () => false } as unknown as Router, staticDir: null, port: 3000 })

    const res = await dispatch(srv, '/index.html', { host: 'evil.com' })

    expect(res.state.statusCode).toBe(404) // staticDir=null 的开发模式 fallback
  })

  it('OPTIONS 预检同样过来源校验：非本地 → 403', async () => {
    const srv = new HttpServer({ router: makeRouter().router, staticDir: null, port: 3000 })

    const res = await dispatch(srv, '/api/message', { host: 'evil.com', origin: 'http://evil.com' }, 'OPTIONS')

    expect(res.state.statusCode).toBe(403)
  })
})

describe('EADDRINUSE 兜底', () => {
  it('端口被占用 → 打印中文提示（含端口与 PORT 指引）后 process.exit(1)', async () => {
    // 先真实占住一个端口（listen(0) 由 OS 分配空闲端口，再让 HttpServer 抢同一个）。
    const occupier = createServer()
    await new Promise<void>((resolve) => occupier.listen(0, '127.0.0.1', () => resolve()))
    const port = (occupier.address() as { port: number }).port

    // mock process.exit——否则测试进程真被杀掉；错误提示也用 spy 收集而非污染输出。
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      new HttpServer({ router: makeRouter().router, staticDir: null, port }).start()
      // 'error' 事件异步到达（Windows 上 EADDRINUSE 几乎立即触发）。
      await new Promise((resolve) => setTimeout(resolve, 300))

      expect(exitSpy).toHaveBeenCalledWith(1)
      const messages = errorSpy.mock.calls.map((c) => c.map(String).join(' '))
      expect(messages.some((m) => m.includes('端口') && m.includes(String(port)))).toBe(true)
      expect(messages.some((m) => m.includes('PORT'))).toBe(true)
    } finally {
      errorSpy.mockRestore()
      exitSpy.mockRestore()
      await new Promise<void>((resolve) => occupier.close(() => resolve()))
    }
  }, 5000)
})
