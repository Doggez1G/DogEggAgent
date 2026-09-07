import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Router } from './router'
import { StaticFiles } from './static-files'

// HTTP server：创建 node:http server，请求先匹配 API 路由，未匹配则 serve 静态文件。
// 默认绑定 127.0.0.1（仅本地访问），可通过 HOST 环境变量覆盖（如部署到内网）。
// CORS 限制为 localhost——防止其他网站跨站 POST 驱动 shell 执行。
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
    server.listen(this.opts.port, host, () => {
      const mode = this.staticFiles ? 'production' : 'development'
      console.log(`🐶 DogEggAgent WebUI server (${mode}) listening on http://${host}:${this.opts.port}`)
    })
  }

  // 请求分发：CORS → API 路由 → 静态文件（或 404）。
  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const origin = req.headers.origin
    const allowedOrigin = this.isLocalhostOrigin(typeof origin === 'string' ? origin : undefined) ? origin : undefined

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

  // 检查 Origin header 是否为允许的 localhost 来源。
  private isLocalhostOrigin(origin: string | undefined): boolean {
    if (!origin) return false
    try {
      const url = new URL(origin)
      return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
    } catch {
      return false
    }
  }
}
