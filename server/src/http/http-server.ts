import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Router } from './router'
import { StaticFiles } from './static-files'

// HTTP server：创建 node:http server，请求先匹配 API 路由，未匹配则 serve 静态文件。
// 默认绑定 127.0.0.1（仅本地访问）。HOST 仅支持回环地址（127.0.0.1/[::1]）——非回环部署
// 不做承诺：下方来源校验立法要求服务端自证请求来自本机，非回环 Host 的 /api/* 一律 403
//（fail-closed 保留）。理由：CORS 挡不住 no-cors fetch / 表单 POST 的写入，也挡不住
// DNS rebinding（攻击域名解析到 127.0.0.1，请求看似同源实则外来）；一旦放宽 host 白名单
//「部署到内网」，API（驱动 shell 执行、读任意文件）即暴露给内网任意主机——这不是本 server
// 支持的场景。CORS 限制为 localhost——但 CORS 只挡得住「浏览器愿意检查的跨站读」，见下方立法注释。
// staticDir 为 null 时（开发模式），非 API 路径返回 404——前端由 Vite dev server 代理。
// staticDir 非 null 时（生产模式），非 API 路径 serve 静态文件。
export class HttpServer {
  private readonly staticFiles: StaticFiles | null

  constructor(private readonly opts: {
    router: Router
    staticDir: string | null
    port: number
  }) {
    this.staticFiles = opts.staticDir ? new StaticFiles(opts.staticDir) : null
  }

  // 创建并启动 server；进程存活期间持续监听（与旧 startServer 行为一致）。
  start(): void {
    const server = createServer((req, res) => {
      this.dispatch(req, res).catch((e) => {
        console.error('Request handler error:', e)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end('Internal Server Error')
        }
      })
    })
    const host = process.env.HOST ?? '127.0.0.1'
    // listen 失败（端口被占用等）不会抛异常——只发 'error' 事件；不监听则进程带着
    // EADDRINUSE 原始堆栈裸崩。这里统一兜底：EADDRINUSE 给出人话恢复指引，其它错误原样打印。
    server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        console.error(`端口 ${this.opts.port} 已被占用，WebUI server 无法启动。`)
        console.error(`恢复方式：换一个端口（设置 PORT 环境变量，如 PORT=${this.opts.port + 1}）后重试；或结束占用该端口的其它进程。`)
      } else {
        console.error('WebUI server error:', e)
      }
      process.exit(1)
    })
    server.listen(this.opts.port, host, () => {
      const mode = this.staticFiles ? 'production' : 'development'
      console.log(`🐶 DogEggAgent WebUI server (${mode}) listening on http://${host}:${this.opts.port}`)
    })
  }

  // 请求分发：API 路由先过本地来源校验 → CORS → API 路由 → 静态文件（或 404）。
  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const origin = req.headers.origin
    const allowedOrigin = this.isLocalhostOrigin(typeof origin === 'string' ? origin : undefined) ? origin : undefined

    // ── 本地来源校验（立法）──
    // CORS 只能挡「浏览器愿意检查的跨站请求」：no-cors fetch 与表单 POST 属于 simple
    // request，浏览器照常发出（只是不把响应暴露给攻击页面），CORS 响应头完全拦不住写入；
    // DNS rebinding 更能把攻击域名的解析指到 127.0.0.1，请求看似同源实则外来。
    // 因此服务端必须自证请求来自本机：host 头与 origin 头（若存在）的 hostname 都必须是
    // 本地回环，否则对 /api/* 全部路由（含 GET /api/fs、/api/shells——防 rebinding 回读）
    // 一律 403。content-type 校验（见 postHandler）是 simple request 无法伪造的第二道防线。
    // 静态文件是公开资产，无需校验。
    if (url.pathname.startsWith('/api/') && !this.isLocalRequest(req.headers.host, origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('Forbidden: API only serves local requests')
      return
    }

    // CORS 预检：仅允许 localhost 来源（防止跨站驱动 shell 执行）。
    if (req.method === 'OPTIONS') {
      const headers: Record<string, string> = {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin',
      }
      if (allowedOrigin) {
        headers['Access-Control-Allow-Origin'] = allowedOrigin
      }
      res.writeHead(204, headers)
      res.end()
      return
    }

    // 为非 OPTIONS 请求设置 CORS header（仅允许 localhost 来源）。
    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
      res.setHeader('Vary', 'Origin')
    }

    // API 路由匹配；未命中则静态文件（生产模式）或 404。
    if (await this.opts.router.handle(req, res, url)) return
    if (this.staticFiles) {
      await this.staticFiles.serve(res, url)
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  }

  // 检查 Origin header 是否为允许的 localhost 来源（用于 CORS 头；强制校验见 isLocalRequest）。
  private isLocalhostOrigin(origin: string | undefined): boolean {
    return this.isLocalHostname(this.urlHostname(origin))
  }

  // 判断 host 头 + origin 头是否都来自本机：host 必须存在且为本地回环
  //（DNS rebinding 的请求 host 是攻击域名，在此被拒）；origin 浏览器跨站请求必带，
  // 存在时同样必须本地——不存在（curl / 部分同源 GET）不连带拒绝。
  private isLocalRequest(host: unknown, origin: unknown): boolean {
    if (!this.isLocalHostname(this.urlHostname(typeof host === 'string' ? host : undefined))) return false
    const rawOrigin = typeof origin === 'string' && origin !== '' ? origin : undefined
    if (rawOrigin && !this.isLocalHostname(this.urlHostname(rawOrigin))) return false
    return true
  }

  // 从完整 URL（origin 头）或 authority（host 头，补 http:// 前缀）提取 hostname——
  // 借 WHATWG URL 解析剥端口（IPv6 的 hostname 保留方括号，如 '[::1]'），并把结果小写化；
  // 解析失败返回 null（视为不本地）。
  private urlHostname(raw: string | undefined): string | null {
    if (!raw) return null
    try {
      return new URL(raw.includes('://') ? raw : `http://${raw}`).hostname
    } catch {
      return null
    }
  }

  // hostname 是否本地回环：localhost / 127.0.0.1 / [::1]（URL 解析已把 hostname 小写）。
  private isLocalHostname(hostname: string | null): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  }
}
